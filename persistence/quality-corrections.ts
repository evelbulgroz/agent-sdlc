import { z } from 'zod';
import { QualityAnswerSchema, type QualityAnswer, type TaskRevision, type ClosureRecord } from '../policy/contracts/quality-schema.ts';
import { HASH_PATTERN, IDENTIFIER_PATTERN, sha256 } from '../policy/contracts/primitives.ts';
import type { createQualityBudget } from './quality-budget.ts';
import { qualityFailure, type QualityStorage } from './quality-storage.ts';

const Id = z.string().regex(IDENTIFIER_PATTERN);
const Revision = z.strictObject({ taskId: Id, executionRevision: z.number().int().nonnegative() });
const InterruptBindingSchema = z.strictObject({
	runId: z.string(), interruptId: Id, bindingHash: z.string().regex(HASH_PATTERN),
	findingIds: z.array(Id), expectedRevisions: z.array(Revision), affectedTaskIds: z.array(Id),
}).superRefine((binding, ctx) => {
	for (const items of [binding.findingIds, binding.affectedTaskIds,
		binding.expectedRevisions.map(r => r.taskId)]) {
		if (new Set(items).size !== items.length) ctx.addIssue({ code: 'custom', message: 'Duplicate binding identities' });
	}
});
export type QualityInterruptBinding = z.infer<typeof InterruptBindingSchema>;
export type CorrectionStatus = 'approved' | 'invalidated' | 'materializing' | 'executing' |
	'verifying' | 'rebuilding' | 'completed' | 'failed' | 'interrupted';
export interface QualityCorrection {
	runId: string; correctionId: string; answerId: string; answerHash: string;
	binding: QualityInterruptBinding; owners: NonNullable<QualityAnswer['correction']>['owners'];
	status: CorrectionStatus;
}
export interface ConsumeQualityAnswer {
	runId: string; answer: QualityAnswer; expectedBindingHash: string;
	affectedTaskIds: string[]; correctionId: string;
}
export interface CompleteQualityCorrection {
	runId: string; correctionId: string; expectedBudgetLedgerHash: string;
	stagedRevisions: { taskId: string; executionRevision: number }[];
	closures: { checkpointId: string; candidateRevision: number }[];
}
interface Dependencies {
	getTaskRevision(runId: string, taskId: string, revision: number): TaskRevision | null;
	getClosure(runId: string, checkpointId: string, revision: number): ClosureRecord | null;
	assertCompletedRevision(revision: TaskRevision): void;
	assertClosureReady(record: ClosureRecord, correctionId?: string): void;
	revisionId(taskId: string, revision: number): string;
	closureId(checkpointId: string, revision: number): string;
}

export function createQualityCorrections(storage: QualityStorage,
	budget: ReturnType<typeof createQualityBudget>, dependencies: Dependencies) {
	const { ctx } = storage;
	function bindInterrupt(input: QualityInterruptBinding): QualityInterruptBinding {
		const binding = InterruptBindingSchema.parse(input);
		if (binding.affectedTaskIds.some(id => !binding.expectedRevisions.some(r => r.taskId === id))) {
			qualityFailure('Interrupt binding omits affected revision provenance');
		}
		return ctx.transaction(() => {
			const row = z.object({ run_id: z.string(), status: z.string() }).optional().parse(
				ctx.database.prepare('SELECT run_id,status FROM interrupts WHERE interrupt_id=?').get(binding.interruptId));
			if (!row || row.run_id !== binding.runId || !['PENDING', 'RESPONSE_RECORDED'].includes(row.status)) {
				qualityFailure('Quality interrupt is not pending');
			}
			return storage.put(binding.runId, 'interrupt-binding', binding.interruptId, binding);
		});
	}
	function getCorrection(runId: string, correctionId: string): QualityCorrection | null {
		const record = storage.get<QualityCorrection>(runId, 'correction', correctionId);
		return record ? { ...record, status: (storage.status(runId, 'correction', correctionId) ??
			record.status) as CorrectionStatus } : null;
	}
	function getInterruptBinding(runId: string, interruptId: string): QualityInterruptBinding | null {
		return storage.get(runId, 'interrupt-binding', interruptId);
	}
	function getConsumedAnswer(runId: string, interruptId: string): { answer: QualityAnswer; answerHash: string } | null {
		const records = storage.list<{ answer: QualityAnswer; result: { answerHash: string } }>(runId, 'answer')
			.filter(record => record.answer.interruptId === interruptId);
		if (records.length > 1) qualityFailure('Quality interrupt has multiple consumed answers');
		const record = records[0];
		if (!record) return null;
		const answer = QualityAnswerSchema.parse(record.answer);
		if (sha256(answer) !== record.result.answerHash) qualityFailure('Consumed quality answer hash changed');
		return { answer, answerHash: record.result.answerHash };
	}
	function isAnswerRecoveryHalted(runId: string, interruptId: string): boolean {
		const failures = storage.list<{ interruptId: string; deterministic?: boolean }>(runId, 'answer-recovery-failure')
			.filter(record => record.interruptId === interruptId);
		return failures.length >= 3 || failures.some(record => record.deterministic);
	}
	function recordAnswerRecoveryFailure(runId: string, interruptId: string, message: string, deterministic = false): number {
		return ctx.transaction(() => {
			const prior = storage.list<{ interruptId: string }>(runId, 'answer-recovery-failure')
				.filter(record => record.interruptId === interruptId);
			const attempt = prior.length + 1;
			storage.put(runId, 'answer-recovery-failure', `${interruptId}:${attempt}`, { interruptId, attempt, message, deterministic });
			return attempt;
		});
	}
	function consumeAnswer(input: ConsumeQualityAnswer): { answerHash: string; correctionId: string | null } {
		const answer = QualityAnswerSchema.parse(input.answer);
		return ctx.transaction(() => {
			const hash = sha256(answer);
			const prior = storage.get<{ inputHash: string; result: { answerHash: string; correctionId: string | null } }>(
				input.runId, 'answer', answer.answerId);
			if (prior) {
				if (prior.inputHash !== sha256({ ...input, answer })) qualityFailure('Quality answer identity collision');
				return prior.result;
			}
			const binding = storage.get<QualityInterruptBinding>(input.runId, 'interrupt-binding', answer.interruptId);
			const interrupt = z.object({ run_id: z.string(), status: z.string() }).optional().parse(
				ctx.database.prepare('SELECT run_id,status FROM interrupts WHERE interrupt_id=?').get(answer.interruptId));
			const runtime = z.object({ state_json: z.string() }).optional().parse(
				ctx.database.prepare('SELECT state_json FROM runs WHERE run_id=?').get(input.runId));
			const activeBinding = runtime ? (JSON.parse(runtime.state_json) as {
				qualityCheckpointBindingHash?: string | null;
			}).qualityCheckpointBindingHash : null;
			if (!binding || !interrupt || interrupt.run_id !== input.runId ||
				(activeBinding != null && activeBinding !== answer.bindingHash) ||
				!['PENDING', 'RESPONSE_RECORDED'].includes(interrupt.status) ||
				binding.bindingHash !== answer.bindingHash || input.expectedBindingHash !== answer.bindingHash ||
				answer.findingIds.some(id => !binding.findingIds.includes(id)) ||
				sha256(input.affectedTaskIds) !== sha256(binding.affectedTaskIds)) {
				qualityFailure('Stale quality answer binding');
			}
			for (const revision of binding.expectedRevisions) {
				const current = z.object({ execution_revision: z.number().int(), eligible: z.number().int() }).optional().parse(ctx.database.prepare(
					'SELECT execution_revision,eligible FROM quality_current_revisions WHERE run_id=? AND task_id=?',
				).get(input.runId, revision.taskId));
				if (!current || current.eligible !== 1 || current.execution_revision !== revision.executionRevision) {
					qualityFailure('Stale quality answer revisions');
				}
			}
			if (answer.correction) {
				if (!IDENTIFIER_PATTERN.test(input.correctionId) ||
					answer.correction.expectedBudgetLedgerHash !== budget.budgetHash(input.runId)) {
					qualityFailure('Stale quality answer budget');
				}
				for (const owner of answer.correction.owners) {
					if (!binding.affectedTaskIds.includes(owner.taskId) ||
						!binding.expectedRevisions.some(r => r.taskId === owner.taskId &&
							r.executionRevision === owner.expectedRevision)) qualityFailure('Correction owner revision mismatch');
				}
				storage.put<QualityCorrection>(input.runId, 'correction', input.correctionId, {
					runId: input.runId, correctionId: input.correctionId, answerId: answer.answerId, answerHash: hash,
					binding, owners: answer.correction.owners, status: 'approved',
				});
				for (const taskId of binding.affectedTaskIds) {
					ctx.database.prepare('UPDATE quality_current_revisions SET eligible=0 WHERE run_id=? AND task_id=?')
						.run(input.runId, taskId);
				}
				const invalidate = (kind: string, id: string) => ctx.database.prepare(
					'INSERT OR IGNORE INTO quality_invalidations VALUES (?,?,?,?)',
				).run(input.runId, kind, id, input.correctionId);
				for (const revision of binding.expectedRevisions) {
					if (binding.affectedTaskIds.includes(revision.taskId)) {
						invalidate('revision', dependencies.revisionId(revision.taskId, revision.executionRevision));
						const prior = dependencies.getTaskRevision(input.runId, revision.taskId, revision.executionRevision);
						for (const hash of prior?.receiptHashes ?? []) invalidate('verification-receipt', hash);
						for (const completion of storage.list<{ receipt: { operationId: string } }>(input.runId, 'completion')) {
							if (prior?.receiptHashes.includes(sha256(completion.receipt))) {
								invalidate('receipt', completion.receipt.operationId);
							}
						}
					}
				}
				for (const closure of storage.list<ClosureRecord>(input.runId, 'closure')) {
					if (!closure.selectedRevisions.some(r => binding.affectedTaskIds.includes(r.taskId))) continue;
					invalidate('closure', dependencies.closureId(closure.binding.checkpointId, closure.binding.candidateRevision));
					for (const completion of storage.list<{ receipt: { operationId: string }; invocation: { bindingHash: string } }>(
						input.runId, 'completion')) {
						if (completion.invocation.bindingHash === sha256(closure.binding)) {
							invalidate('receipt', completion.receipt.operationId);
						}
					}
				}
				storage.status(input.runId, 'correction', input.correctionId, 'invalidated');
			}
			const result = { answerHash: hash, correctionId: answer.correction ? input.correctionId : null };
			storage.put(input.runId, 'answer', answer.answerId, { inputHash: sha256({ ...input, answer }), result, answer });
			ctx.database.prepare("UPDATE interrupts SET status='RESOLVED',resolved_at=? WHERE interrupt_id=?")
				.run(new Date().toISOString(), answer.interruptId);
			return result;
		});
	}
	function setCorrectionStatus(runId: string, correctionId: string, status: CorrectionStatus): QualityCorrection {
		return ctx.transaction(() => {
			const correction = getCorrection(runId, correctionId);
			if (!correction) qualityFailure('Correction not found');
			const order: CorrectionStatus[] = ['approved', 'invalidated', 'materializing', 'executing',
				'verifying', 'rebuilding', 'completed'];
			if (status === 'completed' || correction.status === 'completed' ||
				(status !== correction.status && status !== 'failed' && status !== 'interrupted' &&
					!(['failed', 'interrupted'].includes(correction.status) && status === 'materializing') &&
					order.indexOf(status) !== order.indexOf(correction.status) + 1)) {
				qualityFailure('Invalid correction transition');
			}
			storage.status(runId, 'correction', correctionId, status);
			return { ...correction, status };
		});
	}
	function completeCorrection(input: CompleteQualityCorrection): QualityCorrection {
		return ctx.transaction(() => {
			const correction = getCorrection(input.runId, input.correctionId);
			if (!correction) qualityFailure('Correction not found');
			const existing = storage.get(input.runId, 'correction-completion', input.correctionId);
			if (existing) {
				storage.put(input.runId, 'correction-completion', input.correctionId, input);
				return correction;
			}
			if (correction.status !== 'rebuilding' ||
				input.expectedBudgetLedgerHash !== budget.budgetHash(input.runId) ||
				new Set(input.stagedRevisions.map(r => r.taskId)).size !== input.stagedRevisions.length ||
				sha256(input.stagedRevisions.map(r => r.taskId).sort()) !==
					sha256([...correction.binding.affectedTaskIds].sort())) qualityFailure('Incomplete correction commit');
			for (const selected of input.stagedRevisions) {
				const revision = dependencies.getTaskRevision(input.runId, selected.taskId, selected.executionRevision);
				if (!revision || revision.correctionId !== input.correctionId) qualityFailure('Missing staged revision');
				dependencies.assertCompletedRevision(revision);
			}
			for (const selected of input.closures) {
				const closure = dependencies.getClosure(input.runId, selected.checkpointId, selected.candidateRevision);
				if (!closure || ['failed', 'invalidated'].includes(closure.status)) qualityFailure('Missing rebuilt closure');
				const finalStatus = closure.binding.checkpointKind === 'enabling' ||
					closure.binding.checkpointKind === 'task' ? 'verified' : 'accepted';
				const id = dependencies.closureId(selected.checkpointId, selected.candidateRevision);
				const staged = storage.get<{ correctionId: string; record: ClosureRecord }>(
					input.runId, 'staged-closure', id);
				if (!staged || staged.correctionId !== input.correctionId ||
					(storage.status(input.runId, 'staged-closure', id) ?? staged.record.status) !== finalStatus) {
					qualityFailure('Rebuilt closure lacks completed verification or adequacy review');
				}
				dependencies.assertClosureReady({ ...closure, status: finalStatus }, input.correctionId);
				for (const revision of closure.selectedRevisions) {
					const staged = input.stagedRevisions.find(r => r.taskId === revision.taskId);
					if (staged && staged.executionRevision !== revision.executionRevision) {
						qualityFailure('Rebuilt closure mixes revision selections');
					}
				}
				storage.status(input.runId, 'closure', dependencies.closureId(
					selected.checkpointId, selected.candidateRevision), finalStatus);
			}
			const invalidated = storage.list<ClosureRecord>(input.runId, 'closure')
				.filter(c => storage.invalidated(input.runId, 'closure',
					dependencies.closureId(c.binding.checkpointId, c.binding.candidateRevision)));
			for (const old of invalidated) {
				if (!input.closures.some(selected => {
					const rebuilt = dependencies.getClosure(input.runId, selected.checkpointId, selected.candidateRevision);
					return rebuilt?.binding.checkpointKind === old.binding.checkpointKind &&
						rebuilt.binding.ownerId === old.binding.ownerId;
				})) {
					qualityFailure('Correction omitted affected closure');
				}
			}
			for (const selected of input.stagedRevisions) {
				ctx.database.prepare(`INSERT INTO quality_current_revisions VALUES (?,?,?,1)
					ON CONFLICT(run_id,task_id) DO UPDATE SET execution_revision=excluded.execution_revision,eligible=1`)
					.run(input.runId, selected.taskId, selected.executionRevision);
			}
			storage.put(input.runId, 'correction-completion', input.correctionId, input);
			storage.status(input.runId, 'correction', input.correctionId, 'completed');
			return { ...correction, status: 'completed' };
		});
	}
	return { bindInterrupt, getInterruptBinding, getConsumedAnswer, recordAnswerRecoveryFailure, isAnswerRecoveryHalted,
		consumeAnswer, getCorrection, setCorrectionStatus, completeCorrection };
}
