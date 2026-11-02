import { TaskRevisionSchema, type TaskRevision } from '../policy/contracts/quality-schema.ts';
import { z } from 'zod';
import { sha256 } from '../policy/contracts/primitives.ts';
import { qualityFailure, type QualityStorage } from './quality-storage.ts';

export interface RevisionSelection {
	taskId: string;
	executionRevision: number;
	eligible: boolean;
}

export function createQualityRevisionLifecycle(storage: QualityStorage) {
	function saveTaskRevision(input: TaskRevision): TaskRevision {
		const revision = TaskRevisionSchema.parse(input);
		return storage.ctx.transaction(() => {
			const id = `${revision.taskId}:${revision.executionRevision}`;
			const prior = storage.get<TaskRevision>(revision.runId, 'revision', id);
			if (prior && sha256(prior) === sha256(revision)) return prior;
			if (prior && ['completed', 'invalidated', 'failed'].includes(prior.status)) {
				qualityFailure('Task revision is immutable: changed contents');
			}
			if (revision.status !== 'completed' && (revision.receiptHashes.length !== 0 ||
				(!['verifying', 'failed', 'invalidated'].includes(revision.status) &&
					(revision.targetTreeSha !== null || revision.patchHash !== null)) ||
				(revision.targetTreeSha === null) !== (revision.patchHash === null))) {
				qualityFailure('Task revision has invalid completion fields');
			}
			if (!prior) return storage.put(revision.runId, 'revision', id, revision);
			const identity = (record: TaskRevision) => ({
				schemaVersion: record.schemaVersion, runId: record.runId, taskId: record.taskId,
				executionRevision: record.executionRevision, correctionId: record.correctionId,
				taskPlanHash: record.taskPlanHash, parentTreeSha: record.parentTreeSha,
				parentRevisionSetHash: record.parentRevisionSetHash,
			});
			if (sha256(identity(prior)) !== sha256(identity(revision))) {
				qualityFailure('Task revision lifecycle identity drift');
			}
			if ((prior.targetTreeSha !== null && prior.targetTreeSha !== revision.targetTreeSha) ||
				(prior.patchHash !== null && prior.patchHash !== revision.patchHash)) {
				qualityFailure('Captured task revision identity cannot change');
			}
			const progress = ['materializing', 'executing', 'verifying', 'completed'];
			const capture = prior.status === 'verifying' && revision.status === 'verifying' &&
				prior.targetTreeSha === null && revision.targetTreeSha !== null;
			if (!capture && !['failed', 'invalidated'].includes(revision.status) &&
				progress.indexOf(revision.status) <= progress.indexOf(prior.status)) {
				qualityFailure('Invalid task revision lifecycle transition');
			}
			storage.put(revision.runId, 'revision-history', `${id}:${sha256(prior)}`, prior);
			const updated = storage.ctx.database.prepare(`UPDATE quality_records SET record_json=?,content_hash=?
				WHERE run_id=? AND kind='revision' AND record_id=? AND content_hash=?`)
				.run(JSON.stringify(revision), sha256(revision), revision.runId, id, sha256(prior));
			if (updated.changes !== 1) qualityFailure('Concurrent task revision lifecycle transition');
			return revision;
		});
	}
	function listRevisionSelections(runId: string): RevisionSelection[] {
		storage.ctx.assertOpen();
		const rows = z.array(z.object({ task_id: z.string(), execution_revision: z.number().int(),
			eligible: z.number().int() })).parse(storage.ctx.database.prepare(`SELECT task_id,execution_revision,eligible
			FROM quality_current_revisions WHERE run_id=? ORDER BY task_id`)
			.all(runId));
		return rows.map(row => ({ taskId: row.task_id, executionRevision: row.execution_revision,
			eligible: row.eligible === 1 }));
	}
	return { saveTaskRevision, listRevisionSelections };
}
