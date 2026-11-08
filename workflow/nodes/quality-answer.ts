import { interrupt } from '@langchain/langgraph';
import { QualityAnswerSchema } from '../../policy/contracts/quality-schema.ts';
import { sha256, type RuntimeState } from '../../policy/contracts.ts';
import { SdlcError } from '../../policy/errors.ts';
import { type GraphStateValues, type WorkflowRuntimeLike } from '../node-helpers.ts';
import { resumeAfterQualityRefutation } from '../qa-delivery.ts';
import { runApprovedQualityCorrection } from '../quality-correction-runner.ts';
import { preflightQualityAnswer } from '../quality-answer-preflight.ts';

export function createAskQualityAnswerNode(runtime: WorkflowRuntimeLike) {
	return async ({ snapshot }: GraphStateValues) => {
		const pending = runtime.runtimeStore.getPendingInterrupt(snapshot.runId);
		if (!pending || pending.kind !== 'quality_review') {
			const consumed = snapshot.pendingInterruptId
				? runtime.runtimeStore.quality.getConsumedAnswer(snapshot.runId, snapshot.pendingInterruptId) : null;
			if (consumed) return { snapshot, humanResponse: consumed.answer };
			throw new SdlcError('INVALID_TRANSITION', 'Quality answer requires its pending interrupt');
		}
		const request = runtime.artifactStore.readJson(pending.requestArtifact);
		const response: unknown = interrupt({
			kind: 'quality_review', interruptId: pending.interruptId,
			stateHash: pending.stateHash, request,
		});
		return { snapshot, humanResponse: response };
	};
}

export function createApplyQualityAnswerNode(runtime: WorkflowRuntimeLike) {
	const apply = applyQualityAnswer(runtime);
	return async (input: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		const current = runtime.runtimeStore.getRun(input.snapshot.runId);
		if (current.lastError?.metadata?.qualityRecoveryAllowed === false ||
			(current.pendingInterruptId && runtime.runtimeStore.quality.isAnswerRecoveryHalted(
				current.runId, current.pendingInterruptId))) return { snapshot: current };
		try {
			return await apply(input);
		} catch (error: unknown) {
			const answer = QualityAnswerSchema.safeParse(input.humanResponse);
			const consumed = answer.success
				? runtime.runtimeStore.quality.getConsumedAnswer(current.runId, answer.data.interruptId) : null;
			if (answer.success && consumed?.answerHash === sha256(answer.data)) {
				const message = error instanceof Error ? error.message : String(error);
				const deterministic = error instanceof SdlcError && [
					'INVALID_INPUT', 'INVALID_CONTRACT', 'POLICY_VIOLATION', 'STORE_RECONCILIATION_FAILED',
					'PATH_CONTAINMENT_VIOLATION', 'RECONCILIATION_CONFLICT', 'WORKTREE_FAILED',
				].includes(error.code);
				const attempts = runtime.runtimeStore.quality.recordAnswerRecoveryFailure(
					current.runId, answer.data.interruptId, message, deterministic);
				const latest = runtime.runtimeStore.getRun(current.runId);
				runtime.transition(latest, {
					to: 'BLOCKED', eventType: 'RUN_BLOCKED',
					causalId: `quality-answer-recovery-${answer.data.answerId}-${attempts}`,
					updates: { lastError: { code: 'QUALITY_ANSWER_RECOVERY_FAILED', message,
						metadata: { qualityRecoveryAllowed: !deterministic && attempts < 3, attempts,
							interruptId: answer.data.interruptId } } },
					payload: { answerId: answer.data.answerId, attempts, deterministic },
				});
			}
			throw error;
		}
	};
}

function applyQualityAnswer(runtime: WorkflowRuntimeLike) {
	return async ({ snapshot: inputSnapshot, humanResponse }: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		let snapshot = inputSnapshot;
		const answer = QualityAnswerSchema.parse(humanResponse);
		const quality = runtime.runtimeStore.quality;
		const consumed = quality.getConsumedAnswer(snapshot.runId, answer.interruptId);
		if (consumed && consumed.answerHash !== sha256(answer)) {
			throw new SdlcError('INVALID_INPUT', 'Consumed quality answer changed');
		}
		if (consumed) {
			const current = runtime.runtimeStore.getRun(snapshot.runId);
			if (current.runtimeRevision > snapshot.runtimeRevision) {
				if (!current.pendingInterruptId) return { snapshot: current };
				snapshot = current;
			}
		}
		const correctionId = `correction-${sha256(answer).slice(0, 40)}`;
		const recovery = runtime.runtimeStore.quality.getCorrection(snapshot.runId, correctionId);
		if (recovery && answer.action === 'approve-correction') {
			if (recovery.answerHash !== sha256(answer) || recovery.binding.bindingHash !== answer.bindingHash) {
				throw new SdlcError('INVALID_INPUT', 'Correction replay binding changed');
			}
			return { snapshot: await runApprovedQualityCorrection({ runtime, snapshot, answer, correctionId }) };
		}
		const pending = consumed
			? runtime.runtimeStore.getInterrupt(answer.interruptId)
			: runtime.runtimeStore.getPendingInterrupt(snapshot.runId);
		if (!pending || pending.kind !== 'quality_review' || pending.interruptId !== answer.interruptId) {
			throw new SdlcError('INVALID_INPUT', 'Stale quality answer');
		}
		const request = runtime.artifactStore.readJson(pending.requestArtifact);
		const allowedActions = Array.isArray(request.allowedActions) ? request.allowedActions : [];
		if (!allowedActions.includes(answer.action)) {
			throw new SdlcError('POLICY_VIOLATION', 'Quality action is not permitted for this blocker');
		}
		const plan = runtime.runtimeStore.getTaskPlan(snapshot.runId);
		const interruptBinding = quality.getInterruptBinding(snapshot.runId, pending.interruptId);
		if (!quality || !plan || plan.schemaVersion !== '2.0.0' || !plan.slices || !plan.evidenceObligations) {
			throw new SdlcError('POLICY_VIOLATION', 'Quality answer requires its frozen v2 plan');
		}
		if (!interruptBinding) throw new SdlcError('INVALID_INPUT', 'Quality interrupt has no frozen binding');
		const expectedBindingHash = snapshot.qualityCheckpointBindingHash;
		if (!expectedBindingHash || answer.bindingHash !== expectedBindingHash) {
			throw new SdlcError('INVALID_INPUT', 'Quality answer candidate changed');
		}
		if (!consumed) preflightQualityAnswer(runtime, snapshot, answer);
		quality.consumeAnswer({
			runId: snapshot.runId, answer, expectedBindingHash,
			affectedTaskIds: interruptBinding.affectedTaskIds, correctionId,
		});
		await runtime.onBoundary('quality-answer-consumed', {
			runId: snapshot.runId, interruptId: answer.interruptId, answerHash: sha256(answer),
		});
		if (answer.action === 'approve-correction') {
			return { snapshot: await runApprovedQualityCorrection({ runtime, snapshot, answer, correctionId }) };
		}
		if (answer.action === 'refute') {
			const closure = quality.listClosures(snapshot.runId).find(entry => sha256(entry.binding) === answer.bindingHash);
			if (!closure) throw new SdlcError('INVALID_CONTRACT', 'Missing refuted checkpoint');
			quality.setClosureStatus(snapshot.runId, closure.binding.checkpointId, closure.binding.candidateRevision, 'accepted');
			if (snapshot.qualityCheckpointKind === 'final') {
				return resumeAfterQualityRefutation(runtime, snapshot, answer, request);
			}
		}
		const resumesExecution = answer.action === 'refute' && snapshot.qualityCheckpointKind === 'slice';
		return { snapshot: runtime.transition(snapshot, {
			to: resumesExecution ? 'EXECUTING_IMPLEMENTATION' : 'BLOCKED',
			eventType: 'RUN_BLOCKED', causalId: answer.answerId,
			updates: {
				pendingInterruptId: null,
				blockedReason: resumesExecution ? null
					: answer.action === 'confirm' ? 'QUALITY_CONFIRMED' : 'QUALITY_REFUTED',
				lastError: answer.action === 'confirm' && typeof request.failedCorrectionId === 'string'
					? { code: 'QUALITY_CORRECTION_HALTED', message: 'Failed correction acknowledged; further execution is not authorized',
						metadata: { qualityRecoveryAllowed: false, correctionId: request.failedCorrectionId } }
					: null,
			},
			payload: { answerHash: sha256(answer), action: answer.action,
				correctionId: answer.correction ? correctionId : null },
		}) };
	};
}
