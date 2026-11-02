import path from 'node:path';
import { z } from 'zod';
import {
	ClosureRecordSchema, type ClosureRecord, type TaskRevision,
} from '../policy/contracts/quality-schema.ts';
import { HASH_PATTERN, IDENTIFIER_PATTERN, sha256 } from '../policy/contracts/primitives.ts';
import type { StoreContext } from './run-ledger.ts';
import { createQualityBudget } from './quality-budget.ts';
import { createQualityCorrections } from './quality-corrections.ts';
import { createQualityInvocations } from './quality-invocations.ts';
import { createQualityMaterializations } from './quality-materializations.ts';
import { createQualityRevisionLifecycle } from './quality-revision-lifecycle.ts';
import { createQualityVerification } from './quality-verification.ts';
import { assertSafeQualityPath, createQualityStorage, qualityFailure } from './quality-storage.ts';

export interface QualityWorktree {
	runId: string;
	registryId: string;
	kind: 'task' | 'enabling' | 'slice' | 'final';
	ownerId: string | null;
	relativePath: string;
	bindingHash: string;
	sourceHash: string;
}

export function createQualityRecords(ctx: StoreContext, databasePath: string) {
	const storage = createQualityStorage(ctx);
	const budget = createQualityBudget(storage);
	const invocations = createQualityInvocations(storage);
	const verification = createQualityVerification(storage, databasePath);
	const revisionId = (taskId: string, revision: number) => `${taskId}:${revision}`;
	const closureId = (checkpointId: string, revision: number) => `${checkpointId}:${revision}`;
	const { saveTaskRevision, listRevisionSelections } = createQualityRevisionLifecycle(storage);
	function getTaskRevision(runId: string, taskId: string, revision: number): TaskRevision | null {
		return storage.get(runId, 'revision', revisionId(taskId, revision));
	}
	function listTaskRevisions(runId: string, taskId?: string): TaskRevision[] {
		return storage.list<TaskRevision>(runId, 'revision').filter(r => taskId === undefined || r.taskId === taskId);
	}
	function hasIncompleteCorrection(runId: string): boolean {
		return storage.list<{ correctionId: string }>(runId, 'correction').some(c =>
			storage.status(runId, 'correction', c.correctionId) !== 'completed');
	}
	function receiptEligible(runId: string, hash: string): boolean {
		if (verification.getVerificationReceipt(runId, hash)) return true;
		return storage.list<{ receipt: { operationId: string; status: string } }>(runId, 'completion').some(c =>
			sha256(c.receipt) === hash && c.receipt.status === 'passed' &&
			!storage.invalidated(runId, 'receipt', c.receipt.operationId));
	}
	function assertCompletedRevision(revision: TaskRevision): void {
		if (revision.status !== 'completed' || !revision.patchHash || !revision.targetTreeSha ||
			!revision.receiptHashes.length || !revision.receiptHashes.every(h => receiptEligible(revision.runId, h))) {
			qualityFailure('Task revision lacks current mandatory receipts');
		}
		for (const hash of revision.receiptHashes) {
			const receipt = verification.getVerificationReceipt(revision.runId, hash);
			if (receipt && (receipt.taskId !== revision.taskId ||
				receipt.executionRevision !== revision.executionRevision || receipt.treeSha !== revision.targetTreeSha)) {
				qualityFailure('Deterministic verification receipt revision binding mismatch');
			}
		}
	}
	function selectTaskRevision(runId: string, taskId: string, executionRevision: number): TaskRevision {
		return ctx.transaction(() => {
			const revision = getTaskRevision(runId, taskId, executionRevision);
			if (!revision || revision.correctionId || hasIncompleteCorrection(runId) ||
				storage.invalidated(runId, 'revision', revisionId(taskId, executionRevision))) {
				qualityFailure('Task revision is not selectable');
			}
			assertCompletedRevision(revision);
			ctx.database.prepare(`INSERT INTO quality_current_revisions VALUES (?,?,?,1)
				ON CONFLICT(run_id,task_id) DO UPDATE SET execution_revision=excluded.execution_revision,eligible=1`)
				.run(runId, taskId, executionRevision);
			return revision;
		});
	}
	function getCurrentTaskRevision(runId: string, taskId: string): TaskRevision | null {
		ctx.assertOpen();
		if (hasIncompleteCorrection(runId)) return null;
		const row = z.object({ execution_revision: z.number().int() }).optional().parse(ctx.database.prepare(
			'SELECT execution_revision FROM quality_current_revisions WHERE run_id=? AND task_id=? AND eligible=1',
		).get(runId, taskId));
		return row ? getTaskRevision(runId, taskId, row.execution_revision) : null;
	}
	function listCurrentTaskRevisions(runId: string): TaskRevision[] {
		return listTaskRevisions(runId).filter(r =>
			getCurrentTaskRevision(runId, r.taskId)?.executionRevision === r.executionRevision);
	}
	function getClosure(runId: string, checkpointId: string, revision: number): ClosureRecord | null {
		const id = closureId(checkpointId, revision);
		const staged = storage.get<{ record: ClosureRecord }>(runId, 'staged-closure', id);
		const stagedRecord = staged ? { ...staged.record, status: (staged.record.status === 'accepted' ? 'reviewing' :
			staged.record.status === 'verified' ? 'verifying' : staged.record.status) as ClosureRecord['status'] } : null;
		const record = stagedRecord ?? storage.get<ClosureRecord>(runId, 'closure', id);
		if (!record) return null;
		const status = storage.invalidated(runId, 'closure', id) ? 'invalidated' :
			storage.status(runId, 'closure', id) ?? record.status;
		return { ...record, status: status as ClosureRecord['status'] };
	}
	function listClosures(runId: string): ClosureRecord[] {
		return storage.list<ClosureRecord>(runId, 'closure').map(c => {
			const closure = getClosure(runId, c.binding.checkpointId, c.binding.candidateRevision);
			if (!closure) qualityFailure('Persisted closure disappeared');
			return closure;
		});
	}
	function assertClosureReady(record: ClosureRecord, stagedCorrectionId?: string): void {
		if (record.status !== 'accepted' && record.status !== 'verified') return;
		if (!stagedCorrectionId && hasIncompleteCorrection(record.binding.runId)) {
			qualityFailure('Correction blocks closure eligibility');
		}
		for (const selected of record.selectedRevisions) {
			const revision = getTaskRevision(record.binding.runId, selected.taskId, selected.executionRevision);
			const committedCorrection = revision?.correctionId &&
				storage.status(record.binding.runId, 'correction', revision.correctionId) === 'completed' &&
				listRevisionSelections(record.binding.runId).some(entry => entry.eligible &&
					entry.taskId === selected.taskId && entry.executionRevision === selected.executionRevision) &&
				storage.get<{ stagedRevisions: { taskId: string; executionRevision: number }[] }>(
					record.binding.runId, 'correction-completion', revision.correctionId)?.stagedRevisions.some(
					entry => entry.taskId === selected.taskId && entry.executionRevision === selected.executionRevision);
			if (!revision || revision.patchHash !== selected.patchHash ||
				storage.invalidated(record.binding.runId, 'revision', revisionId(selected.taskId, selected.executionRevision)) ||
				(revision.correctionId && revision.correctionId !== stagedCorrectionId && !committedCorrection)) {
				qualityFailure('Closure revision provenance mismatch');
			}
			assertCompletedRevision(revision);
		}
		if (!record.receiptHashes.length || !record.receiptHashes.every(h => receiptEligible(record.binding.runId, h))) {
			qualityFailure('Closure receipts are stale');
		}
		for (const hash of record.receiptHashes) {
			const completion = invocations.getEvidenceCompletionByReceiptHash(record.binding.runId, hash);
			if (completion && completion.receipt.bindingHash !== sha256(record.binding)) {
				qualityFailure('Closure receipt candidate binding mismatch');
			}
		}
	}
	function saveClosure(input: ClosureRecord): ClosureRecord {
		const record = ClosureRecordSchema.parse(input);
		return ctx.transaction(() => {
			const registry = getWorktree(record.binding.runId, record.registryId);
			if (!registry || registry.bindingHash !== sha256(record.binding)) {
				qualityFailure('Closure worktree registry binding mismatch');
			}
			assertClosureReady(record);
			return storage.put(record.binding.runId, 'closure',
				closureId(record.binding.checkpointId, record.binding.candidateRevision), record);
		});
	}
	function saveStagedClosure(correctionId: string, input: ClosureRecord): ClosureRecord {
		const record = ClosureRecordSchema.parse(input);
		return ctx.transaction(() => {
			const correction = storage.get<{ binding: { affectedTaskIds: string[] } }>(
				record.binding.runId, 'correction', correctionId);
			if (!correction || storage.status(record.binding.runId, 'correction', correctionId) === 'completed') {
				qualityFailure('Staged closure requires an active correction');
			}
			const registry = getWorktree(record.binding.runId, record.registryId);
			if (!registry || registry.bindingHash !== sha256(record.binding)) {
				qualityFailure('Staged closure worktree registry binding mismatch');
			}
			assertClosureReady(record, correctionId);
			const id = closureId(record.binding.checkpointId, record.binding.candidateRevision);
			const staged = { ...record, status: (record.status === 'verified' ? 'verifying' :
				record.status === 'accepted' ? 'reviewing' : record.status) as ClosureRecord['status'] };
			const previous = storage.get<{ correctionId: string; record: ClosureRecord }>(
				record.binding.runId, 'staged-closure', id);
			if (previous) {
				if (previous.correctionId !== correctionId ||
					sha256({ ...previous.record, status: record.status }) !== sha256(record)) {
					qualityFailure('Staged closure identity has changed contents');
				}
				const status = storage.status(record.binding.runId, 'staged-closure', id) ?? previous.record.status;
				if (status !== record.status && !(status === 'reviewing' && record.status === 'accepted') &&
					!(status === 'verifying' && record.status === 'verified')) {
					qualityFailure('Invalid staged closure transition');
				}
			} else storage.put(record.binding.runId, 'staged-closure', id, { correctionId, record });
			storage.status(record.binding.runId, 'staged-closure', id, record.status);
			if (!storage.get(record.binding.runId, 'closure', id)) storage.put(record.binding.runId, 'closure', id, staged);
			return staged;
		});
	}
	function getStagedClosure(runId: string, correctionId: string, checkpointId: string,
		candidateRevision: number): ClosureRecord | null {
		const staged = storage.get<{ correctionId: string }>(
			runId, 'staged-closure', closureId(checkpointId, candidateRevision));
		return staged?.correctionId === correctionId ? getClosure(runId, checkpointId, candidateRevision) : null;
	}
	function setClosureStatus(runId: string, checkpointId: string, revision: number,
		status: ClosureRecord['status']): ClosureRecord {
		return ctx.transaction(() => {
			const record = getClosure(runId, checkpointId, revision);
			if (!record || record.status === 'invalidated') qualityFailure('Closure is not eligible');
			const next = ClosureRecordSchema.parse({ ...record, status });
			assertClosureReady(next);
			storage.status(runId, 'closure', closureId(checkpointId, revision), status);
			return next;
		});
	}
	function registerWorktree(input: QualityWorktree): QualityWorktree {
		if (!input || Object.keys(input).sort().join(',') !==
			'bindingHash,kind,ownerId,registryId,relativePath,runId,sourceHash' ||
			!IDENTIFIER_PATTERN.test(input.registryId) ||
			!['task', 'enabling', 'slice', 'final'].includes(input.kind) ||
			(input.kind === 'final') !== (input.ownerId === null) ||
			(input.ownerId !== null && !IDENTIFIER_PATTERN.test(input.ownerId)) ||
			!HASH_PATTERN.test(input.bindingHash) || !HASH_PATTERN.test(input.sourceHash)) {
			qualityFailure('Invalid quality worktree registration');
		}
		assertSafeQualityPath(path.dirname(databasePath), input.relativePath);
		const taskPath = input.relativePath.startsWith('worktrees/') || input.relativePath === 'worktree';
		const checkpointPath = /^checkpoint-worktrees\/[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(input.relativePath);
		if ((input.kind === 'task' && !taskPath) || (input.kind !== 'task' && !taskPath && !checkpointPath)) {
			qualityFailure('Quality worktrees must be inside the run worktree container');
		}
		return storage.put(input.runId, 'worktree', input.registryId, input);
	}
	function getWorktree(runId: string, registryId: string): QualityWorktree | null {
		return storage.get(runId, 'worktree', registryId);
	}
	function listWorktrees(runId: string): QualityWorktree[] {
		return storage.list(runId, 'worktree');
	}
	const revisions = { saveTaskRevision, listRevisionSelections, getTaskRevision, listTaskRevisions, selectTaskRevision,
		getCurrentTaskRevision, listCurrentTaskRevisions, getClosure, listClosures, saveClosure,
		setClosureStatus, saveStagedClosure, getStagedClosure, registerWorktree, getWorktree, listWorktrees, hasIncompleteCorrection };
	const corrections = createQualityCorrections(storage, budget, {
		getTaskRevision, getClosure, assertCompletedRevision, assertClosureReady, revisionId, closureId,
	});
	return { ...revisions, ...budget, ...invocations, ...verification, ...corrections,
		...createQualityMaterializations(storage) };
}

export type QualityRecords = ReturnType<typeof createQualityRecords>;
