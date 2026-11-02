import { getCheckpointQualityPolicy } from '../policy/contracts/quality-policy.ts';
import type { RuntimeState, TaskPlan } from '../policy/contracts.ts';
import { sha256 } from '../policy/contracts.ts';
import { qaCheckpointAttemptKey } from '../review/critic-budget.ts';
import type { RuntimeStore } from '../persistence/runtime-store.ts';

function currentClosure(runtimeStore: RuntimeStore, state: Readonly<RuntimeState>) {
	if (!state.qualityCheckpointBindingHash) return null;
	return runtimeStore.quality.listClosures(state.runId).find((closure) =>
		sha256(closure.binding) === state.qualityCheckpointBindingHash,
	) ?? null;
}

function projectReceiptEvidence(runtimeStore: RuntimeStore, state: Readonly<RuntimeState>, hashes: readonly string[]) {
	return hashes.map((receiptHash) => {
		const completion = runtimeStore.quality.getEvidenceCompletionByReceiptHash(state.runId, receiptHash);
		if (!completion) return { receiptHash, status: 'unavailable', cases: [] };
		return {
			receiptHash,
			status: completion.receipt.status,
			operationId: completion.receipt.operationId,
			invocationStatus: completion.invocation.status,
			reportHash: completion.invocation.reportHash,
			cases: completion.report?.cases.map((result) => ({
				file: result.file,
				caseKey: result.caseKey,
				obligationIds: result.obligationIds,
				outcome: result.outcome,
				exercisedCapabilities: result.exercisedCapabilities,
				attemptOutcomes: result.attempts.map((attempt) => attempt.outcome),
			})) ?? [],
		};
	});
}

function latestQualityEvent(runtimeStore: RuntimeStore, state: Readonly<RuntimeState>) {
	return runtimeStore.listEvents(state.runId).filter((event) =>
		event.payload.qualityCheckpointBindingHash === state.qualityCheckpointBindingHash &&
		event.payload.qualityCheckpointTreeSha === state.qualityCheckpointTreeSha &&
		['AC_COVERAGE_PASSED', 'AC_COVERAGE_FAILED', 'QA_CRITIC_COMPLETED', 'REVIEW_EVALUATED']
			.includes(event.eventType),
	).at(-1) ?? null;
}

export function projectQualityStatus(
	runtimeStore: RuntimeStore,
	state: Readonly<RuntimeState>,
): Record<string, unknown> | null {
	const taskPlan: Readonly<TaskPlan> | null = runtimeStore.getTaskPlan(state.runId);
	const policy = taskPlan ? getCheckpointQualityPolicy(taskPlan) : null;
	if (!policy) return null;
	const closure = currentClosure(runtimeStore, state);
	const policyHash = sha256(policy);
	const { attemptKey, review } = currentQualityReview(runtimeStore, state);
	const coverageEvent = runtimeStore.listEvents(state.runId).filter((event) =>
		(event.eventType === 'AC_COVERAGE_PASSED' || event.eventType === 'AC_COVERAGE_FAILED') &&
		event.payload.qualityCheckpointBindingHash === state.qualityCheckpointBindingHash &&
		event.payload.qualityCheckpointTreeSha === state.qualityCheckpointTreeSha,
	).at(-1) ?? null;
	const budget = runtimeStore.quality.getBudget(state.runId);
	const pending = runtimeStore.getPendingInterrupt(state.runId);
	const interruptBinding = pending?.kind === 'quality_review'
		? runtimeStore.quality.getInterruptBinding(state.runId, pending.interruptId)
		: null;
	const latestEvent = latestQualityEvent(runtimeStore, state);
	const humanRefutation = latestEvent?.payload.qualityHumanRefutation as Record<string, unknown> | undefined;
	return {
		bindings: {
			qualityPolicyHash: policyHash,
			approvedSpecHash: state.approvedSpecHash ?? null,
			taskPlanHash: state.taskPlanHash ?? null,
			checkpointId: state.qualityCheckpointId ?? null,
			checkpointKind: state.qualityCheckpointKind ?? null,
			sliceId: state.qualityCheckpointSliceId ?? null,
			treeSha: state.qualityCheckpointTreeSha ?? null,
			bindingHash: state.qualityCheckpointBindingHash ?? null,
			revisionSetHash: closure?.binding.revisionSetHash ?? null,
			preparationHash: closure?.binding.preparationHash ?? null,
		},
		execution: {
			status: closure?.receiptHashes.length ? 'recorded' : 'pending',
			receipts: projectReceiptEvidence(runtimeStore, state, closure?.receiptHashes ?? []),
		},
		citation: {
			cases: projectReceiptEvidence(runtimeStore, state, closure?.receiptHashes ?? [])
				.flatMap((receipt) => receipt.cases),
		},
		adequacy: {
			attemptKey,
			status: !review ? 'pending' : review.hasP1 ? 'failed' : 'reviewed',
			artifactHash: review?.artifactHash ?? null,
			hasP1: review?.hasP1 ?? null,
			coverageStatus: coverageEvent?.eventType ?? null,
			coveragePass: coverageEvent?.payload.coveragePass ?? null,
			retrievalArtifacts: latestEvent?.payload.qualityRetrievalArtifacts ?? [],
		},
		disposition: {
			closureStatus: closure?.status ?? null,
			status: humanRefutation ? 'human_refuted' : latestEvent?.payload.status ?? null,
			blockedReason: state.blockedReason ?? null,
			pendingInterruptId: pending?.kind === 'quality_review' ? pending.interruptId : null,
			interruptRequestArtifact: pending?.kind === 'quality_review' ? pending.requestArtifact : null,
			interruptBinding: interruptBinding
				? {
						bindingHash: interruptBinding.bindingHash,
						findingIds: interruptBinding.findingIds,
						affectedTaskIds: interruptBinding.affectedTaskIds,
						expectedRevisions: interruptBinding.expectedRevisions,
					}
				: null,
		},
		budget: budget
			? {
					revision: budget.revision,
					counters: budget.counters,
					reservations: budget.reservations.map((reservation) => ({
						operationId: reservation.operationId,
						kind: reservation.kind,
						checkpointId: reservation.checkpointId,
						candidateRevision: reservation.candidateRevision,
						status: reservation.status,
					})),
				}
			: null,
	};
}

export function currentQualityReview(runtimeStore: RuntimeStore, state: Readonly<RuntimeState>) {
	const closure = currentClosure(runtimeStore, state);
	const attemptKey =
		state.approvedSpecHash && state.taskPlanHash && state.qualityCheckpointKind &&
		state.qualityCheckpointTreeSha
			? qaCheckpointAttemptKey({
					approvedSpecHash: state.approvedSpecHash,
					taskPlanHash: state.taskPlanHash,
					checkpointKind: state.qualityCheckpointKind,
					sliceId: state.qualityCheckpointSliceId,
					treeSha: state.qualityCheckpointTreeSha,
				})
			: null;
	const reviewArtifactHash = closure && attemptKey ? sha256({
		attemptKey,
		bindingHash: sha256(closure.binding),
		qualityPolicyHash: closure.binding.qualityPolicyHash,
		receiptHashes: closure.receiptHashes,
	}) : null;
	const completedArtifactHash = runtimeStore.listEvents(state.runId).filter((event) =>
		event.eventType === 'QA_CRITIC_COMPLETED' &&
		event.payload.qualityCheckpointBindingHash === state.qualityCheckpointBindingHash &&
		event.payload.qualityCheckpointTreeSha === state.qualityCheckpointTreeSha &&
		event.payload.attemptKey === attemptKey,
	).at(-1)?.payload.artifactHash;
	const review = closure && attemptKey
		? runtimeStore.listCriticReviews(state.runId)
				.filter((record) => record.phase === 'qa' &&
					(record.attemptKey === attemptKey || record.attemptKey?.startsWith(`${attemptKey}:follow-up:`) ||
						record.attemptKey?.startsWith(`${attemptKey}:dispatch:`)) &&
					(record.artifactHash === reviewArtifactHash ||
						(typeof completedArtifactHash === 'string' && record.artifactHash === completedArtifactHash)))
				.at(-1) ?? null
		: null;
	return { attemptKey, review };
}
