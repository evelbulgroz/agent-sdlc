import type { RuntimeEvent, RuntimeState } from '../policy/contracts.ts';
import { sha256 } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { qaCheckpointAttemptKey } from '../review/critic-budget.ts';
import {
	getRunCheckpointQualityPolicy,
	resolveCheckpointQualityContext,
	type WorkflowRuntimeLike,
} from './node-helpers.ts';

function currentQualityEvent(
	events: readonly RuntimeEvent[],
	snapshot: Readonly<RuntimeState>,
	type: 'AC_COVERAGE_PASSED' | 'AC_COVERAGE_FAILED' | 'QA_CRITIC_COMPLETED',
): RuntimeEvent | undefined {
	return events
		.filter((event) =>
			event.eventType === type &&
			event.payload.qualityCheckpointBindingHash === snapshot.qualityCheckpointBindingHash &&
			event.payload.qualityCheckpointTreeSha === snapshot.qualityCheckpointTreeSha,
		)
		.at(-1);
}

export function assertQualityDeliveryAllowed(
	runtime: WorkflowRuntimeLike,
	snapshot: Readonly<RuntimeState>,
	expectedTreeSha = snapshot.qualityCheckpointTreeSha,
): void {
	const policy = getRunCheckpointQualityPolicy(runtime, snapshot);
	if (!policy) return;
	const context = resolveCheckpointQualityContext(runtime, snapshot, { allowAccepted: true });
	if (!context || snapshot.qualityCheckpointKind !== 'final') {
		throw new SdlcError('POLICY_VIOLATION', 'Git delivery requires final checkpoint quality review');
	}
	if (context.closure.status !== 'accepted') {
		throw new SdlcError('POLICY_VIOLATION', 'Final quality checkpoint has not been accepted');
	}
	if (!expectedTreeSha || expectedTreeSha !== snapshot.qualityCheckpointTreeSha) {
		throw new SdlcError('POLICY_VIOLATION', 'Git delivery candidate differs from the reviewed tree');
	}
	const quality = runtime.runtimeStore.quality;
	const consumed = snapshot.pendingInterruptId
		? quality.getConsumedAnswer(snapshot.runId, snapshot.pendingInterruptId) : null;
	if (snapshot.pendingInterruptId && !(consumed?.answer.action === 'refute' &&
		consumed.answer.bindingHash === snapshot.qualityCheckpointBindingHash)) {
		throw new SdlcError('POLICY_VIOLATION', 'A pending quality interrupt blocks Git delivery');
	}
	if (!quality || quality.hasIncompleteCorrection(snapshot.runId)) {
		throw new SdlcError('POLICY_VIOLATION', 'A quality correction is incomplete');
	}
	const events = runtime.runtimeStore.listEvents(snapshot.runId);
	const coveragePassed = currentQualityEvent(events, snapshot, 'AC_COVERAGE_PASSED');
	const coverageFailed = currentQualityEvent(events, snapshot, 'AC_COVERAGE_FAILED');
	if (
		!coveragePassed ||
		coveragePassed.payload.coveragePass !== true ||
		coveragePassed.payload.qualityPolicyHash !== sha256(policy) ||
		(coverageFailed && coverageFailed.runtimeRevision > coveragePassed.runtimeRevision)
	) {
		throw new SdlcError('POLICY_VIOLATION', 'Current final acceptance coverage has not passed');
	}
	const attemptKey = qaCheckpointAttemptKey({
		approvedSpecHash: snapshot.approvedSpecHash ?? '',
		taskPlanHash: snapshot.taskPlanHash ?? '',
		checkpointKind: 'final',
		treeSha: snapshot.qualityCheckpointTreeSha,
	});
	const qaCompleted = currentQualityEvent(events, snapshot, 'QA_CRITIC_COMPLETED');
	const expectedAttemptKey = attemptKey;
	const humanRefutation = [...events].reverse().find((event) => {
		if (event.eventType !== 'REVIEW_EVALUATED') return false;
		const refutation = event.payload.qualityHumanRefutation;
		return Boolean(
			refutation &&
			typeof refutation === 'object' &&
			(refutation as Record<string, unknown>).bindingHash === snapshot.qualityCheckpointBindingHash &&
			(refutation as Record<string, unknown>).attemptKey === expectedAttemptKey &&
			(refutation as Record<string, unknown>).qualityPolicyHash === sha256(policy),
		);
	});
	if (
		!(
			qaCompleted &&
			qaCompleted.payload.attemptKey === attemptKey &&
			qaCompleted.payload.status === 'PASS' &&
			qaCompleted.payload.qualityPolicyHash === sha256(policy)
		) && !humanRefutation
	) {
		throw new SdlcError('POLICY_VIOLATION', 'Current final quality review is incomplete or blocking');
	}
}
