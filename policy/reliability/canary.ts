// Canary eligibility, bindings, and qualification. currentCanaryBindings only reads.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadPolicy } from '@evelbulgroz/model-usage-govenor/policy';
import { liveRunRoot, resolveRunPaths } from '../../persistence/run-paths.ts';
import { RoleRegistry } from '../../roles/role-registry.ts';
import {
	listBoundedPlanningFiles,
	resolveBoundedPlanningFilePath,
} from '../canary-planning-files.ts';
import {
	type CanaryQualification,
	RELIABILITY_SCHEMA_VERSION,
	type ReliabilityFailureCategory,
	canonicalJson,
	sha256,
	validateCanaryQualification,
} from '../contracts.ts';
import { SdlcError } from '../errors.ts';
import { INFRASTRUCTURE_CODES, classifyReliabilityFailure } from './failure-classification.ts';
import { type RuntimeEvidence, readRuntimeEvidence } from './run-evidence.ts';
import { invalidContract } from './sanitization.ts';

export const CANARY_LIMITS = Object.freeze({
	slices: 1,
	tasks: 1,
	acceptanceCriteria: 2,
	authoredPaths: 3,
	complexityScore: 10,
});

export interface CanaryTaskCandidate {
	authoredPaths?: readonly string[];
	pathPrefixes?: readonly string[];
	complexityScore?: number;
	highRisk?: boolean;
	dependencyMutations?: readonly unknown[];
	generatedOutputs?: readonly string[];
	contractProducer?: boolean;
	deliveryLayers?: readonly string[];
}

export interface CanarySliceCandidate {
	kind: string;
	acceptanceCriteria: readonly string[];
}

export interface CanaryBindings {
	repositoryId: string;
	workflowHash: string;
	boundedPlanningHash: string;
	implementerRoleHash: string;
	modelPolicyHash: string;
}

export function evaluateCanaryEligibility(
	taskReadiness: {
		tasks?: readonly CanaryTaskCandidate[];
		slices?: readonly CanarySliceCandidate[];
	} | null | undefined,
): {
	schemaVersion: string;
	status: 'CANARY_ELIGIBLE' | 'CANARY_INELIGIBLE';
	eligible: boolean;
	limits: typeof CANARY_LIMITS;
	violations: Array<Record<string, unknown>>;
	task: CanaryTaskCandidate | null;
	slice: CanarySliceCandidate | null;
} {
	const violations: Array<Record<string, unknown>> = [];
	const tasks = taskReadiness?.tasks ?? [];
	const slices = taskReadiness?.slices ?? [];
	if (slices.length !== CANARY_LIMITS.slices) {
		violations.push(limitViolation('slices', slices.length, CANARY_LIMITS.slices));
	}
	if (tasks.length !== CANARY_LIMITS.tasks) {
		violations.push(limitViolation('tasks', tasks.length, CANARY_LIMITS.tasks));
	}
	const slice = slices[0];
	if (slice && slice.kind !== 'vertical') {
		violations.push({
			dimension: 'sliceKind',
			actual: slice.kind,
			allowed: 'vertical',
		});
	}
	const task = tasks[0];
	if (slice && slice.acceptanceCriteria.length > CANARY_LIMITS.acceptanceCriteria) {
		violations.push(
			limitViolation(
				'acceptanceCriteria',
				slice.acceptanceCriteria.length,
				CANARY_LIMITS.acceptanceCriteria,
			),
		);
	}
	if (task) {
		const authoredPaths = task.authoredPaths ?? task.pathPrefixes ?? [];
		if (authoredPaths.length > CANARY_LIMITS.authoredPaths) {
			violations.push(
				limitViolation('authoredPaths', authoredPaths.length, CANARY_LIMITS.authoredPaths),
			);
		}
		if (
			(task.complexityScore ?? Number.POSITIVE_INFINITY) > CANARY_LIMITS.complexityScore
		) {
			violations.push(
				limitViolation(
					'complexityScore',
					task.complexityScore ?? null,
					CANARY_LIMITS.complexityScore,
				),
			);
		}
		if (task.highRisk === true) violations.push(booleanViolation('highRisk'));
		if ((task.dependencyMutations ?? []).length > 0) {
			violations.push(booleanViolation('dependencyMutation'));
		}
		if ((task.generatedOutputs ?? []).length > 0) {
			violations.push(booleanViolation('generatedOutputs'));
		}
		if (
			task.contractProducer === true ||
			(task.deliveryLayers ?? []).includes('contracts')
		) {
			violations.push(booleanViolation('publicContractProduction'));
		}
	}
	return {
		schemaVersion: RELIABILITY_SCHEMA_VERSION,
		status: violations.length === 0 ? 'CANARY_ELIGIBLE' : 'CANARY_INELIGIBLE',
		eligible: violations.length === 0,
		limits: CANARY_LIMITS,
		violations,
		task: task ?? null,
		slice: slice ?? null,
	};
}

export function currentCanaryBindings(rootDir: string): CanaryBindings {
	const registry = new RoleRegistry({ rootDir });
	const workflow = registry.load();
	const implementer = registry.loadRole('implementer');
	const boundedPlanningFiles = listBoundedPlanningFiles(rootDir);
	const hostPolicyPath = path.join(rootDir, '.agents/model-usage-policy.json');
	const policyPath = fs.existsSync(hostPolicyPath)
		? hostPolicyPath
		: loadPolicy.DEFAULT_BUNDLED_POLICY_PATH;
	return {
		repositoryId: repositoryId(rootDir),
		workflowHash: workflow.hashes.workflowHash,
		boundedPlanningHash: sha256(
			boundedPlanningFiles.map((filename) => [
				filename,
				fs.readFileSync(resolveBoundedPlanningFilePath(rootDir, filename), 'utf8'),
			]),
		),
		implementerRoleHash: implementer.hashes.roleHash,
		modelPolicyHash: sha256(fs.readFileSync(policyPath, 'utf8')),
	};
}

export function readCanaryQualification(rootDir: string): CanaryQualification | null {
	const filename = canaryQualificationPath(rootDir);
	if (!fs.existsSync(filename)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
	} catch (error) {
		throw invalidContract('Canary qualification evidence is malformed', error);
	}
	return validateCanaryQualification(parsed);
}

export function evaluateCurrentCanaryGate(rootDir: string): {
	status: 'CANARY_REQUIRED' | 'CANARY_STALE' | 'CANARY_CURRENT';
	current: boolean;
	reason?: string;
	qualification?: CanaryQualification;
	currentBindings?: CanaryBindings;
} {
	const qualification = readCanaryQualification(rootDir);
	if (!qualification) {
		return { status: 'CANARY_REQUIRED', current: false, reason: 'missing' };
	}
	return evaluateCanaryFreshness(qualification, currentCanaryBindings(rootDir));
}

export function evaluateCanaryFreshness(
	qualification: CanaryQualification,
	current: CanaryBindings,
): {
	status: 'CANARY_REQUIRED' | 'CANARY_STALE' | 'CANARY_CURRENT';
	current: boolean;
	reason?: string;
	qualification: CanaryQualification;
	currentBindings?: CanaryBindings;
} {
	if (qualification.status !== 'PASSED') {
		return {
			status: 'CANARY_REQUIRED',
			current: false,
			reason: qualification.status.toLowerCase(),
			qualification,
		};
	}
	const fields = [
		'repositoryId',
		'workflowHash',
		'boundedPlanningHash',
		'implementerRoleHash',
		'modelPolicyHash',
	] as const;
	for (const field of fields) {
		if (qualification[field] !== current[field]) {
			return {
				status: 'CANARY_STALE',
				current: false,
				reason: `${field}-changed`,
				qualification,
				currentBindings: current,
			};
		}
	}
	return { status: 'CANARY_CURRENT', current: true, qualification };
}

export function qualifyCanaryRun({
	rootDir,
	runId,
	now = new Date(),
}: {
	rootDir: string;
	runId: string;
	now?: Date;
}): CanaryQualification {
	const paths = resolveRunPaths(runId, rootDir);
	const evidence = readRuntimeEvidence(paths.databasePath);
	const eligibility = evaluateCanaryEligibility({
		tasks: evidence.tasks,
		slices: evidence.slices,
	});
	if (!eligibility.eligible) {
		throw new SdlcError('INVALID_INPUT', 'Run is not an eligible canary', {
			status: eligibility.status,
			violations: eligibility.violations,
		});
	}
	const bindings = currentCanaryBindings(rootDir);
	const qualification = evaluateCanaryQualificationEvidence({
		evidence,
		bindings,
		currentBaseCommitSha: resolveGitHead(rootDir),
		rootDir,
		now,
	});
	writeCanaryQualification(rootDir, qualification);
	return qualification;
}

export function evaluateCanaryQualificationEvidence({
	evidence,
	bindings,
	currentBaseCommitSha = evidence.authorization.baseCommitSha,
	rootDir = process.cwd(),
	now = new Date(),
}: {
	evidence: RuntimeEvidence;
	bindings: CanaryBindings;
	currentBaseCommitSha?: string;
	rootDir?: string;
	now?: Date;
}): CanaryQualification {
	if (!/^[a-f0-9]{64}$/.test(evidence.plan?.taskManifestHash ?? '')) {
		throw new SdlcError(
			'CANARY_REQUIRED',
			'Canary qualification requires task manifest evidence; start the run with --task-plan-file.',
			{ reason: 'CANARY_TASK_MANIFEST_MISSING' },
		);
	}
	const state = evidence.state;
	const task = evidence.tasks[0];
	const failures: ReliabilityFailureCategory[] = [];
	let inconclusiveCause: string | null = null;
	const lastErrorCode = state.lastError?.code ?? '';
	if (
		['WAITING_FOR_ANSWERS', 'BLOCKED', 'BUDGET_EXHAUSTED'].includes(state.state) ||
		INFRASTRUCTURE_CODES.has(lastErrorCode)
	) {
		inconclusiveCause = state.lastError?.code ?? state.blockedReason ?? state.state;
	}
	if (!inconclusiveCause) {
		if (evidence.authorization.baseCommitSha !== currentBaseCommitSha) {
			if (
				!isDocumentationOnlyGitRange(
					rootDir,
					evidence.authorization.baseCommitSha,
					currentBaseCommitSha,
				)
			) {
				failures.push('STALE_BASE_COMMIT');
			}
		}
		if (!['READY_FOR_GIT_APPROVAL', 'DONE'].includes(state.state)) {
			failures.push(
				state.lastError
					? classifyReliabilityFailure(state.lastError)
					: 'IMPLEMENTER_NON_COMPLETED',
			);
		}
		if (task.status !== 'completed') failures.push('IMPLEMENTER_NON_COMPLETED');
		if (task.repairCount > 0 || (state.semanticRepairsCount ?? 0) > 0) {
			failures.push('REPAIR_INVOKED');
		}
		if (
			(evidence.qaDivergences ?? []).some(
				(finding) =>
					finding?.groundingVerified === true &&
					['P1', 'P2'].includes(finding.severity ?? '') &&
					/(?:test|acceptance|coverage)/i.test(finding.category ?? '') &&
					/\b(?:GAP|DIVERGENT)\s+AC-\d{2,}\b/i.test(
						[finding.evidence, finding.message, finding.ruleId, finding.impact]
							.filter(Boolean)
							.join(' '),
					),
			)
		) {
			failures.push('QA_ACCEPTANCE_DIVERGENCE');
		}
		if (evidence.mutationAttempts.some((attempt) => attempt.status === 'rejected')) {
			failures.push('INVALID_EDIT');
		}
		const taskMutationAttempts = evidence.mutationAttempts.filter(
			(attempt) => attempt.taskId === task.taskId,
		);
		const taskVerificationAttempts = evidence.verificationAttempts
			.filter(
				(attempt) =>
					attempt.taskId === task.taskId &&
					attempt.phase === 'post-implementation',
			)
			.sort((left, right) => left.attempt - right.attempt);
		const lastVerification =
			taskVerificationAttempts[taskVerificationAttempts.length - 1];
		if (!lastVerification || lastVerification.status !== 'passed') {
			failures.push('VERIFICATION_FAILURE');
		} else if (
			taskMutationAttempts.some(
				(attempt) =>
					attempt.status === 'accepted' &&
					Date.parse(attempt.occurredAt) >=
						Date.parse(lastVerification.occurredAt),
			)
		) {
			failures.push('POST_VERIFICATION_MUTATION');
		}
		if (evidence.reconciliation?.status !== 'RECONCILIATION_COMPLETED') {
			failures.push('SCOPE_EXPANSION');
		}
		if (
			evidence.preflight?.status !== 'OK' ||
			evidence.preflight?.canonical !== true
		) {
			failures.push('NONCANONICAL_PREFLIGHT');
		}
		if (
			evidence.implementerOperations.length === 0 ||
			evidence.implementerOperations.some((operation) => operation.synthetic)
		) {
			inconclusiveCause = 'HOSTED_IMPLEMENTER_EVIDENCE_MISSING';
		}
	}
	return validateCanaryQualification({
		schemaVersion: RELIABILITY_SCHEMA_VERSION,
		repositoryId: bindings.repositoryId,
		runId: state.runId,
		status: inconclusiveCause
			? 'INCONCLUSIVE'
			: failures.length === 0
				? 'PASSED'
				: 'FAILED',
		failureCategories: [...new Set(failures)].sort(),
		inconclusiveCause,
		baseCommitSha: evidence.authorization.baseCommitSha,
		workflowHash: state.workflowHash,
		boundedPlanningHash: bindings.boundedPlanningHash,
		implementerRoleHash: bindings.implementerRoleHash,
		modelPolicyHash: bindings.modelPolicyHash,
		taskPlanHash: evidence.plan.planPolicyHash,
		taskManifestHash: evidence.plan.taskManifestHash,
		qualifiedAt: now.toISOString(),
	});
}

function writeCanaryQualification(
	rootDir: string,
	qualification: CanaryQualification,
): void {
	const filename = canaryQualificationPath(rootDir);
	fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
	const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
	fs.writeFileSync(temporary, `${canonicalJson(qualification)}\n`, {
		mode: 0o600,
	});
	fs.renameSync(temporary, filename);
	fs.chmodSync(filename, 0o600);
}

function canaryQualificationPath(rootDir: string): string {
	return path.join(liveRunRoot(rootDir), 'canary-qualification.json');
}

function repositoryId(rootDir: string): string {
	try {
		return execFileSync('git', ['config', '--get', 'remote.origin.url'], {
			cwd: rootDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
	} catch {
		return path.basename(rootDir);
	}
}

export function resolveGitHead(rootDir: string): string {
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], {
			cwd: rootDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
	} catch (error) {
		throw new SdlcError(
			'INVALID_INPUT',
			'Cannot resolve the current base commit',
			{},
			{ cause: error },
		);
	}
}

export function isDocumentationOnlyGitRange(
	rootDir: string,
	fromSha: string | null | undefined,
	toSha: string | null | undefined,
): boolean {
	if (!fromSha || !toSha || fromSha === toSha) return true;
	try {
		const output = execFileSync(
			'git',
			['diff', '--name-only', `${fromSha}..${toSha}`],
			{
				cwd: rootDir,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'ignore'],
			},
		).trim();
		if (!output) return true;
		const files = output
			.split('\n')
			.map((f) => f.trim())
			.filter(Boolean);
		return files.every(
			(file) =>
				file.endsWith('.md') ||
				file.startsWith('docs/') ||
				file.startsWith('.agents/') ||
				file === 'MIGRATION.md' ||
				file === 'README.md' ||
				file === 'AGENTS.md',
		);
	} catch {
		return false;
	}
}

function limitViolation(
	dimension: string,
	actual: number | null,
	maximum: number,
): Record<string, unknown> {
	return { dimension, actual, maximum };
}

function booleanViolation(dimension: string): Record<string, unknown> {
	return { dimension, actual: true, maximum: false };
}
