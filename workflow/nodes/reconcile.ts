// Integration reconciliation nodes and the conflict interrupt.

import { interrupt } from '@langchain/langgraph';
import { createReconciliationConflictInterrupt, validatePendingResponse } from '../../cli/hitl.ts';
import { type RuntimeState, createEvent } from '../../policy/contracts.ts';
import { SdlcError } from '../../policy/errors.ts';
import { createLocalBranch } from '../git-manager.ts';
import { hydrateWorktree } from '../hydration.ts';
import {
	type GraphStateValues,
	type WorkflowRuntimeLike,
	getAndValidateAuthorization,
	shouldDeferGitMaterialization,
} from '../node-helpers.ts';
import { reconcileTasks } from '../reconciliation.ts';

export function createReconcileIntegrationNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced };
		const auth = getAndValidateAuthorization(runtime, snapshot);
		const plan = runtime.runtimeStore.getTaskPlan(snapshot.runId);
		if (!plan) {
			throw new SdlcError('TASK_PLAN_INVALID', `Task plan not found for run ${snapshot.runId}`);
		}

		const existingEvents = runtime.runtimeStore.listEvents(snapshot.runId);
		const hasStartedReconcile = existingEvents.some(
			(e) => e.eventType === 'RECONCILIATION_STARTED',
		);
		if (!hasStartedReconcile) {
			const startReconcileEvent = createEvent({
				eventType: 'RECONCILIATION_STARTED',
				runId: snapshot.runId,
				runtimeRevision: snapshot.runtimeRevision,
				causalId: `reconcile-${snapshot.runId}`,
				payload: {
					taskCount: plan.tasks.length,
					integrationOrder: plan.integrationOrder,
				},
				now: runtime.now(),
			});
			runtime.runtimeStore.appendEvent(startReconcileEvent);
			await runtime.onBoundary('reconciliation-started-transition-recorded', {
				runId: snapshot.runId,
				runtimeRevision: snapshot.runtimeRevision,
			});
		}

		const reconcileResult = await reconcileTasks({
			runId: snapshot.runId,
			taskPlan: plan,
			authorization: auth,
			runtimeStore: runtime.runtimeStore,
			rootDir: runtime.rootDir,
			gitCli: runtime.gitCli,
			snapshot,
			taskPlanFrozen: snapshot.taskPlanFrozen,
		});

		if (reconcileResult.status === 'RECONCILIATION_CONFLICT') {
			const failingTaskId =
				reconcileResult.failingTaskId ?? reconcileResult.conflictingTaskId;
			const request = createReconciliationConflictInterrupt({
				runId: snapshot.runId,
				runtimeRevision: snapshot.runtimeRevision + 1,
				failingTaskId,
				conflictDetails: reconcileResult.conflictDetails,
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
					pendingInterruptId: request.interruptId,
					integrationWorktreePath: reconcileResult.integrationWorktreePath,
				},
				payload: {
					interruptId: request.interruptId,
					requestArtifact,
					failingTaskId,
					conflictDetails: reconcileResult.conflictDetails,
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

		let branchResult: { branchName: string; created: boolean; reused: boolean } | null = null;
		if (auth.allowedOperations?.createBranch && !shouldDeferGitMaterialization(auth)) {
			branchResult = createLocalBranch({
				worktreeDir: reconcileResult.integrationWorktreePath,
				baseCommitSha: auth.baseCommitSha,
				branchName: auth.targetBranch ?? '',
				gitCli: runtime.gitCli,
			});
			if (branchResult.created) {
				const alreadyRecorded = runtime.runtimeStore
					.listEvents(snapshot.runId)
					.some((event) => event.eventType === 'GIT_BRANCH_CREATED');
				if (!alreadyRecorded) {
					const branchEvent = createEvent({
						eventType: 'GIT_BRANCH_CREATED',
						runId: snapshot.runId,
						runtimeRevision: snapshot.runtimeRevision,
						causalId: `git-branch-created-${snapshot.runtimeRevision}`,
						payload: {
							branchName: auth.targetBranch,
							baseCommitSha: auth.baseCommitSha,
						},
						now: runtime.now(),
					});
					runtime.runtimeStore.appendEvent(branchEvent);
				}
				await runtime.onBoundary('branch-created-transition-recorded', {
					runId: snapshot.runId,
					branchName: auth.targetBranch,
				});
			}
		}

		if (plan.tasks.length > 1) {
			try {
				await hydrateWorktree({
					worktreeDir: reconcileResult.integrationWorktreePath,
					allowedPackages: auth.allowedPackages,
					runner: runtime.execCli,
				});
			} catch (error: unknown) {
				const message =
					error instanceof Error && error.message
						? error.message
						: 'Integration worktree hydration failed';
				return {
					snapshot: runtime.transition(snapshot, {
						to: 'BLOCKED',
						eventType: 'RUN_BLOCKED',
						causalId: `hydrate-integration-failed-${snapshot.runtimeRevision}`,
						updates: {
							blockedReason: 'HYDRATION_FAILED',
							lastError: {
								code: 'HYDRATION_FAILED',
								message,
							},
						},
						payload: { error: message },
					}),
				};
			}
		}

		const next = runtime.transition(snapshot, {
			to: 'SNAPSHOT_GENERATION',
			eventType: 'RECONCILIATION_COMPLETED',
			causalId: `reconcile-${snapshot.runtimeRevision}`,
			updates: {
				integrationWorktreePath: reconcileResult.integrationWorktreePath,
				worktreePath: reconcileResult.integrationWorktreePath,
				targetTreeSha: reconcileResult.reconciledTreeSha,
			},
			payload: {
				integrationWorktreePath: reconcileResult.integrationWorktreePath,
				reconciledTreeSha: reconcileResult.reconciledTreeSha,
				branchName: branchResult?.branchName ?? null,
			},
		});
		await runtime.onBoundary('reconciliation-completed-transition-recorded', {
			runId: next.runId,
			runtimeRevision: next.runtimeRevision,
		});
		return { snapshot: next };
	};
}

export function createAskReconciliationConflictNode(runtime: WorkflowRuntimeLike) {
	return ({
		snapshot,
	}: GraphStateValues): { snapshot: Readonly<RuntimeState>; humanResponse: unknown } => {
		const pending = snapshot.pendingInterruptId
			? runtime.runtimeStore.getInterrupt(snapshot.pendingInterruptId)
			: null;
		const request = runtime.artifactStore.readJson(pending?.requestArtifact);
		const humanResponse: unknown = interrupt(request);
		return { snapshot, humanResponse };
	};
}

export function createApplyReconciliationConflictNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
		humanResponse,
	}: GraphStateValues): Promise<{
		snapshot: Readonly<RuntimeState>;
		humanResponse: null;
	}> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced, humanResponse: null };
		const pending = snapshot.pendingInterruptId
			? runtime.runtimeStore.getInterrupt(snapshot.pendingInterruptId)
			: null;
		if (!pending) return { snapshot, humanResponse: null };
		const request = runtime.artifactStore.readJson(pending.requestArtifact);
		const { response: action } = validatePendingResponse({
			state: snapshot,
			interrupt: pending,
			request,
			response: humanResponse,
		}) as { response: { action?: string } };
		if (pending.kind === 'high_risk_review' && action.action === 'approve') {
			const taskPlan = runtime.runtimeStore.getTaskPlan(snapshot.runId);
			const highRiskTasks = (taskPlan?.tasks ?? []).filter((candidate) => candidate.highRisk);
			for (const task of highRiskTasks) {
				runtime.runtimeStore.updateTaskStatus(snapshot.runId, task.taskId, {
					humanReviewEvidence: 'satisfied',
				});
			}
			const next = runtime.transition(snapshot, {
				to: 'RECONCILING_INTEGRATION',
				eventType: 'HIGH_RISK_REVIEW_APPROVED',
				causalId: pending.interruptId,
				updates: { pendingInterruptId: null },
				payload: {
					interruptId: pending.interruptId,
					taskIds: highRiskTasks.map((task) => task.taskId),
				},
				effects: { resolveInterruptId: pending.interruptId },
			});
			return { snapshot: next, humanResponse: null };
		}
		if (action.action === 'cancel') {
			const next = runtime.transition(snapshot, {
				to: 'CANCELLED',
				eventType: 'RUN_CANCELLED',
				causalId: pending.interruptId,
				updates: {
					pendingInterruptId: null,
					blockedReason: 'RUN_CANCELLED',
				},
				payload: {
					interruptId: pending.interruptId,
					reason: 'Operator cancelled upon reconciliation conflict',
				},
				effects: { resolveInterruptId: pending.interruptId },
			});
			await runtime.onBoundary('conflict-terminal-transition-recorded', {
				runId: next.runId,
				runtimeRevision: next.runtimeRevision,
			});
			return { snapshot: next, humanResponse: null };
		}
		const next = runtime.transition(snapshot, {
			to: 'ESCALATED',
			eventType: 'RUN_BLOCKED',
			causalId: pending.interruptId,
			updates: {
				pendingInterruptId: null,
				blockedReason: 'RECONCILIATION_CONFLICT',
				lastError: {
					code: 'RECONCILIATION_CONFLICT',
					message: 'Reconciliation conflict detected and escalated by operator',
				},
			},
			payload: { interruptId: pending.interruptId, reason: 'RECONCILIATION_CONFLICT' },
			effects: { resolveInterruptId: pending.interruptId },
		});
		await runtime.onBoundary('conflict-terminal-transition-recorded', {
			runId: next.runId,
			runtimeRevision: next.runtimeRevision,
		});
		return { snapshot: next, humanResponse: null };
	};
}
