// Planning nodes: task plan, policy gate, and plan-critic interrupt.

import { interrupt } from '@langchain/langgraph';
import {
	createAuthorizationInterrupt,
	createPlanCriticInterrupt,
	validatePendingResponse,
} from '../../cli/hitl.ts';
import { type RuntimeState, type TaskManifest, validateTaskManifest } from '../../policy/contracts.ts';
import { SdlcError } from '../../policy/errors.ts';
import { evaluatePolicyGate } from '../../policy/policy-gate.ts';
import { planTaskDag } from '../../policy/task-planner.ts';
import { latestPhaseReview } from '../../review/critic-budget.ts';
import { runPlanCritic } from '../../review/critic-gate.ts';
import {
	type GraphStateValues,
	type WorkflowRuntimeLike,
	blockForGovernorError,
	deferUnavailableCritic,
	getAndValidateAuthorization,
} from '../node-helpers.ts';
import { taskManifestHash } from '../specification.ts';

export function readBoundTaskManifest(
	runtime: WorkflowRuntimeLike,
	snapshot: Readonly<RuntimeState>,
): Readonly<TaskManifest> | null {
	if (!snapshot.taskManifestArtifact) return null;
	let manifest: Record<string, unknown>;
	try {
		manifest = runtime.artifactStore.readJson(snapshot.taskManifestArtifact);
	} catch (error: unknown) {
		const errRec = error && typeof error === 'object' ? (error as { code?: unknown }) : null;
		if (errRec?.code === 'ARTIFACT_CORRUPT') {
			throw new SdlcError(
				'INVALID_CONTRACT',
				'Persisted task manifest bytes do not match the approved manifest artifact',
				{ taskManifestHash: snapshot.taskManifestHash },
				{ cause: error },
			);
		}
		throw error;
	}
	const actualHash = taskManifestHash(manifest);
	if (actualHash !== snapshot.taskManifestHash) {
		throw new SdlcError(
			'INVALID_CONTRACT',
			'Persisted task manifest does not match the approved task manifest hash',
			{
				expectedTaskManifestHash: snapshot.taskManifestHash,
				actualTaskManifestHash: actualHash,
			},
		);
	}
	return validateTaskManifest(manifest);
}

export function createPlanTasksNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced };
		const auth = getAndValidateAuthorization(runtime, snapshot);
		const draft = runtime.artifactStore.readJson(snapshot.draftArtifact);
		const taskManifest = readBoundTaskManifest(runtime, snapshot);
		const plan = planTaskDag({
			draft,
			taskManifest,
			authorization: auth,
			now: runtime.now,
		});
		runtime.runtimeStore.saveTaskPlan(plan);
		const planArtifact = runtime.artifactStore.writeJson('task-plan', plan);
		const next = runtime.transition(snapshot, {
			to: 'EVALUATING_POLICY',
			eventType: 'TASK_PLAN_GENERATED',
			causalId: `plan-tasks-${snapshot.runtimeRevision}`,
			updates: {
				taskPlanHash: plan.planPolicyHash,
			},
			payload: {
				taskPlanArtifact: planArtifact,
				taskPlanHash: plan.planPolicyHash,
				taskCount: plan.tasks.length,
				isParallel: plan.isParallel,
			},
		});
		await runtime.onBoundary('task_plan_transition_recorded', {
			runId: next.runId,
			runtimeRevision: next.runtimeRevision,
		});
		return { snapshot: next };
	};
}

export function createEvaluatePolicyGateNode(runtime: WorkflowRuntimeLike) {
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
		try {
			evaluatePolicyGate({
				taskPlan: plan,
				authorization: auth,
				rootDir: runtime.rootDir,
			});
		} catch (error: unknown) {
			const rec =
				error && typeof error === 'object'
					? (error as { code?: unknown; message?: unknown })
					: null;
			const code =
				typeof rec?.code === 'string' && rec.code.length > 0
					? rec.code
					: 'POLICY_VIOLATION';
			const message = error instanceof Error ? error.message : String(rec?.message ?? error);
			const next = runtime.transition(snapshot, {
				to: 'FAILED',
				eventType: 'RUN_FAILED',
				causalId: `policy-violation-${snapshot.runtimeRevision}`,
				updates: {
					lastError: {
						code,
						message,
					},
				},
				payload: { error: message },
			});
			return { snapshot: next };
		}
		const next = runtime.transition(snapshot, {
			to: 'REVIEWING_PLAN',
			eventType: 'POLICY_GATE_EVALUATED',
			causalId: `policy-gate-${snapshot.runtimeRevision}`,
			updates: {},
			payload: {
				taskPlanHash: plan.planPolicyHash,
				policyGatePassed: true,
			},
		});
		await runtime.onBoundary('policy-gate-transition-recorded', {
			runId: next.runId,
			runtimeRevision: next.runtimeRevision,
		});
		return { snapshot: next };
	};
}

export function createExecutePlanCriticNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced };
		let current = snapshot;
		const plan = runtime.runtimeStore.getTaskPlan(current.runId);
		if (!plan) {
			throw new SdlcError('TASK_PLAN_INVALID', `Task plan not found for run ${current.runId}`);
		}
		let criticResult: {
			status: string;
			hasP1: boolean;
			artifactHash: string | null | undefined;
			attemptKey: string | null;
		};
		try {
			criticResult = await runPlanCritic({ runtime, snapshot: current, plan });
		} catch (error: unknown) {
			const deferred = deferUnavailableCritic(runtime, current, 'plan', error);
			if (!deferred) {
				return { snapshot: blockForGovernorError(runtime, current, error) };
			}
			current = deferred;
			criticResult = {
				status: 'UNAVAILABLE',
				hasP1: false,
				artifactHash: current.taskPlanHash,
				attemptKey: null,
			};
		}
		const hasP1 = criticResult.hasP1 === true;
		if (hasP1) {
			const lastReview = latestPhaseReview(runtime.runtimeStore, current.runId, 'plan');
			const request = createPlanCriticInterrupt({
				runId: current.runId,
				runtimeRevision: current.runtimeRevision + 1,
				taskPlanHash: current.taskPlanHash ?? '',
				approvedPlanPolicyHash: current.approvedPlanPolicyHash ?? '',
				criticReport: lastReview
					? {
							reviewId: lastReview.reviewId,
							hasP1: lastReview.hasP1,
							findingsCount: lastReview.findingsCount,
							artifactHash: lastReview.artifactHash,
							attemptKey: lastReview.attemptKey,
						}
					: {
							hasP1: true,
							artifactHash: criticResult.artifactHash,
							attemptKey: criticResult.attemptKey,
						},
			});
			const requestArtifact = runtime.artifactStore.writeJson(
				'plan-critic-interrupt',
				request.payload,
			);
			const next = runtime.transition(current, {
				to: 'WAITING_FOR_PLAN_ACCEPTANCE',
				eventType: 'PLAN_CRITIC_COMPLETED',
				causalId: request.interruptId,
				updates: {
					pendingInterruptId: request.interruptId,
				},
				payload: {
					interruptId: request.interruptId,
					requestArtifact,
					hasP1: true,
					artifactHash: criticResult.artifactHash,
					attemptKey: criticResult.attemptKey,
				},
				effects: {
					createInterrupt: {
						interruptId: request.interruptId,
						runId: snapshot.runId,
						kind: 'plan_critic',
						stateHash: request.stateHash,
						requestArtifact,
						createdAt: runtime.now().toISOString(),
					},
				},
			});
			await runtime.onBoundary('plan-critic-interrupt-recorded', {
				runId: next.runId,
				runtimeRevision: next.runtimeRevision,
			});
			return { snapshot: next };
		}
		const next = runtime.transition(current, {
			to: 'PREPARING_WORKSPACE',
			eventType: 'PLAN_FROZEN',
			causalId: `plan-frozen-${current.runtimeRevision}`,
			updates: {
				taskPlanFrozen: true,
			},
			payload: {
				hasP1: false,
				artifactHash: criticResult.artifactHash,
				attemptKey: criticResult.attemptKey,
				approvedPlanPolicyHash: current.approvedPlanPolicyHash,
			},
		});
		await runtime.onBoundary('plan-frozen-transition-recorded', {
			runId: next.runId,
			runtimeRevision: next.runtimeRevision,
		});
		return { snapshot: next };
	};
}

export function createAskPlanCriticNode(runtime: WorkflowRuntimeLike) {
	return ({
		snapshot,
	}: GraphStateValues): { snapshot: Readonly<RuntimeState>; humanResponse: unknown } => {
		if (!snapshot.pendingInterruptId) return { snapshot, humanResponse: null };
		const pending = runtime.runtimeStore.getInterrupt(snapshot.pendingInterruptId);
		if (!pending) return { snapshot, humanResponse: null };
		const request = runtime.artifactStore.readJson(pending.requestArtifact);
		const humanResponse: unknown = interrupt(request);
		return { snapshot, humanResponse };
	};
}

export function createApplyPlanCriticNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
		humanResponse,
	}: GraphStateValues): Promise<{
		snapshot: Readonly<RuntimeState>;
		humanResponse: null;
	}> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced, humanResponse: null };
		if (!snapshot.pendingInterruptId) return { snapshot, humanResponse: null };
		const pending = runtime.runtimeStore.getInterrupt(snapshot.pendingInterruptId);
		if (!pending) return { snapshot, humanResponse: null };
		const request = runtime.artifactStore.readJson(pending.requestArtifact);
		const validated = validatePendingResponse({
			state: snapshot,
			interrupt: pending,
			request,
			response: humanResponse,
		}) as { response?: { action?: string } };
		const action = validated.response?.action;
		if (action === 'cancel') {
			const next = runtime.transition(snapshot, {
				to: 'CANCELLED',
				eventType: 'RUN_CANCELLED',
				causalId: pending.interruptId,
				updates: { pendingInterruptId: null },
				payload: { interruptId: pending.interruptId, action },
				effects: { resolveInterruptId: pending.interruptId },
			});
			return { snapshot: next, humanResponse: null };
		}
		if (action === 'reauthorize') {
			let baseCommitSha: string;
			try {
				const raw = runtime.gitCli('git', ['rev-parse', 'HEAD'], {
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
				});
				baseCommitSha = (typeof raw === 'string' ? raw : raw.toString('utf8')).trim();
			} catch {
				baseCommitSha = '0000000000000000000000000000000000000000';
			}
			const authRequest = createAuthorizationInterrupt({
				runId: snapshot.runId,
				runtimeRevision: snapshot.runtimeRevision + 1,
				approvedSpecHash: snapshot.approvedSpecHash ?? '',
				baseCommitSha,
			});
			const requestArtifact = runtime.artifactStore.writeJson(
				'authorization-interrupt',
				authRequest.payload,
			);
			const next = runtime.transition(snapshot, {
				to: 'WAITING_FOR_AUTHORIZATION',
				eventType: 'PLAN_CRITIC_COMPLETED',
				causalId: pending.interruptId,
				updates: {
					pendingInterruptId: authRequest.interruptId,
					taskPlanFrozen: false,
					taskPlanHash: null,
				},
				payload: {
					interruptId: pending.interruptId,
					action,
					requestArtifact,
				},
				effects: {
					resolveInterruptId: pending.interruptId,
					createInterrupt: {
						interruptId: authRequest.interruptId,
						runId: snapshot.runId,
						kind: 'authorization',
						stateHash: authRequest.stateHash,
						requestArtifact,
						createdAt: runtime.now().toISOString(),
					},
				},
			});
			return { snapshot: next, humanResponse: null };
		}
		const next = runtime.transition(snapshot, {
			to: 'PREPARING_WORKSPACE',
			eventType: 'PLAN_FROZEN',
			causalId: pending.interruptId,
			updates: {
				pendingInterruptId: null,
				taskPlanFrozen: true,
			},
			payload: { interruptId: pending.interruptId, action: 'accept_residual' },
			effects: { resolveInterruptId: pending.interruptId },
		});
		await runtime.onBoundary('plan-frozen-transition-recorded', {
			runId: next.runId,
			runtimeRevision: next.runtimeRevision,
		});
		return { snapshot: next, humanResponse: null };
	};
}
