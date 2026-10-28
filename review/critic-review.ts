import fs from 'node:fs';
import path from 'node:path';
import { hasHostProfile, loadHostProfile } from '../host/host-profile.ts';
import { sha256, type CriticReviewRecord } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { verifyFindings, type CitationFindingLike } from './citation-verifier.ts';
import { canonicalizeAuthorVendors, type CanonicalAuthorVendor } from './author-vendor.ts';
import {
	CRITIC_FINDINGS_SCHEMA, buildPhasePrompt, estimateCriticPromptTokens, truncatePromptToTokenCeiling, type TouchedFileEntry,
} from './critic-prompt.ts';
import { persistCriticReview } from './critic-report-store.ts';

export interface CriticFinding extends CitationFindingLike {
	severity: string; category: string; file: string; lineRange?: string; evidence?: string; impact?: string; remediation?: string;
}

export interface QaCoverageMatrix<T = CriticFinding> {
	covered: readonly string[]; gap: readonly T[]; divergent: readonly T[]; overspec: readonly T[];
}

export interface CriticGovernorResult {
	output?: unknown; operationId?: string; usageRecordIds?: readonly string[]; model?: string;
	route?: { routeId?: string; provider?: string; model?: string; canonicalVendor?: string } | null;
}

export interface CriticGovernorLike {
	synthetic?: boolean;
	getRunOperations?(runId: string): Record<string, unknown>;
	execute(request: Record<string, unknown>): Promise<CriticGovernorResult>;
}

export interface CriticRuntimeStoreLike {
	listCriticReviews(runId: string): readonly { phase: string; generation?: number }[];
	saveCriticReview(record: Readonly<CriticReviewRecord>): unknown;
}

export interface SemanticRepairOutcome {
	kind?: string; reason?: string | null; [key: string]: unknown;
}

export interface CriticReviewPortLike {
	requestSemanticRepair(
		runId: string, generation: number, reportHash: string, p1Files: string[], scope: string | readonly string[],
	): Promise<SemanticRepairOutcome | null | undefined>;
}

export interface ExecuteCriticReviewInput {
	runId: string; taskId?: string; generation?: number; phase?: string; scope?: string | readonly string[];
	authorVendor?: unknown; authorVendors?: readonly unknown[] | null; promptPolicy?: string; specSummary?: string;
	acceptanceCriteria?: readonly string[]; diff?: string; touchedFiles?: readonly TouchedFileEntry[];
	testOutput?: string; documentText?: string; rubric?: string; preferredRouteIds?: readonly string[];
	requestedLimits?: { maxPromptTokens?: number; [key: string]: unknown }; artifactHash?: string | null; attemptKey?: string | null;
	groundingRootDir?: string | null;
}

export interface CriticReviewExecutionResult {
	reviewId: string; runId: string; generation: number; phase: string; status: 'PASS' | 'FAIL'; hasP1: boolean;
	findings: readonly Readonly<CriticFinding>[]; findingsCount: number; ungroundedFindings: readonly Readonly<CriticFinding>[];
	coverageMatrix: QaCoverageMatrix<CriticFinding> | null; reportPath: string; manifestPath: string;
	authorVendors: readonly CanonicalAuthorVendor[]; reviewerVendor: string; reviewerModel: string;
	artifactHash: string; attemptKey: string; operationId: string; usageRecordIds: readonly string[];
	repairOutcome: SemanticRepairOutcome | null; circuitBreakerTripped: boolean; circuitBreakerReason: string | null;
}

export function computeScopeDigest(scope: unknown): string {
	const canonical = Array.isArray(scope) ? [...scope].sort().join('\n') : String(scope ?? '');
	return sha256(canonical).slice(0, 32);
}

export function buildCriticOperationId(opts: {
	runId: string;
	phase: string;
	scopeDigest: string;
	generation: number;
}): string {
	return `${opts.runId}:critic:${opts.phase}:${opts.scopeDigest}:g${opts.generation}`;
}

export function processQaFindings<T extends CitationFindingLike = CriticFinding>({
	rawFindings = [],
	acceptanceCriteria = [],
}: {
	rawFindings?: readonly T[];
	acceptanceCriteria?: readonly string[];
} = {}): { findings: readonly T[]; coverageMatrix: QaCoverageMatrix<T> } {
	const raw = Array.isArray(rawFindings) ? rawFindings : [];
	const coveredAcIds = new Set<string>();
	const gapMap = new Map<string, T>();
	const divergentMap = new Map<string, T>();
	const overspecFindings: T[] = [];

	const approvedAcIds: string[] = [];
	for (const ac of acceptanceCriteria) {
		const m = String(ac).match(/\b(AC-\d{2,})\b/i);
		if (m && m[1]) approvedAcIds.push(m[1].toUpperCase());
	}

	for (const finding of raw) {
		const evidence = String(finding.evidence ?? '').trim();
		const acMatch = evidence.match(/\b(AC-\d{2,})\b/i);
		const acId = acMatch && acMatch[1] ? acMatch[1].toUpperCase() : null;

		if (evidence.startsWith('COVERED')) {
			if (acId) coveredAcIds.add(acId);
			continue;
		}
		if (evidence.startsWith('DIVERGENT')) {
			const key = acId || `divergent-${divergentMap.size}`;
			if (!divergentMap.has(key)) divergentMap.set(key, finding);
			continue;
		}
		if (evidence.startsWith('GAP')) {
			const key = acId || `gap-${gapMap.size}`;
			if (!gapMap.has(key)) gapMap.set(key, finding);
			continue;
		}
		if (evidence.startsWith('OVERSPEC')) {
			if (overspecFindings.length < 10) overspecFindings.push(finding);
			continue;
		}
		if (acId) {
			if (finding.severity === 'P1') {
				if (!divergentMap.has(acId)) divergentMap.set(acId, finding);
			} else if (!gapMap.has(acId)) {
				gapMap.set(acId, finding);
			}
		} else if (overspecFindings.length < 10) {
			overspecFindings.push(finding);
		}
	}

	for (const acId of divergentMap.keys()) gapMap.delete(acId);
	for (const id of approvedAcIds) {
		if (!gapMap.has(id) && !divergentMap.has(id)) coveredAcIds.add(id);
	}

	const filteredFindings: T[] = [...divergentMap.values(), ...gapMap.values(), ...overspecFindings];
	const coverageMatrix: QaCoverageMatrix<T> = Object.freeze({
		covered: Object.freeze([...coveredAcIds].sort()),
		gap: Object.freeze([...gapMap.values()]),
		divergent: Object.freeze([...divergentMap.values()]),
		overspec: Object.freeze([...overspecFindings]),
	});
	return { findings: Object.freeze(filteredFindings), coverageMatrix };
}

function opState(op: unknown): string {
	return op && typeof op === 'object' && 'state' in op && typeof op.state === 'string' ? op.state : '';
}

export class CriticReviewAdapter {
	rootDir: string;
	governor: CriticGovernorLike | undefined;
	runtimeStore: CriticRuntimeStoreLike | undefined;
	reviewPort: CriticReviewPortLike | undefined;
	reviewBaseDir: string;

	constructor({
		rootDir,
		governor,
		runtimeStore,
		reviewPort,
		reviewBaseDir,
	}: {
		rootDir?: string;
		governor?: CriticGovernorLike;
		runtimeStore?: CriticRuntimeStoreLike;
		reviewPort?: CriticReviewPortLike;
		reviewBaseDir?: string;
	} = {}) {
		this.rootDir = rootDir ?? REPOSITORY_ROOT;
		this.governor = governor;
		this.runtimeStore = runtimeStore;
		this.reviewPort = reviewPort;
		this.reviewBaseDir =
			reviewBaseDir ??
			(hasHostProfile(this.rootDir)
				? path.join(this.rootDir, loadHostProfile(this.rootDir).reviewDir)
				: path.join(this.rootDir, 'tools/.review'));
	}

	getRunOperations(runId: string): Record<string, unknown> {
		if (typeof this.governor?.getRunOperations === 'function') {
			try {
				const ops = this.governor.getRunOperations(runId);
				if (ops && typeof ops === 'object') return ops;
			} catch {
				// fallback to filesystem
			}
		}
		const ledgerPath = path.join(this.rootDir, 'tools/.model-usage/runs', `${runId}.json`);
		if (!fs.existsSync(ledgerPath)) return {};
		try {
			const raw: unknown = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
			if (raw && typeof raw === 'object' && 'operations' in raw && raw.operations && typeof raw.operations === 'object') {
				return raw.operations as Record<string, unknown>;
			}
			return {};
		} catch {
			return {};
		}
	}

	resolveEffectiveGeneration(opts: {
		runId: string;
		phase: string;
		scopeDigest: string;
		generation?: number;
	}): number {
		const { runId, phase, scopeDigest, generation = 0 } = opts;
		let maxGen = generation;
		if (this.runtimeStore) {
			try {
				for (const review of this.runtimeStore.listCriticReviews(runId).filter((r) => r.phase === phase)) {
					if (typeof review.generation === 'number' && Number.isSafeInteger(review.generation)) {
						maxGen = Math.max(maxGen, review.generation + 1);
					}
				}
			} catch {
				// runtimeStore check is best-effort
			}
		}
		const operations = this.getRunOperations(runId);
		const prefix = `${runId}:critic:${phase}:`;
		for (const [opId, op] of Object.entries(operations)) {
			if (opId.startsWith(prefix)) {
				const match = opId.match(/:g(\d+)$/);
				if (match && match[1]) {
					const genNum = parseInt(match[1], 10);
					if (Number.isSafeInteger(genNum) && ['failed', 'recovery_charged'].includes(opState(op))) {
						maxGen = Math.max(maxGen, genNum + 1);
					}
				}
			}
		}
		while (
			operations[`${runId}:critic:${phase}:${scopeDigest}:g${maxGen}`] &&
			['failed', 'recovery_charged'].includes(opState(operations[`${runId}:critic:${phase}:${scopeDigest}:g${maxGen}`]))
		) {
			maxGen += 1;
		}
		return maxGen;
	}

	async executeReview(input: ExecuteCriticReviewInput): Promise<Readonly<CriticReviewExecutionResult>> {
		const {
			runId,
			taskId,
			generation = 0,
			phase = 'code',
			scope = '',
			authorVendor,
			authorVendors,
			promptPolicy = '',
			specSummary = '',
			acceptanceCriteria = [],
			diff = '',
			touchedFiles = [],
			testOutput = '',
			documentText = '',
			rubric = '',
			preferredRouteIds = [],
			requestedLimits,
			artifactHash,
			attemptKey,
			groundingRootDir,
		} = input;
		const canonicalAuthors = canonicalizeAuthorVendors({ authorVendor, authorVendors });
		if (!['spec', 'plan', 'code', 'qa'].includes(phase)) {
			throw new SdlcError('INVALID_CONTRACT', `Invalid critic review phase: '${phase}'`);
		}

		const scopeDigest = computeScopeDigest(scope);
		const effectiveGeneration = this.resolveEffectiveGeneration({ runId, phase, scopeDigest, generation });
		const operationId = buildCriticOperationId({ runId, phase, scopeDigest, generation: effectiveGeneration });
		const resolvedArtifactHash =
			typeof artifactHash === 'string' && /^[a-f0-9]{64}$/.test(artifactHash)
				? artifactHash
				: sha256(`${runId}:${phase}:${effectiveGeneration}:${scopeDigest}`);
		const resolvedAttemptKey =
			typeof attemptKey === 'string' && attemptKey.trim().length > 0
				? attemptKey.trim()
				: `${phase}:${runId}:g${effectiveGeneration}`;

		const prompt = buildPhasePrompt({
			rootDir: this.rootDir,
			phase,
			promptPolicy,
			specSummary,
			acceptanceCriteria,
			diff,
			touchedFiles,
			testOutput,
			documentText,
			rubric,
		});

		const routingConstraints = {
			excludedVendors: [...canonicalAuthors],
			requiredCapabilities: ['structured-output'],
			strategy: 'quality-first',
			minQualityTier: 3,
			...(Array.isArray(preferredRouteIds) && preferredRouteIds.length > 0 ? { preferredRouteIds: [...preferredRouteIds] } : {}),
		};

		const targetCeiling = Math.min(requestedLimits?.maxPromptTokens ?? 20000, 20000) - 200;
		const activePrompt = truncatePromptToTokenCeiling(prompt, estimateCriticPromptTokens, targetCeiling);
		const resolvedTaskId = taskId ?? sha256(runId).slice(0, 24);
		const scopeStr = (Array.isArray(scope) ? scope.join(',') : String(scope ?? '')).trim();
		const request = {
			schemaVersion: '1.0.0',
			operationId,
			runId,
			consumer: 'agent-sdlc',
			profile: 'critic-review',
			attribution: {
				taskId: resolvedTaskId,
				nodeId: 'critic_review',
				roleId: 'critic-reviewer',
				generation: effectiveGeneration,
				nodeAttempt: 1,
				phase,
				...(scopeStr.length > 0 ? { scope: scopeStr } : {}),
			},
			prompt: activePrompt,
			structuredOutputSchema: CRITIC_FINDINGS_SCHEMA,
			routingConstraints,
			...(requestedLimits ? { requestedLimits } : {}),
		};

		let result: CriticGovernorResult;
		try {
			if (!this.governor) throw new Error('Governor is not configured');
			result = await this.governor.execute(request);
		} catch (error: unknown) {
			const errObj = error && typeof error === 'object' ? (error as { code?: unknown; message?: unknown; metadata?: unknown }) : {};
			if (errObj.code === 'GOVERNOR_ROUTES_EXHAUSTED') throw error;
			const errMessage = typeof errObj.message === 'string' ? errObj.message : '';
			if (errObj.code === 'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED' || errMessage.includes('No allowed governed model route completed')) {
				throw new SdlcError('GOVERNOR_ROUTES_EXHAUSTED', 'No allowed governed model route completed', errObj.metadata, { cause: error });
			}
			if (error instanceof SdlcError) throw error;
			throw new SdlcError('CRITIC_REVIEW_FAILED', `Governor execution failed: ${errMessage || String(error)}`, {}, { cause: error });
		}

		const reviewerVendor = result.route?.canonicalVendor;
		const reviewerModel = result.route?.model ?? result.model ?? 'unknown';
		if (!reviewerVendor || reviewerVendor === 'unknown') {
			throw new SdlcError('CRITIC_REVIEW_FAILED', 'Governor returned an unresolved reviewer vendor');
		}
		if ((canonicalAuthors as readonly string[]).includes(reviewerVendor)) {
			throw new SdlcError(
				'IDENTICAL_REVIEWER_VENDOR',
				`Reviewer vendor '${reviewerVendor}' matches an excluded author vendor: ${canonicalAuthors.join(', ')}`,
			);
		}

		const output = result.output as { status?: unknown; findings?: unknown } | null | undefined;
		if (!output || typeof output !== 'object') {
			throw new SdlcError('CRITIC_REVIEW_FAILED', 'Critic review output must be an object');
		}
		if (output.status !== 'PASS' && output.status !== 'FAIL') {
			throw new SdlcError('CRITIC_REVIEW_FAILED', 'Critic review output status must be PASS or FAIL');
		}
		if (!Array.isArray(output.findings)) {
			throw new SdlcError('CRITIC_REVIEW_FAILED', 'Critic review output findings must be an array');
		}
		const typedFindings: CriticFinding[] = [];
		for (const finding of output.findings) {
			if (!finding || typeof finding !== 'object' || !('severity' in finding) || !('category' in finding) || !finding.severity || !finding.category) {
				throw new SdlcError('CRITIC_REVIEW_FAILED', 'Critic review finding is malformed');
			}
			typedFindings.push(finding as CriticFinding);
		}

		const { verified: groundedFindings, unverified: ungroundedFindings } = verifyFindings({
			findings: typedFindings,
			rootDir: groundingRootDir || this.rootDir,
		});

		let findings: CriticFinding[] = [...groundedFindings];
		let coverageMatrix: QaCoverageMatrix<CriticFinding> | null = null;
		if (phase === 'qa') {
			const processed = processQaFindings({ rawFindings: groundedFindings, acceptanceCriteria });
			findings = [...processed.findings];
			coverageMatrix = processed.coverageMatrix;
		}

		const hasP1 = findings.some((f) => f.severity === 'P1');
		const status: 'PASS' | 'FAIL' = hasP1 ? 'FAIL' : 'PASS';
		const operationIdResult = result.operationId ?? operationId;
		const usageRecordIds = Object.freeze([...(result.usageRecordIds ?? [])]);

		const { reviewId, report, reportPath: relativeReportPath, manifestPath: relativeManifestPath } = persistCriticReview({
			rootDir: this.rootDir,
			reviewBaseDir: this.reviewBaseDir,
			runtimeStore: this.runtimeStore,
			runId,
			generation: effectiveGeneration,
			phase,
			canonicalAuthors,
			reviewerVendor,
			reviewerModel,
			artifactHash: resolvedArtifactHash,
			attemptKey: resolvedAttemptKey,
			status,
			findings,
			ungroundedFindings,
			coverageMatrix,
			hasP1,
			operationId: operationIdResult,
			usageRecordIds,
		});

		let repairOutcome: SemanticRepairOutcome | null = null;
		let circuitBreakerTripped = false;
		let circuitBreakerReason: string | null = null;
		if (hasP1 && this.reviewPort) {
			const reportHash = sha256(report);
			const p1Files = findings.filter((f) => f.severity === 'P1').map((f) => String(f.file ?? ''));
			repairOutcome = (await this.reviewPort.requestSemanticRepair(runId, effectiveGeneration, reportHash, p1Files, scope)) ?? null;
			if (repairOutcome?.kind === 'interrupt') {
				circuitBreakerTripped = true;
				circuitBreakerReason = repairOutcome.reason ?? null;
			}
		}

		return Object.freeze({
			reviewId,
			runId,
			generation: effectiveGeneration,
			phase,
			status: report.status,
			hasP1,
			findings: Object.freeze(findings.map((f) => Object.freeze({ ...f }))),
			findingsCount: findings.length,
			ungroundedFindings: Object.freeze(ungroundedFindings.map((f) => Object.freeze({ ...f }))),
			coverageMatrix: coverageMatrix ?? null,
			reportPath: relativeReportPath,
			manifestPath: relativeManifestPath,
			authorVendors: canonicalAuthors,
			reviewerVendor,
			reviewerModel,
			artifactHash: resolvedArtifactHash,
			attemptKey: resolvedAttemptKey,
			operationId: operationIdResult,
			usageRecordIds,
			repairOutcome,
			circuitBreakerTripped,
			circuitBreakerReason,
		});
	}
}
