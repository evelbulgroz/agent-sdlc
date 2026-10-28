// Helpers shared by workflow node factories.

import fs from 'node:fs';
import path from 'node:path';
import type { QaDivergenceLike } from '../adapters/github-pr.ts';
import {
	type CoverageAdvisory,
	coverageAdvisoryFromSource,
} from '../execution/coverage-advisory.ts';
import type { CheckpointerStore } from '../persistence/langgraph-checkpointer.ts';
import type { ModelOperationInput } from '../persistence/model-operation-records.ts';
import { validateAuthorizationEnvelope } from '../policy/authorization.ts';
import type {
	CriticReviewRecord,
	EventType,
	GenerationRecord,
	GitCommitRecord,
	ReconciliationRecord,
	RunAuthorizationRecord,
	RuntimeEvent,
	RuntimeState,
	RuntimeStateName,
	TaskPlan,
} from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import type { RoleExecutor, RoleExecutorGovernorPort } from '../roles/role-executor.ts';
import type { RoleRegistry } from '../roles/role-registry.ts';
import type { GitCliFn } from './git-manager.ts';

export type WorkflowModelGovernor = RoleExecutorGovernorPort;

export interface GraphStateValues {
	snapshot: Readonly<RuntimeState>;
	humanResponse?: unknown;
}


export interface WorkflowInterruptRecord {
	readonly interruptId: string;
	readonly runId: string;
	readonly kind: string;
	readonly status: string;
	readonly stateHash: string;
	readonly requestArtifact: string;
	readonly responseArtifact?: string | null;
	readonly createdAt: string;
}

export interface WorkflowTransitionOptions {
	to: RuntimeStateName;
	eventType: EventType;
	causalId: string;
	updates: Record<string, unknown>;
	payload: Record<string, unknown>;
	effects?: Record<string, unknown>;
}

export interface WorkflowRuntimeStorePort extends CheckpointerStore {
	readonly rootDir?: string;
	readonly database: {
		prepare(sql: string): {
			all(...params: unknown[]): Array<Record<string, unknown>>;
			get(...params: unknown[]): Record<string, unknown> | undefined;
			run(...params: unknown[]): unknown;
		};
	};
	initializeRun(initial: Readonly<RuntimeState>, event: Readonly<RuntimeEvent>): void;
	getRun(runId: string): Readonly<RuntimeState>;
	saveTransition(
		expectedRevision: number,
		next: Readonly<RuntimeState>,
		event: Readonly<RuntimeEvent>,
		effects?: Record<string, unknown>,
	): Readonly<RuntimeState>;
	listEvents(runId: string): Readonly<RuntimeEvent>[];
	appendEvent(event: Readonly<RuntimeEvent>): void;
	recordEvent(event: Readonly<RuntimeEvent>): void;
	listCriticReviews(runId: string): readonly CriticReviewRecord[];
	saveCriticReview(record: unknown): void;
	getAuthorization(runId: string): Readonly<RunAuthorizationRecord> | null;
	saveAuthorization(envelope: unknown): void;
	getInterrupt(interruptId: string): WorkflowInterruptRecord | null;
	getPendingInterrupt(runId: string): WorkflowInterruptRecord | null;
	recordInterruptResponse(interruptId: string, responseArtifact: string): void;
	getGitCommit(runId: string): Readonly<GitCommitRecord> | null;
	saveGitCommit(record: unknown): void;
	savePullRequest(record: unknown): void;
	getTaskPlan(runId: string): Readonly<TaskPlan> | null;
	saveTaskPlan(plan: unknown): void;
	updateTaskStatus(runId: string, taskId: string, updates: Record<string, unknown>): void;
	saveReconciliation(record: ReconciliationRecord): void;
	getSemanticRepairsCount(runId: string): number;
	getGeneration(runId: string, generation: number): Readonly<GenerationRecord> | null;
	getLatestGeneration(runId: string): Readonly<GenerationRecord> | null;
	saveGeneration(record: unknown): void;
	getModelOperation(operationId: string): {
		status?: string;
		outputArtifact?: string | null;
		synthetic?: boolean;
		usageRecordIds?: readonly string[];
		effectiveStrategy?: string | null;
		selectedQualityTier?: number | null;
		counterfactualTier2CostMicrousd?: number | null;
	} | null;
	recordModelOperation(record: ModelOperationInput): unknown;
	listModelOperations?(runId: string): ReadonlyArray<Record<string, unknown>>;
}

export interface WorkflowArtifactStorePort {
	readonly artifactsDir: string;
	writeText(prefix: string, content: string): string;
	writeJson(prefix: string, payload: unknown): string;
	readText?(hash: string | null | undefined): string;
	readJson(hash: string | null | undefined): Record<string, unknown>;
}

export interface WorkflowRuntimeLike {
	readonly runtimeStore: WorkflowRuntimeStorePort;
	readonly artifactStore: WorkflowArtifactStorePort;
	readonly registry: RoleRegistry;
	readonly governor: RoleExecutorGovernorPort;
	readonly roleExecutor: RoleExecutor;
	readonly checkpointer: unknown;
	readonly now: () => Date;
	readonly onBoundary: (boundary: string, context: Record<string, unknown>) => Promise<void>;
	readonly execCli: GitCliFn;
	readonly gitCli: GitCliFn;
	readonly ghCli: GitCliFn;
	readonly rootDir: string;
	transition(
		currentInput: Readonly<RuntimeState>,
		options: WorkflowTransitionOptions,
	): Readonly<RuntimeState>;
	currentOrAlreadyAdvanced(snapshot: Readonly<RuntimeState>): Readonly<RuntimeState> | null;
}

export function shouldDeferGitMaterialization(
	authorization: { taskManifestHash?: string | null } | null | undefined,
): boolean {
	return Boolean(authorization?.taskManifestHash);
}

export function resolvePreflightWorktree(snapshot: Readonly<RuntimeState>): string {
	return snapshot.integrationWorktreePath || snapshot.worktreePath || '';
}

export function collectQaBriefAndAdvisories(
	runtime: WorkflowRuntimeLike,
	snapshot: Readonly<RuntimeState>,
): {
	qaDivergences: QaDivergenceLike[];
	coverageAdvisories: CoverageAdvisory | null;
	semanticReviewAdvisories: unknown[];
} {
	const events = runtime.runtimeStore.listEvents(snapshot.runId);
	let coverageAdvisories: CoverageAdvisory | null = null;
	const covEvent = events
		.slice()
		.reverse()
		.find((e) => e.eventType === 'AC_COVERAGE_PASSED');
	const covPayload =
		covEvent?.payload && typeof covEvent.payload === 'object'
			? (covEvent.payload as Record<string, unknown>)
			: null;
	if (typeof covPayload?.coverageArtifact === 'string') {
		try {
			const coverage = runtime.artifactStore.readJson(covPayload.coverageArtifact);
			if (coverage) coverageAdvisories = coverageAdvisoryFromSource(coverage);
		} catch {
			// Ignore artifact read error
		}
	}
	if (!coverageAdvisories && covPayload) {
		coverageAdvisories = coverageAdvisoryFromSource(covPayload);
	}

	let qaDivergences: QaDivergenceLike[] = [];
	const qaReviews = runtime.runtimeStore
		.listCriticReviews(snapshot.runId)
		.filter((r) => r.phase === 'qa');
	if (qaReviews.length > 0) {
		const first = qaReviews[0];
		if (first) {
			try {
				const root = runtime.registry?.rootDir || runtime.rootDir || process.cwd();
				const manifestPath = path.isAbsolute(first.manifestPath)
					? first.manifestPath
					: path.join(root, first.manifestPath);
				if (fs.existsSync(manifestPath)) {
					const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
						reviews?: Array<{ reviewId?: string; phase?: string; reportPath?: string }>;
					};
					const entry = manifest.reviews?.find(
						(r) => r.reviewId === first.reviewId || r.phase === 'qa',
					);
					if (entry?.reportPath) {
						const reportPath = path.isAbsolute(entry.reportPath)
							? entry.reportPath
							: path.join(root, entry.reportPath);
						if (fs.existsSync(reportPath)) {
							const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
								findings?: QaDivergenceLike[];
							};
							qaDivergences = report.findings ?? [];
						}
					}
				}
			} catch {
				// Best-effort read of QA report
			}
		}
	}

	const semanticReviewAdvisories = events.flatMap((event) => {
		const payload =
			event.payload && typeof event.payload === 'object'
				? (event.payload as Record<string, unknown>)
				: null;
		return event.eventType === 'REVIEW_EVALUATED' && Array.isArray(payload?.semanticAdvisories)
			? payload.semanticAdvisories
			: [];
	});

	return { qaDivergences, coverageAdvisories, semanticReviewAdvisories };
}

export function getAndValidateAuthorization(
	runtime: WorkflowRuntimeLike,
	snapshot: Readonly<RuntimeState>,
): RunAuthorizationRecord {
	const auth = runtime.runtimeStore.getAuthorization(snapshot.runId);
	if (!auth) {
		throw new SdlcError(
			'AUTHORIZATION_INVALID',
			`No authorization envelope found for run '${snapshot.runId}'`,
		);
	}
	return validateAuthorizationEnvelope(auth, {
		currentRunId: snapshot.runId,
		currentSpecHash: snapshot.approvedSpecHash ?? undefined,
		currentTaskManifestHash: snapshot.taskManifestHash,
		now: runtime.now(),
	});
}

export function deferUnavailableCritic(
	runtime: WorkflowRuntimeLike,
	snapshot: Readonly<RuntimeState>,
	phase: string,
	error: unknown,
): Readonly<RuntimeState> | null {
	const deferrableCodes = new Set([
		'GOVERNOR_ROUTES_EXHAUSTED',
		'IDENTICAL_REVIEWER_VENDOR',
	]);
	const errRecord =
		error && typeof error === 'object' ? (error as { code?: unknown }) : null;
	const code = typeof errRecord?.code === 'string' ? errRecord.code : null;
	if (!code || !deferrableCodes.has(code)) return null;
	const message =
		code === 'IDENTICAL_REVIEWER_VENDOR'
			? 'Critic unavailable: no reviewer vendor is distinct from the author vendor'
			: 'Critic unavailable after all configured provider routes failed';
	return runtime.transition(snapshot, {
		to: snapshot.state,
		eventType: 'CRITIC_REVIEW_FAILED',
		causalId: `critic-unavailable-${phase}-${snapshot.runtimeRevision}`,
		updates: {},
		payload: {
			phase,
			code,
			message,
		},
	});
}

export function blockForGovernorError(
	runtime: WorkflowRuntimeLike,
	snapshot: Readonly<RuntimeState>,
	error: unknown,
): Readonly<RuntimeState> {
	const errRecord =
		error && typeof error === 'object'
			? (error as {
					code?: unknown;
					message?: unknown;
					metadata?: Record<string, unknown>;
			  })
			: null;
	const code = typeof errRecord?.code === 'string' ? errRecord.code : null;
	const message =
		typeof errRecord?.message === 'string' ? errRecord.message : 'Configured role failed';
	const budget = code === 'GOVERNOR_BUDGET_DENIED' || code === 'BUDGET_EXHAUSTED';
	const state: RuntimeStateName = budget ? 'BUDGET_EXHAUSTED' : 'BLOCKED';
	const modelOps = runtime.runtimeStore.database
		.prepare('SELECT operation_id FROM model_operations WHERE run_id = ? ORDER BY operation_id')
		.all(snapshot.runId)
		.map((r) => String(r.operation_id ?? ''));

	const metadata = errRecord?.metadata ? { ...errRecord.metadata } : {};
	const operationId =
		snapshot.activeModelOperationId ??
		(typeof metadata.operationId === 'string' ? metadata.operationId : undefined);

	return runtime.transition(snapshot, {
		to: state,
		eventType: 'RUN_BLOCKED',
		causalId: operationId ?? `model-blocked-${snapshot.runtimeRevision}`,
		updates: {
			modelOperations: modelOps.length > 0 ? modelOps : snapshot.modelOperations,
			blockedReason: code ?? 'MODEL_OUTPUT_INVALID',
			lastError: {
				code: code ?? 'MODEL_OUTPUT_INVALID',
				message,
				metadata,
			},
		},
		payload: {
			operationId,
			reason: code ?? 'MODEL_OUTPUT_INVALID',
			metadata,
		},
	});
}
