// Authorization nodes: prepare, wait for, and apply the run authorization envelope.

import { interrupt } from '@langchain/langgraph';
import { createAuthorizationInterrupt, validatePendingResponse } from '../../cli/hitl.ts';
import { validateAuthorizationEnvelope } from '../../policy/authorization.ts';
import type { RuntimeState } from '../../policy/contracts.ts';
import type { GraphStateValues, WorkflowRuntimeLike } from '../node-helpers.ts';

function readHeadCommitSha(runtime: WorkflowRuntimeLike): string {
	try {
		const raw = runtime.gitCli('git', ['rev-parse', 'HEAD'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const text = typeof raw === 'string' ? raw : raw.toString('utf8');
		return text.trim();
	} catch {
		return '0000000000000000000000000000000000000000';
	}
}

export function createPrepareAuthorizationNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced };
		const auth = runtime.runtimeStore.getAuthorization(snapshot.runId);
		if (auth) {
			const next = runtime.transition(snapshot, {
				to: 'PLANNING_TASKS',
				eventType: 'RUN_AUTHORIZED',
				causalId: `authorized-${snapshot.runtimeRevision}`,
				updates: {
					approvedPlanPolicyHash: auth.approvedPlanPolicyHash,
					semanticRepairsCount: 0,
				},
				payload: { authorization: auth },
			});
			await runtime.onBoundary('authorization-transition-recorded', {
				runId: next.runId,
				runtimeRevision: next.runtimeRevision,
			});
			return { snapshot: next };
		}
		const baseCommitSha = readHeadCommitSha(runtime);
		const request = createAuthorizationInterrupt({
			runId: snapshot.runId,
			runtimeRevision: snapshot.runtimeRevision + 1,
			approvedSpecHash: snapshot.approvedSpecHash ?? '',
			baseCommitSha,
		});
		const requestArtifact = runtime.artifactStore.writeJson(
			'authorization-interrupt',
			request.payload,
		);
		const next = runtime.transition(snapshot, {
			to: 'WAITING_FOR_AUTHORIZATION',
			eventType: 'AUTHORIZATION_REQUESTED',
			causalId: request.interruptId,
			updates: {
				pendingInterruptId: request.interruptId,
			},
			payload: { interruptId: request.interruptId, requestArtifact },
			effects: {
				createInterrupt: {
					interruptId: request.interruptId,
					runId: snapshot.runId,
					kind: 'authorization',
					stateHash: request.stateHash,
					requestArtifact,
					createdAt: runtime.now().toISOString(),
				},
			},
		});
		await runtime.onBoundary('authorization-request-transition-recorded', {
			runId: next.runId,
			runtimeRevision: next.runtimeRevision,
		});
		return { snapshot: next };
	};
}

export function createAskAuthorizationNode(runtime: WorkflowRuntimeLike) {
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

export function createApplyAuthorizationNode(runtime: WorkflowRuntimeLike) {
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
		const validatedResult = validatePendingResponse({
			state: snapshot,
			interrupt: pending,
			request,
			response: humanResponse,
		}) as { response?: unknown; envelope?: unknown };
		const rawEnvelope = validatedResult.response ?? validatedResult.envelope;
		const envelope = validateAuthorizationEnvelope(rawEnvelope, {
			currentRunId: snapshot.runId,
			currentSpecHash: snapshot.approvedSpecHash ?? undefined,
			currentTaskManifestHash: snapshot.taskManifestHash,
			now: runtime.now(),
		});
		runtime.runtimeStore.saveAuthorization(envelope);
		const next = runtime.transition(snapshot, {
			to: 'PLANNING_TASKS',
			eventType: 'RUN_AUTHORIZED',
			causalId: pending.interruptId,
			updates: {
				pendingInterruptId: null,
				approvedPlanPolicyHash: envelope.approvedPlanPolicyHash,
				semanticRepairsCount: 0,
			},
			payload: { interruptId: pending.interruptId, authorization: envelope },
			effects: { resolveInterruptId: pending.interruptId },
		});
		await runtime.onBoundary('authorization-transition-recorded', {
			runId: next.runId,
			runtimeRevision: next.runtimeRevision,
		});
		return { snapshot: next, humanResponse: null };
	};
}
