import {
	BudgetLedgerSchema, BudgetReservationSchema, QualityPolicySchema,
	type BudgetLedger, type QualityPolicy,
} from '../policy/contracts/quality-schema.ts';
import { z } from 'zod';
import { sha256 } from '../policy/contracts.ts';
import { qualityFailure, type QualityStorage } from './quality-storage.ts';

export type QualityReservation = BudgetLedger['reservations'][number];
export type QualityUsage = Partial<BudgetLedger['counters']>;
const QaIntentSchema = z.strictObject({
	governorOperationId: z.string().min(1),
	physicalCalls: z.number().int().positive().safe(),
	inputTokens: z.number().int().positive().safe(),
	outputTokens: z.number().int().positive().safe(),
});

export function createQualityBudget(storage: QualityStorage) {
	const { ctx } = storage;
	function getBudget(runId: string): BudgetLedger | null {
		ctx.assertOpen();
		const row = z.object({ ledger_json: z.string() }).optional().parse(
			ctx.database.prepare('SELECT ledger_json FROM quality_budgets WHERE run_id=?').get(runId));
		return row ? BudgetLedgerSchema.parse(JSON.parse(row.ledger_json)) : null;
	}
	function budgetHash(runId: string): string {
		const budget = getBudget(runId);
		if (!budget) qualityFailure('Quality budget is not initialized');
		return sha256(budget);
	}
	function policy(runId: string): QualityPolicy {
		const row = z.object({ policy_json: z.string() }).optional().parse(
			ctx.database.prepare('SELECT policy_json FROM quality_budgets WHERE run_id=?').get(runId));
		if (!row) qualityFailure('Quality budget is not initialized');
		return QualityPolicySchema.parse(JSON.parse(row.policy_json));
	}
	function initializeBudget(input: BudgetLedger, policyInput: QualityPolicy): BudgetLedger {
		const ledger = BudgetLedgerSchema.parse(input);
		const frozen = QualityPolicySchema.parse(policyInput);
		if (sha256(frozen) !== ledger.qualityPolicyHash) qualityFailure('Quality policy hash mismatch');
		return ctx.transaction(() => {
			const existing = getBudget(ledger.runId);
			storage.put(ledger.runId, 'budget-initial', ledger.runId, { ledger, policy: frozen });
			if (existing) return existing;
			ctx.database.prepare('INSERT INTO quality_budgets VALUES (?,?,?)')
				.run(ledger.runId, JSON.stringify(ledger), JSON.stringify(frozen));
			return ledger;
		});
	}
	function save(ledger: BudgetLedger): BudgetLedger {
		BudgetLedgerSchema.parse(ledger);
		ctx.database.prepare('UPDATE quality_budgets SET ledger_json=? WHERE run_id=?')
			.run(JSON.stringify(ledger), ledger.runId);
		return ledger;
	}
	function exceeds(ledger: BudgetLedger, frozen: QualityPolicy): boolean {
		const c = ledger.counters;
		return c.executionInvocations > frozen.execution.maxInvocations ||
			c.executionDurationMs > frozen.execution.maxTotalDurationMs ||
			c.logicalDispatches > frozen.review.maxLogicalDispatches ||
			c.physicalCalls > frozen.review.maxPhysicalCalls ||
			c.inputTokens > frozen.review.maxInputTokens || c.outputTokens > frozen.review.maxOutputTokens;
	}
	function reserveBudget(runId: string, input: QualityReservation,
		qaIntent?: z.infer<typeof QaIntentSchema>): BudgetLedger {
		const reservation = BudgetReservationSchema.parse(input);
		if (reservation.status !== 'reserved') qualityFailure('New reservation must be reserved');
		return ctx.transaction(() => {
			if (qaIntent) storage.put(runId, 'qa-dispatch-intent', input.operationId, QaIntentSchema.parse(qaIntent));
			const ledger = getBudget(runId);
			if (!ledger) qualityFailure('Quality budget is not initialized');
			const existing = ledger.reservations.find(r => r.operationId === reservation.operationId);
			if (existing) {
				if (sha256({ ...existing, status: 'reserved' }) !== sha256(reservation)) {
					qualityFailure('Budget operation identity collision');
				}
				return ledger;
			}
			const frozen = policy(runId);
			if (exceeds(ledger, frozen)) qualityFailure('Quality budget exhausted');
			const stableCheckpoint = (id: string): string => {
				const closure = storage.list<{ binding: { checkpointId: string; checkpointKind: string; ownerId: string | null } }>(
					runId, 'closure').find(c => c.binding.checkpointId === id);
				if (!closure) return id;
				return closure.binding.checkpointKind === 'final' ? 'final' :
					`${closure.binding.checkpointKind}:${closure.binding.ownerId}`;
			};
			const allocation = stableCheckpoint(reservation.checkpointId);
			const checkpoint = ledger.reservations.filter(r => stableCheckpoint(r.checkpointId) === allocation);
			const candidate = checkpoint.filter(r => r.candidateRevision === reservation.candidateRevision);
			if (reservation.kind === 'follow-up' &&
				candidate.filter(r => r.kind === 'follow-up').length >= frozen.followUpDispatches) {
				qualityFailure('Quality follow-up budget exhausted');
			}
			if (reservation.kind === 'review' && checkpoint.filter(r => r.kind === 'review').length >=
				1 + frozen.additionalCandidateReviews) qualityFailure('Quality candidate review budget exhausted');
			ledger.reservations.push(reservation);
			if (reservation.kind === 'execution') ledger.counters.executionInvocations += 1;
			else ledger.counters.logicalDispatches += 1;
			if (exceeds(ledger, frozen)) qualityFailure('Quality budget exhausted');
			ledger.revision += 1;
			return save(ledger);
		});
	}
	function chargeBudget(runId: string, operationId: string, usage: QualityUsage,
		status: 'consumed' | 'interrupted' = 'consumed'): BudgetLedger {
		return ctx.transaction(() => {
			const ledger = getBudget(runId);
			if (!ledger) qualityFailure('Quality budget is not initialized');
			const reservation = ledger.reservations.find(r => r.operationId === operationId);
			if (!reservation) qualityFailure('Quality charge has no reservation');
			const existing = storage.get(runId, 'charge', operationId);
			storage.put(runId, 'charge', operationId, { usage, status });
			if (existing) return ledger;
			for (const [key, value] of Object.entries(usage)) {
				if (!(key in ledger.counters) || !Number.isSafeInteger(value) || value < 0 ||
					key === 'executionInvocations' || key === 'logicalDispatches') {
					qualityFailure('Invalid quality budget usage');
				}
				ledger.counters[key as keyof QualityUsage] += value;
			}
			reservation.status = status;
			ledger.revision += 1;
			// Actual overrun remains charged; reserveBudget refuses subsequent dispatch.
			return save(ledger);
		});
	}
	function getQaDispatchIntent(runId: string, operationId: string) {
		const intent = storage.get(runId, 'qa-dispatch-intent', operationId);
		return intent ? QaIntentSchema.parse(intent) : null;
	}
	return { initializeBudget, getBudget, budgetHash, reserveBudget, chargeBudget, getQaDispatchIntent };
}
