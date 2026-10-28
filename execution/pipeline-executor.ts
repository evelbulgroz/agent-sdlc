import {
	INSERTION_POINTS,
	RUNTIME_SCHEMA_VERSION,
	createEvent,
} from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { getEvaluator } from '../review/evaluator-registry.ts';
import { getCapability } from '../roles/capability-registry.ts';
import { isDeterministicRole } from '../roles/role-registry.ts';
import {
	type ArchitecturalBoundaryViolation,
	type ExecutedRoleSummary,
	type PipelineHaltResult,
	type PipelineRuntimeLike,
	type PipelineRuntimeStoreLike,
	type PipelineSnapshotLike,
	runDeterministicAnalysisRole,
} from './pipeline-deterministic-roles.ts';

export interface LoadedPipelineRole {
	readonly roleId?: string;
	readonly role: {
		readonly roleId: string;
		readonly capabilityId: string;
		readonly evaluatorId: string;
		readonly modelProfile?: string;
		readonly [key: string]: unknown;
	};
	readonly promptPolicy: string;
}

export interface PipelineExecutorRuntime extends PipelineRuntimeLike {
	readonly registry: {
		loadPipeline(insertionPoint: string): readonly LoadedPipelineRole[];
	};
	readonly runtimeStore: PipelineRuntimeStoreLike & {
		listOptionalRoleExecutions?: (
			runId: string,
			generation: number,
			taskId: string | null,
		) => ReadonlyArray<{
			readonly roleId: string;
			readonly status: string;
			readonly summary: string;
		}>;
	};
}

export interface ExecuteRolePipelineOptions {
	readonly insertionPoint: string;
	readonly runtime: PipelineExecutorRuntime;
	readonly snapshot: PipelineSnapshotLike;
	readonly auth?: unknown;
	readonly taskId?: string | null;
	readonly generation?: number;
	readonly specSummary?: string;
	readonly acceptanceCriteria?: readonly string[];
	readonly diff?: string;
	readonly touchedFiles?: readonly string[];
	readonly testOutput?: string;
	readonly authorVendor?: string | null;
}

export type ExecuteRolePipelineResult =
	| Readonly<{
			status: 'PASS';
			executedRoles: readonly ExecutedRoleSummary[];
			findings: readonly ArchitecturalBoundaryViolation[];
	  }>
	| Readonly<PipelineHaltResult>;

export async function executeRolePipeline({
	insertionPoint,
	runtime,
	snapshot,
	taskId = null,
	generation = 0,
	diff = '',
	touchedFiles = [],
}: ExecuteRolePipelineOptions): Promise<ExecuteRolePipelineResult> {
	if (!(INSERTION_POINTS as readonly string[]).includes(insertionPoint)) {
		throw new SdlcError(
			'INVALID_CONTRACT',
			`Invalid insertion point '${insertionPoint}', must be one of: ${INSERTION_POINTS.join(', ')}`,
		);
	}

	let loadedRoles: readonly LoadedPipelineRole[] = [];
	try {
		loadedRoles = runtime.registry.loadPipeline(insertionPoint);
	} catch (error) {
		if (error instanceof SdlcError) throw error;
		const msg = error instanceof Error ? error.message : String(error);
		throw new SdlcError(
			'INVALID_CONTRACT',
			`Failed to load pipeline for insertion point '${insertionPoint}': ${msg}`,
			{},
			{ cause: error },
		);
	}

	if (!loadedRoles || loadedRoles.length === 0) {
		return Object.freeze({
			status: 'PASS',
			executedRoles: Object.freeze([]),
			findings: Object.freeze([]),
		});
	}

	const executedRoles: ExecutedRoleSummary[] = [];
	const existingRecords =
		runtime.runtimeStore.listOptionalRoleExecutions?.(snapshot.runId, generation, taskId) ?? [];

	for (const loadedRole of loadedRoles) {
		const role = loadedRole.role;
		const promptPolicy = loadedRole.promptPolicy;
		const roleId = loadedRole.roleId ?? role.roleId;

		// Idempotent resume check
		const existing = existingRecords.find((r) => r.roleId === roleId);
		if (existing) {
			executedRoles.push({
				roleId,
				insertionPoint,
				generation,
				status: existing.status,
				summary: existing.summary,
				replayed: true,
			});
			if (existing.status === 'failed') {
				return Object.freeze({
					status: 'FAIL',
					failedRole: roleId,
					summary: existing.summary,
					executedRoles: Object.freeze([...executedRoles]),
					findings: Object.freeze([]),
				});
			}
			continue;
		}

		const startTime = Date.now();

		if (isDeterministicRole(role)) {
			const capability = getCapability(role.capabilityId) as {
				buildPrompt?: (input: { promptPolicy: string }) => string;
			};
			const evaluator = getEvaluator(role.evaluatorId) as {
				evaluate(value: unknown): Record<string, unknown>;
			};

			if (roleId === 'cleaner') {
				const rawOutput = {
					status: 'PASS',
					functionalDiffsDetected: false,
					cleanedFiles: [],
					hygieneOperations: [],
				};
				let evaluated: { status?: string };
				try {
					evaluated = evaluator.evaluate(rawOutput);
				} catch (evalError) {
					const msg = evalError instanceof Error ? evalError.message : String(evalError);
					runtime.runtimeStore.saveOptionalRoleExecution?.({
						schemaVersion: RUNTIME_SCHEMA_VERSION,
						runId: snapshot.runId,
						taskId: taskId ?? null,
						roleId,
						insertionPoint,
						generation,
						status: 'failed',
						summary: `Cleaner evaluation failed: ${msg}`,
						executedAt: new Date().toISOString(),
					});
					throw evalError;
				}

				const roleStatus = evaluated.status === 'CLEANED' ? 'modified' : 'passed';
				const summary = `Cleaner executed with status ${String(evaluated.status)} (0 tokens, deterministic)`;
				runtime.runtimeStore.saveOptionalRoleExecution?.({
					schemaVersion: RUNTIME_SCHEMA_VERSION,
					runId: snapshot.runId,
					taskId: taskId ?? null,
					roleId,
					insertionPoint,
					generation,
					status: roleStatus,
					summary,
					executedAt: new Date().toISOString(),
				});

				const durationMs = Date.now() - startTime;
				const event = createEvent({
					eventType: 'OPTIONAL_ROLE_COMPLETED',
					runId: snapshot.runId,
					runtimeRevision: snapshot.runtimeRevision,
					causalId: `${snapshot.runId}${taskId ? `:${taskId}` : ''}:${roleId}:g${generation}`,
					payload: {
						taskId: taskId ?? null,
						roleId,
						insertionPoint,
						status: roleStatus,
						durationMs,
					},
					now: runtime.now(),
				});
				runtime.runtimeStore.appendEvent(event);
				await runtime.onBoundary('optional-role-recorded', {
					runId: snapshot.runId,
					taskId: taskId ?? null,
					roleId,
					generation,
				});

				executedRoles.push({
					roleId,
					insertionPoint,
					generation,
					status: roleStatus,
					summary,
					replayed: false,
				});
			} else {
				const analysis = await runDeterministicAnalysisRole({
					roleId,
					evaluator,
					diff,
					touchedFiles,
					snapshot,
					runtime,
					taskId,
					insertionPoint,
					generation,
					startTime,
					executedRoles,
				});
				if (analysis?.halt) return analysis.halt;
				if (!analysis) {
					// Generic deterministic role
					if (typeof capability.buildPrompt === 'function') {
						capability.buildPrompt({ promptPolicy });
					}
					evaluator.evaluate({});
					const summary = `${roleId} executed deterministically`;
					runtime.runtimeStore.saveOptionalRoleExecution?.({
						schemaVersion: RUNTIME_SCHEMA_VERSION,
						runId: snapshot.runId,
						taskId: taskId ?? null,
						roleId,
						insertionPoint,
						generation,
						status: 'passed',
						summary,
						executedAt: new Date().toISOString(),
					});

					executedRoles.push({
						roleId,
						insertionPoint,
						generation,
						status: 'passed',
						summary,
						replayed: false,
					});
				}
			}
		} else if (roleId === 'critic-reviewer') {
			const summary =
				'Critic-reviewer at pipelines.review is a no-op; the graph runs the spec, plan, and QA critics, and phase code is only agent-review --phase code';
			runtime.runtimeStore.saveOptionalRoleExecution?.({
				schemaVersion: RUNTIME_SCHEMA_VERSION,
				runId: snapshot.runId,
				taskId: taskId ?? null,
				roleId,
				insertionPoint,
				generation,
				status: 'passed',
				summary,
				executedAt: new Date().toISOString(),
			});
			executedRoles.push({
				roleId,
				insertionPoint,
				generation,
				status: 'passed',
				summary,
				replayed: false,
			});
		}
	}

	return Object.freeze({
		status: 'PASS',
		executedRoles: Object.freeze([...executedRoles]),
		findings: Object.freeze([]),
	});
}
