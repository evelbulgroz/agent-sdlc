// Task execution node and the prompt context built for each task.

import {
	createHighRiskReviewInterrupt,
	createReconciliationConflictInterrupt,
} from '../../cli/hitl.ts';
import { TaskExecutor } from '../../execution/task-executor.ts';
import { loadHostProfileOrFallback } from '../../host/host-profile.ts';
import { resolveCommandPolicy } from '../../host/command-policy.ts';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import type { DagTask, ManifestSlice, RuntimeState, TaskPlan } from '../../policy/contracts.ts';
import { SdlcError } from '../../policy/errors.ts';
import {
	type WorkspacePackageEntry,
	contractVerificationCommandsForTask,
	isContractPreservingRefactor,
	planTaskDag,
	scanWorkspacePackages,
} from '../../policy/task-planner.ts';
import {
	type GraphStateValues,
	type WorkflowRuntimeLike,
	blockForGovernorError,
	getAndValidateAuthorization,
} from '../node-helpers.ts';

export interface TaskPromptContext {
	sliceId: string;
	sliceGoal: string;
	acceptanceCriteria: string[];
	invariantsAndConstraints: string[];
	failureDefenses: string[];
	authoredPaths: readonly string[];
	generatedOutputs: readonly string[];
	taskDependencies: readonly string[];
	dependencyMutations: readonly unknown[];
	derivedRisk: 'high' | 'standard';
	verificationCommand: readonly string[];
	generatorCommand: readonly string[] | null;
	contractVerificationCommands?: string[][];
}

export function buildTaskPromptContexts({
	draft,
	taskPlan,
	workspacePackages = null,
	rootDir = REPOSITORY_ROOT,
}: {
	draft: {
		goal?: string;
		acceptanceCriteria?: readonly string[];
		assumptions?: readonly string[];
		invariantsAndConstraints?: readonly string[];
		failureDefenses?: readonly string[];
		nonGoals?: readonly string[];
		publicContractImpact?: string;
	};
	taskPlan: {
		tasks?: readonly DagTask[];
		slices?: readonly ManifestSlice[] | null;
	};
	workspacePackages?: { packageMap?: ReadonlyMap<string, WorkspacePackageEntry> | null } | null;
	rootDir?: string;
}): Record<string, TaskPromptContext> {
	const tasks = taskPlan.tasks ?? [];
	const preserving = isContractPreservingRefactor(draft);
	const packages = preserving
		? (workspacePackages ?? scanWorkspacePackages(rootDir))
		: null;
	const criteriaById = new Map<string, string>(
		(draft.acceptanceCriteria ?? []).map((criterion) => [
			criterion.match(/^(AC-\d+)\b/)?.[1] ?? criterion,
			criterion,
		]),
	);
	const slicesById = new Map<string, ManifestSlice>(
		(taskPlan.slices ?? []).map((slice) => [slice.sliceId, slice]),
	);
	const assumptionsById = new Map<string | undefined, string>(
		(draft.assumptions ?? []).map((assumption) => [
			String(assumption).match(/^\W*(A-\d+)\b/)?.[1],
			assumption,
		]),
	);
	return Object.fromEntries(
		tasks.map((task) => {
			const slice = task.sliceId ? slicesById.get(task.sliceId) : null;
			const criterionIds = slice?.acceptanceCriteria ?? task.acceptanceCriteria ?? [];
			const citedAssumptionIds = new Set(
				criterionIds.flatMap(
					(criterionId) =>
						(criteriaById.get(criterionId) ?? '').match(/\bA-\d+\b/g) ?? [],
				),
			);
			const citedAssumptions = [...citedAssumptionIds]
				.map((id) => assumptionsById.get(id))
				.filter((val): val is string => Boolean(val));
			const contractVerificationCommands = preserving
				? contractVerificationCommandsForTask({
						task,
						tasks,
						packageMap: packages?.packageMap ?? null,
						contractGateScripts: resolveCommandPolicy(loadHostProfileOrFallback(rootDir)).contractGateScripts,
					})
				: [];
			return [
				task.taskId,
				{
					sliceId: slice?.sliceId ?? task.sliceId ?? 'implicit-vertical',
					sliceGoal: slice?.goal ?? draft.goal ?? '',
					acceptanceCriteria: criterionIds.map(
						(criterionId) => criteriaById.get(criterionId) ?? criterionId,
					),
					invariantsAndConstraints: [
						...(draft.invariantsAndConstraints ?? []),
						...citedAssumptions.map((assumption) => `Assumption ${assumption}`),
					],
					failureDefenses: [...(draft.failureDefenses ?? [])],
					authoredPaths: task.authoredPaths ?? task.pathPrefixes ?? [],
					generatedOutputs: task.generatedOutputs ?? [],
					taskDependencies: task.dependsOn ?? [],
					dependencyMutations: task.dependencyMutations ?? [],
					derivedRisk: task.highRisk === true ? ('high' as const) : ('standard' as const),
					verificationCommand: task.verificationCommand ?? [],
					generatorCommand: task.generatorCommand ?? null,
					...(contractVerificationCommands.length > 0
						? { contractVerificationCommands }
						: {}),
				},
			];
		}),
	);
}

export function createExecuteTasksNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced };
		const auth = getAndValidateAuthorization(runtime, snapshot);
		if (snapshot.taskPlanFrozen !== true) {
			throw new SdlcError(
				'POLICY_VIOLATION',
				'execute_tasks requires taskPlanFrozen',
			);
		}
		if (
			!auth.allowedOperations?.createDetachedWorktree ||
			!auth.allowedOperations?.editIsolatedWorktree ||
			!auth.allowedOperations?.runAllowlistedCommands
		) {
			throw new SdlcError(
				'OPERATION_NOT_PERMITTED',
				'createDetachedWorktree, editIsolatedWorktree, and runAllowlistedCommands operations are required',
			);
		}
		const draft = runtime.artifactStore.readJson(snapshot.draftArtifact) as {
			goal?: string;
			touchedSurfaces?: readonly string[];
			invariantsAndConstraints?: readonly string[];
			acceptanceCriteria?: readonly string[];
			assumptions?: readonly string[];
			failureDefenses?: readonly string[];
		};
		let plan: Readonly<TaskPlan> | null = runtime.runtimeStore.getTaskPlan(snapshot.runId);
		if (!plan) {
			plan = planTaskDag({
				draft,
				authorization: auth,
				now: runtime.now(),
			});
			runtime.runtimeStore.saveTaskPlan(plan);
		}

		const executor = new TaskExecutor({
			governor: runtime.governor,
			runtimeStore: runtime.runtimeStore,
			artifactStore: runtime.artifactStore,
			roleRegistry: runtime.registry,
			execCli: runtime.execCli,
			gitCli: runtime.gitCli,
			onBoundary: runtime.onBoundary,
			rootDir: runtime.rootDir,
			runtime,
		});

		try {
			const taskPromptContexts = buildTaskPromptContexts({
				draft,
				taskPlan: plan,
			});
			await executor.executeTasks({
				taskPlan: plan,
				authorization: auth,
				snapshot,
				generation: snapshot.activeGeneration ?? 0,
				specSummary: [
					draft.goal ?? '',
					...(draft.touchedSurfaces && draft.touchedSurfaces.length > 0
						? [`Touched Surfaces:\n${draft.touchedSurfaces.join('\n')}`]
						: []),
					...(draft.invariantsAndConstraints && draft.invariantsAndConstraints.length > 0
						? [`Invariants & Constraints:\n${draft.invariantsAndConstraints.join('\n')}`]
						: []),
				].join('\n\n'),
				acceptanceCriteria: draft.acceptanceCriteria ?? [],
				taskPromptContexts,
				checkpointer: runtime.checkpointer,
			});
		} catch (error: unknown) {
			const errRec =
				error && typeof error === 'object'
					? (error as {
							code?: string;
							message?: string;
							metadata?: Record<string, unknown>;
					  })
					: null;
			const errCode = typeof errRec?.code === 'string' ? errRec.code : '';
			const errMessage =
				error instanceof Error ? error.message : String(errRec?.message ?? error);
			const modelOps = runtime.runtimeStore.database
				.prepare('SELECT operation_id FROM model_operations WHERE run_id = ? ORDER BY operation_id')
				.all(snapshot.runId)
				.map((r) => String(r.operation_id ?? ''));
			if (errCode === 'BUDGET_EXHAUSTED' || errCode.startsWith('GOVERNOR_')) {
				return {
					snapshot: blockForGovernorError(runtime, snapshot, error),
				};
			}
			if (errCode === 'RECONCILIATION_CONFLICT') {
				const rawFailingTaskId =
					errRec?.metadata?.conflictingTaskId ?? errRec?.metadata?.taskId;
				const failingTaskId =
					typeof rawFailingTaskId === 'string' ? rawFailingTaskId : '';
				const request = createReconciliationConflictInterrupt({
					runId: snapshot.runId,
					runtimeRevision: snapshot.runtimeRevision + 1,
					failingTaskId,
					conflictDetails: {
						error: errMessage,
						conflictingTaskId: failingTaskId,
					},
				});
				const requestArtifact = runtime.artifactStore.writeJson(
					'reconciliation-conflict-interrupt',
					request.payload,
				);
				const next = runtime.transition(snapshot, {
					to: 'RECONCILING_INTEGRATION',
					eventType: 'RECONCILIATION_CONFLICT_DETECTED',
					causalId: request.interruptId,
					updates: {
						modelOperations: modelOps.length > 0 ? modelOps : snapshot.modelOperations,
						activeModelOperationId: null,
						pendingInterruptId: request.interruptId,
					},
					payload: {
						interruptId: request.interruptId,
						requestArtifact,
						failingTaskId,
						conflictDetails: {
							error: errMessage,
							conflictingTaskId: failingTaskId,
						},
					},
					effects: {
						createInterrupt: {
							interruptId: request.interruptId,
							runId: snapshot.runId,
							kind: 'reconciliation_conflict',
							stateHash: request.stateHash,
							requestArtifact,
							createdAt: runtime.now().toISOString(),
						},
					},
				});
				await runtime.onBoundary('reconciliation-conflict-transition-recorded', {
					runId: next.runId,
					runtimeRevision: next.runtimeRevision,
				});
				return { snapshot: next };
			}
			if (errCode === 'HYDRATION_FAILED') {
				const next = runtime.transition(snapshot, {
					to: 'BLOCKED',
					eventType: 'RUN_BLOCKED',
					causalId: `task_hydration_failed-${snapshot.runtimeRevision}`,
					updates: {
						modelOperations: modelOps.length > 0 ? modelOps : snapshot.modelOperations,
						activeModelOperationId: null,
						blockedReason: 'HYDRATION_FAILED',
						lastError: {
							code: 'HYDRATION_FAILED',
							message: errMessage,
						},
					},
					payload: { error: errMessage },
				});
				return { snapshot: next };
			}
			if (errCode === 'REPAIR_BUDGET_EXCEEDED') {
				const blockedReason =
					errRec?.metadata?.repairReason === 'HIGH_RISK_PATH_REPAIR_PROHIBITED'
						? 'HIGH_RISK_PATH_REPAIR_PROHIBITED'
						: 'REPAIR_BUDGET_EXHAUSTED';
				const next = runtime.transition(snapshot, {
					to: 'ESCALATED',
					eventType: 'RUN_BLOCKED',
					causalId: `task_repair_escalated-${snapshot.runtimeRevision}`,
					updates: {
						modelOperations: modelOps.length > 0 ? modelOps : snapshot.modelOperations,
						activeModelOperationId: null,
						blockedReason,
						lastError: {
							code: blockedReason,
							message: errMessage,
						},
					},
					payload: {
						error: errMessage,
						taskId: errRec?.metadata?.taskId,
						failurePacketArtifact: errRec?.metadata?.failurePacketArtifact,
					},
				});
				return { snapshot: next };
			}
			const next = runtime.transition(snapshot, {
				to: 'FAILED',
				eventType: 'RUN_FAILED',
				causalId: `task_execution_failed-${snapshot.runtimeRevision}`,
				updates: {
					modelOperations: modelOps.length > 0 ? modelOps : snapshot.modelOperations,
					activeModelOperationId: null,
					lastError: {
						code: errCode || 'TASK_EXECUTION_FAILED',
						message: errMessage,
						metadata: errRec?.metadata ?? {},
					},
				},
				payload: { error: errMessage },
			});
			return { snapshot: next };
		}

		const modelOps = runtime.runtimeStore.database
			.prepare('SELECT operation_id FROM model_operations WHERE run_id = ? ORDER BY operation_id')
			.all(snapshot.runId)
			.map((r) => String(r.operation_id ?? ''));

		const authorVendor = snapshot.authorVendor ?? 'google';
		const highRiskTasks = plan.tasks.filter(
			(task) => task.highRisk && task.humanReviewEvidence !== 'satisfied',
		);
		if (highRiskTasks.length > 0) {
			const request = createHighRiskReviewInterrupt({
				runId: snapshot.runId,
				runtimeRevision: snapshot.runtimeRevision + 1,
				taskPlanHash: snapshot.taskPlanHash ?? '',
				tasks: highRiskTasks,
			});
			const requestArtifact = runtime.artifactStore.writeJson(
				'high-risk_review_interrupt',
				request.payload,
			);
			const next = runtime.transition(snapshot, {
				to: 'RECONCILING_INTEGRATION',
				eventType: 'HIGH_RISK_REVIEW_REQUESTED',
				causalId: request.interruptId,
				updates: {
					modelOperations: modelOps,
					activeModelOperationId: null,
					authorVendor,
					pendingInterruptId: request.interruptId,
				},
				payload: {
					interruptId: request.interruptId,
					requestArtifact,
					taskIds: highRiskTasks.map((task) => task.taskId),
				},
				effects: {
					createInterrupt: {
						interruptId: request.interruptId,
						runId: snapshot.runId,
						kind: 'high_risk_review',
						stateHash: request.stateHash,
						requestArtifact,
						createdAt: runtime.now().toISOString(),
					},
				},
			});
			return { snapshot: next };
		}

		const next = runtime.transition(snapshot, {
			to: 'RECONCILING_INTEGRATION',
			eventType: 'IMPLEMENTATION_COMPLETED',
			causalId: `implementer-complete-${snapshot.runtimeRevision}`,
			updates: {
				modelOperations: modelOps,
				activeModelOperationId: null,
				authorVendor,
			},
			payload: { taskCount: plan.tasks.length },
		});
		await runtime.onBoundary('implementation-completed-transition-recorded', {
			runId: next.runId,
			runtimeRevision: next.runtimeRevision,
		});
		return { snapshot: next };
	};
}
