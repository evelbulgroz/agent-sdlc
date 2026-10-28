import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import {
	resolveAuthorVendor,
	resolveCodeAuthorVendors,
	type AuthorVendorRuntimeStoreLike,
} from './author-vendor.ts';
import {
	assertCriticAllowed,
	findingsFromExistingReview,
	nextRound,
	planAttemptKey,
	qaAttemptKey,
	specAttemptKey,
	type CriticBudgetSnapshot,
	type CriticReviewLike,
} from './critic-budget.ts';
import {
	packPlanDocument,
	packQaExcerpts,
	packSpecDocument,
	type PlanDocumentPackingInput,
	type SpecDocumentPackingInput,
} from './critic-input-packing.ts';
import {
	CriticReviewAdapter,
	type CriticGovernorLike,
	type CriticReviewExecutionResult,
	type CriticRuntimeStoreLike,
} from './critic-review.ts';
import type { TouchedFileEntry } from './critic-prompt.ts';

export interface CriticGateSnapshot extends CriticBudgetSnapshot {
	draftHash?: string | null;
	draftArtifact?: string | null;
	specApprovalAttempt?: number;
	taskPlanHash?: string | null;
	activeGeneration?: number | null;
	integrationWorktreePath?: string | null;
	worktreePath?: string | null;
	authorVendor?: string | null;
}

export interface CriticGateRuntimeStoreLike
	extends CriticRuntimeStoreLike,
		AuthorVendorRuntimeStoreLike {
	listCriticReviews(runId: string): readonly CriticReviewLike[];
	getGeneration?(runId: string, generation: number): { taskOwnedPaths?: readonly string[] } | null;
	getLatestGeneration?(runId: string): { taskOwnedPaths?: readonly string[] } | null;
	getAuthorization?(runId: string): { baseCommitSha?: string | null } | null;
}

export interface CriticGateRuntimeLike {
	runtimeStore: CriticGateRuntimeStoreLike;
	registry: {
		rootDir: string;
		loadRole(roleId: string): { promptPolicy: string };
	};
	governor?: CriticGovernorLike;
	artifactStore: {
		readJson(artifactRef: string | null | undefined): Record<string, unknown>;
	};
	gitCli?: (
		cmd: string,
		args: string[],
		options: { cwd: string; encoding: 'utf8'; stdio: ['ignore', 'pipe', 'pipe'] },
	) => unknown;
}

export interface CriticGateResult {
	status: 'SKIP' | 'BUDGET_EXHAUSTED' | 'PASS' | 'FAIL';
	hasP1: boolean;
	findings: readonly unknown[];
	review: CriticReviewLike | CriticReviewExecutionResult | null;
	artifactHash: string | null | undefined;
	attemptKey: string;
	event?: {
		eventType: 'CRITIC_REVIEW_COMPLETED';
		payload: {
			phase: 'spec';
			artifactHash: string | null | undefined;
			attemptKey: string;
			hasP1: boolean;
			reviewId: string;
		};
	};
}

export async function runSpecCritic({
	runtime,
	snapshot,
	draft,
}: {
	runtime: CriticGateRuntimeLike;
	snapshot: CriticGateSnapshot;
	draft: SpecDocumentPackingInput & { goal?: string; acceptanceCriteria?: readonly string[] };
}): Promise<Readonly<CriticGateResult>> {
	assertCriticAllowed({ phase: 'spec', snapshot });
	const artifactHash = snapshot.draftHash;
	const attemptKey = specAttemptKey(snapshot.specApprovalAttempt ?? 0);
	const round = nextRound({
		phase: 'spec',
		snapshot,
		artifactHash,
		attemptKey,
		runtimeStore: runtime.runtimeStore,
	});
	if (round.action === 'skip') {
		return Object.freeze({
			status: 'SKIP',
			hasP1: round.existing.hasP1 === true,
			findings: Object.freeze(findingsFromExistingReview(round.existing)),
			review: round.existing,
			artifactHash,
			attemptKey,
		});
	}
	if (round.action === 'budget_exhausted') {
		return Object.freeze({
			status: 'BUDGET_EXHAUSTED',
			hasP1: round.last?.hasP1 === true,
			findings: Object.freeze([]),
			review: round.last ?? null,
			artifactHash,
			attemptKey,
		});
	}

	const existingReviews = runtime.runtimeStore
		.listCriticReviews(snapshot.runId)
		.filter((review) => review.phase === 'spec');
	const maxStoredGen = existingReviews.reduce(
		(max, r) => Math.max(max, (r.generation ?? 0) + 1),
		0,
	);
	const generation = Math.max(
		snapshot.specApprovalAttempt ?? 0,
		existingReviews.length,
		maxStoredGen,
	);

	const loaded = runtime.registry.loadRole('critic-reviewer');
	const adapter = new CriticReviewAdapter({
		rootDir: runtime.registry.rootDir,
		governor: runtime.governor,
		runtimeStore: runtime.runtimeStore,
	});
	const result = await adapter.executeReview({
		runId: snapshot.runId,
		generation,
		phase: 'spec',
		authorVendor: resolveAuthorVendor(snapshot, {
			synthetic: runtime.governor?.synthetic === true,
		}),
		promptPolicy: loaded.promptPolicy,
		specSummary: draft.goal,
		acceptanceCriteria: draft.acceptanceCriteria ?? [],
		documentText: packSpecDocument(draft),
		artifactHash,
		attemptKey,
	});
	const event = {
		eventType: 'CRITIC_REVIEW_COMPLETED' as const,
		payload: {
			phase: 'spec' as const,
			artifactHash,
			attemptKey,
			hasP1: result.hasP1,
			reviewId: result.reviewId,
		},
	};
	return Object.freeze({
		status: result.hasP1 ? 'FAIL' : 'PASS',
		hasP1: result.hasP1,
		findings: result.findings,
		review: result,
		artifactHash,
		attemptKey,
		event,
	});
}

export async function runPlanCritic({
	runtime,
	snapshot,
	plan,
}: {
	runtime: CriticGateRuntimeLike;
	snapshot: CriticGateSnapshot;
	plan: PlanDocumentPackingInput;
}): Promise<Readonly<CriticGateResult>> {
	assertCriticAllowed({ phase: 'plan', snapshot });
	if (!snapshot.taskPlanHash) {
		throw new SdlcError('POLICY_VIOLATION', 'Plan critic requires a candidate taskPlanHash');
	}
	if (!snapshot.approvedPlanPolicyHash) {
		throw new SdlcError('POLICY_VIOLATION', 'Plan critic requires approvedPlanPolicyHash');
	}
	const artifactHash = snapshot.taskPlanHash;
	const attemptKey = planAttemptKey(snapshot.approvedPlanPolicyHash);
	const round = nextRound({
		phase: 'plan',
		snapshot,
		artifactHash,
		attemptKey,
		runtimeStore: runtime.runtimeStore,
	});
	if (round.action === 'skip') {
		return Object.freeze({
			status: 'SKIP',
			hasP1: round.existing.hasP1 === true,
			findings: Object.freeze(findingsFromExistingReview(round.existing)),
			review: round.existing,
			artifactHash,
			attemptKey,
		});
	}
	if (round.action === 'budget_exhausted') {
		return Object.freeze({
			status: 'BUDGET_EXHAUSTED',
			hasP1: round.last?.hasP1 === true,
			findings: Object.freeze([]),
			review: round.last ?? null,
			artifactHash,
			attemptKey,
		});
	}

	const existingReviews = runtime.runtimeStore
		.listCriticReviews(snapshot.runId)
		.filter((review) => review.phase === 'plan');
	const maxStoredGen = existingReviews.reduce(
		(max, r) => Math.max(max, (r.generation ?? 0) + 1),
		0,
	);
	const generation = Math.max(existingReviews.length, maxStoredGen);

	const loaded = runtime.registry.loadRole('critic-reviewer');
	const adapter = new CriticReviewAdapter({
		rootDir: runtime.registry.rootDir,
		governor: runtime.governor,
		runtimeStore: runtime.runtimeStore,
	});
	const result = await adapter.executeReview({
		runId: snapshot.runId,
		generation,
		phase: 'plan',
		authorVendor: resolveAuthorVendor(snapshot, {
			synthetic: runtime.governor?.synthetic === true,
		}),
		promptPolicy: loaded.promptPolicy,
		documentText: packPlanDocument(plan),
		artifactHash,
		attemptKey,
	});
	return Object.freeze({
		status: result.hasP1 ? 'FAIL' : 'PASS',
		hasP1: result.hasP1,
		findings: result.findings,
		review: result,
		artifactHash,
		attemptKey,
	});
}

const TEST_FILE_RE = /(\.(spec|test|e2e-spec)\.[cm]?[jt]sx?$)|(^|\/)tests?\//;

export function isTouchedTestFile(filePath: unknown): boolean {
	if (typeof filePath !== 'string' || filePath.trim().length === 0) return false;
	return TEST_FILE_RE.test(filePath.split('\\').join('/'));
}

export function qaArtifactHash({
	approvedSpecHash,
	preflightResultHash,
}: {
	approvedSpecHash: unknown;
	preflightResultHash: unknown;
}): string {
	return sha256({ approvedSpecHash, preflightResultHash });
}

export function collectTouchedTestFiles({
	runtime,
	snapshot,
	auth,
	worktreeDirs,
}: {
	runtime?: {
		runtimeStore: {
			getGeneration?(runId: string, generation: number): { taskOwnedPaths?: readonly string[] } | null;
			getLatestGeneration?(runId: string): { taskOwnedPaths?: readonly string[] } | null;
		};
		gitCli?: CriticGateRuntimeLike['gitCli'];
	};
	snapshot?: {
		runId: string;
		activeGeneration?: number | null;
		integrationWorktreePath?: string | null;
		worktreePath?: string | null;
	};
	auth?: { baseCommitSha?: string | null } | null;
	worktreeDirs?: readonly (string | null | undefined)[];
} = {}): readonly string[] {
	if (!runtime || !snapshot) return Object.freeze([]);
	const files = new Set<string>();
	const generation =
		runtime.runtimeStore.getGeneration?.(snapshot.runId, snapshot.activeGeneration ?? 0) ??
		runtime.runtimeStore.getLatestGeneration?.(snapshot.runId);
	for (const owned of generation?.taskOwnedPaths ?? []) {
		if (isTouchedTestFile(owned)) files.add(owned);
	}
	const dirs =
		Array.isArray(worktreeDirs) && worktreeDirs.length > 0
			? worktreeDirs
			: [snapshot.integrationWorktreePath || snapshot.worktreePath];
	if (typeof runtime.gitCli === 'function') {
		for (const worktreeDir of dirs) {
			if (!worktreeDir) continue;
			const baseDiffArgs = ['diff', '--name-only'];
			if (auth?.baseCommitSha) baseDiffArgs.push(auth.baseCommitSha);
			for (const args of [baseDiffArgs, ['diff', '--cached', '--name-only']]) {
				try {
					const out = runtime.gitCli('git', args, {
						cwd: worktreeDir,
						encoding: 'utf8',
						stdio: ['ignore', 'pipe', 'pipe'],
					});
					for (const line of String(out ?? '').split('\n')) {
						const trimmed = line.trim();
						if (isTouchedTestFile(trimmed)) files.add(trimmed);
					}
				} catch {
					// Listing is best-effort; packing still proceeds with known paths.
				}
			}
		}
	}
	return Object.freeze([...files].sort());
}

export async function runQaCritic({
	runtime,
	snapshot,
}: {
	runtime: CriticGateRuntimeLike;
	snapshot: CriticGateSnapshot;
}): Promise<Readonly<CriticGateResult>> {
	assertCriticAllowed({ phase: 'qa', snapshot });
	const binding = runtime.artifactStore.readJson(snapshot.preflightBindingArtifact);
	if (binding.status !== 'OK' || binding.canonical !== true) {
		throw new SdlcError(
			'POLICY_VIOLATION',
			'QA critic requires preflight status=OK canonical=true',
		);
	}
	const preflightResultHash = binding.preflightResultHash;
	if (typeof preflightResultHash !== 'string' || !/^[a-f0-9]{64}$/.test(preflightResultHash)) {
		throw new SdlcError('INVALID_CONTRACT', 'preflightResultHash must be a 64-character hex digest');
	}
	const approvedSpecHash = snapshot.approvedSpecHash ?? '';
	const artifactHash = qaArtifactHash({
		approvedSpecHash,
		preflightResultHash,
	});
	const attemptKey = qaAttemptKey(approvedSpecHash);
	const round = nextRound({
		phase: 'qa',
		snapshot,
		artifactHash,
		attemptKey,
		runtimeStore: runtime.runtimeStore,
	});
	if (round.action === 'skip') {
		return Object.freeze({
			status: 'SKIP',
			hasP1: round.existing.hasP1 === true,
			findings: Object.freeze(findingsFromExistingReview(round.existing)),
			review: round.existing,
			artifactHash,
			attemptKey,
		});
	}
	if (round.action === 'budget_exhausted') {
		return Object.freeze({
			status: 'BUDGET_EXHAUSTED',
			hasP1: false,
			findings: Object.freeze([]),
			review: round.last ?? null,
			artifactHash,
			attemptKey,
		});
	}

	let preflightResult: unknown = null;
	try {
		preflightResult = runtime.artifactStore.readJson(preflightResultHash);
	} catch {
		preflightResult = null;
	}
	const draft = runtime.artifactStore.readJson(snapshot.draftArtifact);
	const auth = runtime.runtimeStore.getAuthorization?.(snapshot.runId) ?? null;
	const touchedTestFiles = collectTouchedTestFiles({ runtime, snapshot, auth });
	const worktreeDir = snapshot.integrationWorktreePath || snapshot.worktreePath;
	const touchedFiles: TouchedFileEntry[] = [];
	for (const relativePath of touchedTestFiles) {
		let content: string | null = null;
		if (worktreeDir) {
			try {
				const fullPath = path.join(worktreeDir, relativePath);
				if (fs.existsSync(fullPath)) {
					content = fs.readFileSync(fullPath, 'utf8');
				}
			} catch {
				content = null;
			}
		}
		if (typeof content === 'string') {
			touchedFiles.push({ path: relativePath, content });
		} else {
			touchedFiles.push(relativePath);
		}
	}
	const loaded = runtime.registry.loadRole('critic-reviewer');
	const adapter = new CriticReviewAdapter({
		rootDir: runtime.registry.rootDir,
		governor: runtime.governor,
		runtimeStore: runtime.runtimeStore,
	});
	const draftGoal = typeof draft.goal === 'string' ? draft.goal : '';
	const draftAc = Array.isArray(draft.acceptanceCriteria)
		? draft.acceptanceCriteria.filter((item): item is string => typeof item === 'string')
		: [];
	const result = await adapter.executeReview({
		runId: snapshot.runId,
		generation: snapshot.activeGeneration ?? 0,
		phase: 'qa',
		authorVendors: resolveCodeAuthorVendors(snapshot, runtime.runtimeStore, {
			synthetic: runtime.governor?.synthetic === true,
		}),
		promptPolicy: loaded.promptPolicy,
		specSummary: draftGoal,
		acceptanceCriteria: draftAc,
		touchedFiles,
		testOutput: packQaExcerpts(preflightResult),
		artifactHash,
		attemptKey,
	});
	return Object.freeze({
		status: result.hasP1 ? 'FAIL' : 'PASS',
		hasP1: result.hasP1,
		findings: result.findings,
		review: result,
		artifactHash,
		attemptKey,
	});
}
