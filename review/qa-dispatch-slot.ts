import type { BudgetLedger } from '../policy/contracts/quality-schema.ts';
import { qaCheckpointReviewOperationId } from './critic-budget.ts';

export function checkpointQaDispatchSlot(input: {
	runId: string; checkpointId: string; candidateRevision: number; attemptKey: string;
}, budget: BudgetLedger, reviews: readonly { phase?: unknown; attemptKey?: unknown }[]) {
	let dispatchIndex = 0;
	while (true) {
		const dispatchAttemptKey = dispatchIndex === 0 ? input.attemptKey : `${input.attemptKey}:dispatch:${dispatchIndex}`;
		const operationId = qaCheckpointReviewOperationId({ ...input, attemptKey: dispatchAttemptKey });
		const reservation = budget.reservations.find(entry => entry.operationId === operationId);
		const completed = reviews.some(review => review.phase === 'qa' && review.attemptKey === dispatchAttemptKey);
		if (!reservation || reservation.status === 'reserved' || (reservation.status === 'consumed' && completed)) {
			return { operationId, dispatchAttemptKey, reservation };
		}
		dispatchIndex++;
	}
}
