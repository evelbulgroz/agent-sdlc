import type { EvidenceRequest, InvocationRecord } from '../policy/contracts/quality-schema.ts';
import type { EvidenceCompletion, EvidenceRecordStore, EvidenceReservation } from './evidence-types.ts';

export interface EvidenceQualityPersistence {
	reserveBudget(runId: string, reservation: {
		operationId: string;
		kind: 'execution';
		checkpointId: string;
		candidateRevision: number;
		status: 'reserved';
	}): unknown;
	reserveInvocation(runId: string, invocation: InvocationRecord): EvidenceReservation;
	startInvocation(runId: string, invocation: InvocationRecord): unknown;
	completeInvocation(runId: string, completion: EvidenceCompletion): unknown;
	chargeBudget(runId: string, operationId: string, usage: { executionDurationMs: number }): unknown;
}

export interface EvidenceRuntimePersistence {
	quality: EvidenceQualityPersistence;
	transaction<T>(callback: () => T): T;
}

/** All lifecycle writes and budget charges share the runtime store's transaction boundary. */
export function createEvidenceRecordStore(
	runtimeStore: EvidenceRuntimePersistence,
	request: EvidenceRequest,
): EvidenceRecordStore {
	const runId = request.binding.runId;
	const assertOperation = (invocation: InvocationRecord) => {
		if (invocation.operationId !== request.operationId) throw new Error('evidence-store-operation-conflict');
	};
	return {
		async reserve(invocation) {
			assertOperation(invocation);
			return runtimeStore.transaction(() => {
				// Budget reservation precedes the command; an identical replay is not charged twice.
				runtimeStore.quality.reserveBudget(runId, {
					operationId: request.operationId, kind: 'execution',
					checkpointId: request.binding.checkpointId,
					candidateRevision: request.binding.candidateRevision, status: 'reserved',
				});
				return runtimeStore.quality.reserveInvocation(runId, invocation);
			});
		},
		async started(invocation) {
			assertOperation(invocation);
			runtimeStore.transaction(() => runtimeStore.quality.startInvocation(runId, invocation));
		},
		async complete(completion) {
			assertOperation(completion.invocation);
			runtimeStore.transaction(() => {
				runtimeStore.quality.chargeBudget(runId, request.operationId, {
					executionDurationMs: completion.observations.durationMs,
				});
				runtimeStore.quality.completeInvocation(runId, completion);
			});
		},
	};
}
