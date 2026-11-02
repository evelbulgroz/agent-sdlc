import {
	EvidenceReceiptSchema, EvidenceReportSchema, InvocationRecordSchema, type InvocationRecord,
} from '../policy/contracts/quality-schema.ts';
import { z } from 'zod';
import type { EvidenceCompletion, EvidenceReservation } from '../host/evidence-types.ts';
import { sha256 } from '../policy/contracts.ts';
import { qualityFailure, type QualityStorage } from './quality-storage.ts';

export function createQualityInvocations(storage: QualityStorage) {
	const { ctx } = storage;
	function getEvidenceCompletion(runId: string, operationId: string): EvidenceCompletion | null {
		return storage.get(runId, 'completion', operationId);
	}
	function getInvocation(runId: string, operationId: string): InvocationRecord | null {
		const completion = getEvidenceCompletion(runId, operationId);
		if (completion) return completion.invocation;
		const started = storage.get<InvocationRecord>(runId, 'invocation-start', operationId);
		const record = started ?? storage.get<InvocationRecord>(runId, 'invocation', operationId);
		return record && storage.status(runId, 'invocation', operationId) === 'interrupted' ?
			{ ...record, status: 'interrupted', failureReason: 'EXECUTION_INTERRUPTED' } : record;
	}
	function reserveInvocation(runId: string, input: InvocationRecord): EvidenceReservation {
		const record = InvocationRecordSchema.parse(input);
		if (record.status !== 'reserved') qualityFailure('Invocation must be reserved before dispatch');
		return ctx.transaction(() => {
			const registry = storage.get<{ bindingHash: string }>(runId, 'worktree', record.worktreeRegistryId);
			if (!registry || registry.bindingHash !== record.bindingHash) qualityFailure('Invocation worktree binding mismatch');
			const existing = getInvocation(runId, record.operationId);
			const reserved = storage.get<InvocationRecord>(runId, 'invocation', record.operationId);
			if (reserved && sha256({ ...record, startedAt: reserved.startedAt }) !== sha256(reserved)) {
				qualityFailure('Invocation operation identity has changed contents');
			}
			if (!reserved) storage.put(runId, 'invocation', record.operationId, record);
			if (existing) {
				const completion = getEvidenceCompletion(runId, record.operationId);
				return { kind: 'existing', invocation: existing, ...(completion ? { completion } : {}) };
			}
			return { kind: 'reserved' };
		});
	}
	function startInvocation(runId: string, input: InvocationRecord): void {
		const record = InvocationRecordSchema.parse(input);
		ctx.transaction(() => {
			const reserved = storage.get<InvocationRecord>(runId, 'invocation', record.operationId);
			if (!reserved || record.status !== 'running' ||
				storage.status(runId, 'invocation', record.operationId) === 'interrupted' ||
				sha256({ ...record, status: 'reserved' }) !== sha256(reserved)) {
				qualityFailure('Invocation start mismatches reservation');
			}
			if (getEvidenceCompletion(runId, record.operationId)) qualityFailure('Invocation already finished');
			storage.put(runId, 'invocation-start', record.operationId, record);
		});
	}
	function completeInvocation(runId: string, completion: EvidenceCompletion): void {
		const invocation = InvocationRecordSchema.parse(completion.invocation);
		const receipt = EvidenceReceiptSchema.parse(completion.receipt);
		if (completion.report !== null) EvidenceReportSchema.parse(completion.report);
		ctx.transaction(() => {
			const reserved = storage.get<InvocationRecord>(runId, 'invocation', invocation.operationId);
			if (!reserved || !['completed', 'failed', 'interrupted'].includes(invocation.status) ||
				(storage.status(runId, 'invocation', invocation.operationId) === 'interrupted' &&
					invocation.status !== 'interrupted') ||
				receipt.operationId !== invocation.operationId ||
				receipt.requestHash !== reserved.requestHash || receipt.bindingHash !== reserved.bindingHash ||
				invocation.requestHash !== reserved.requestHash || invocation.bindingHash !== reserved.bindingHash ||
				invocation.adapterBindingHash !== reserved.adapterBindingHash ||
				receipt.adapterBindingHash !== reserved.adapterBindingHash ||
				receipt.invocationRecordHash !== sha256(invocation)) qualityFailure('Completion binding mismatch');
			if (receipt.status === 'passed' && (invocation.status !== 'completed' || !completion.report ||
				receipt.reportHash !== invocation.reportHash ||
				receipt.artifactManifestHash !== invocation.artifactManifestHash)) {
				qualityFailure('Incomplete invocation cannot produce a passed receipt');
			}
			storage.put(runId, 'completion', invocation.operationId, completion);
			storage.put(runId, 'receipt', invocation.operationId, receipt);
		});
	}
	function getReceipt(runId: string, operationId: string) {
		if (storage.invalidated(runId, 'receipt', operationId)) return null;
		return getEvidenceCompletion(runId, operationId)?.receipt ?? null;
	}
	function listEvidenceCompletions(runId: string): EvidenceCompletion[] {
		return storage.list(runId, 'completion');
	}
	function getEvidenceCompletionByReceiptHash(runId: string, receiptHash: string): EvidenceCompletion | null {
		return listEvidenceCompletions(runId).find(c => sha256(c.receipt) === receiptHash &&
			!storage.invalidated(runId, 'receipt', c.receipt.operationId)) ?? null;
	}
	function getReceiptByHash(runId: string, receiptHash: string) {
		return getEvidenceCompletionByReceiptHash(runId, receiptHash)?.receipt ?? null;
	}
	function interruptInvocations(runId: string): number {
		return ctx.transaction(() => {
			let count = 0;
			for (const record of storage.list<InvocationRecord>(runId, 'invocation')) {
				if (getEvidenceCompletion(runId, record.operationId) ||
					storage.status(runId, 'invocation', record.operationId) === 'interrupted') continue;
				storage.status(runId, 'invocation', record.operationId, 'interrupted');
				const row = z.object({ ledger_json: z.string() }).optional().parse(
					ctx.database.prepare('SELECT ledger_json FROM quality_budgets WHERE run_id=?').get(runId));
				if (row) {
					const ledger = JSON.parse(row.ledger_json) as {
						revision: number; reservations: { operationId: string; status: string }[];
					};
					const reservation = ledger.reservations.find(r => r.operationId === record.operationId);
					if (reservation && reservation.status !== 'interrupted') {
						reservation.status = 'interrupted';
						ledger.revision += 1;
						ctx.database.prepare('UPDATE quality_budgets SET ledger_json=? WHERE run_id=?')
							.run(JSON.stringify(ledger), runId);
					}
				}
				count += 1;
			}
			return count;
		});
	}
	return { reserveInvocation, startInvocation, completeInvocation, getInvocation, getReceipt,
		getEvidenceCompletion, listEvidenceCompletions, getEvidenceCompletionByReceiptHash,
		getReceiptByHash, interruptInvocations };
}
