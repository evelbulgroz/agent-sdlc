import { type RuntimeState, sha256 } from '../policy/contracts.ts';
import { QualityAnswerSchema, type QualityAnswer } from '../policy/contracts/quality-schema.ts';
import type { StoreContext } from './run-ledger.ts';
import { createQualityStorage, qualityFailure } from './quality-storage.ts';

export function assertInterruptIntegrity(ctx: StoreContext, state: Readonly<RuntimeState>): void {
	const unresolved = ctx.database.prepare(
		"SELECT interrupt_id FROM interrupts WHERE run_id=? AND status IN ('PENDING','RESPONSE_RECORDED')",
	).all(state.runId);
	const pending = state.pendingInterruptId ? ctx.database.prepare(
		'SELECT run_id,kind,status FROM interrupts WHERE interrupt_id=?',
	).get(state.pendingInterruptId) : null;
	const qualityPending = Boolean(state.pendingInterruptId && state.qualityPolicy &&
		state.blockedReason === 'QUALITY_REVIEW_BLOCKED' && pending?.kind === 'quality_review' &&
		pending.run_id === state.runId);
	let consumedRecovery = false;
	if (qualityPending && pending?.status === 'RESOLVED') {
		const storage = createQualityStorage(ctx);
		const binding = storage.get<{ bindingHash: string }>(
			state.runId, 'interrupt-binding', state.pendingInterruptId ?? '');
		const answers = storage.list<{ answer: QualityAnswer; result: { answerHash: string } }>(state.runId, 'answer')
			.filter(record => record.answer.interruptId === state.pendingInterruptId);
		const record = answers.length === 1 ? answers[0] : null;
		const answer = record ? QualityAnswerSchema.parse(record.answer) : null;
		consumedRecovery = Boolean(answer && binding && record && answer.bindingHash === binding.bindingHash &&
			sha256(answer) === record.result.answerHash);
	}
	if ((state.pendingInterruptId === null && unresolved.length !== 0) ||
		(state.pendingInterruptId !== null && !(consumedRecovery && unresolved.length === 0) &&
			(unresolved.length !== 1 || unresolved[0]?.interrupt_id !== state.pendingInterruptId))) {
		qualityFailure('Runtime state and interrupt records diverged');
	}
	const interruptStates = [
		'WAITING_FOR_ANSWERS', 'WAITING_FOR_APPROVAL', 'WAITING_FOR_AUTHORIZATION', 'WAITING_FOR_PLAN_ACCEPTANCE',
	];
	const allowed = interruptStates.includes(state.state) || qualityPending ||
		(state.state === 'RECONCILING_INTEGRATION' && state.pendingInterruptId !== null);
	if ((interruptStates.includes(state.state) && state.pendingInterruptId === null) ||
		(!allowed && state.pendingInterruptId !== null)) {
		qualityFailure('Runtime state and pending interrupt lifecycle diverged');
	}
}
