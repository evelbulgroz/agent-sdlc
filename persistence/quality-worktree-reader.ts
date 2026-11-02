import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { hashTaskPlanProjection, TaskPlanV2Schema } from '../policy/contracts/dag-schema.ts';
import { ClosureRecordSchema, TaskRevisionSchema } from '../policy/contracts/quality-schema.ts';
import { sha256 } from '../policy/contracts/primitives.ts';
import { eligibleParentTasks } from '../execution/eligible-closure.ts';
import type { TaskPlanV2 } from '../policy/contracts/dag-schema.ts';
import { assertSafeQualityPath, qualityFailure } from './quality-storage.ts';

const QualityWorktreeSchema = z.strictObject({
	runId: z.string(),
	registryId: z.string(),
	kind: z.enum(['task', 'enabling', 'slice', 'final']),
	ownerId: z.string().nullable(),
	relativePath: z.string(),
	bindingHash: z.string(),
	sourceHash: z.string(),
});
type QualityWorktree = z.infer<typeof QualityWorktreeSchema>;
type SelectedDeltaTask = TaskPlanV2['tasks'][number] & {
	status: 'completed';
	parentTreeSha: string;
	targetTreeSha: string;
	patchHash: string;
};
export interface SelectedQualityPlan {
	plan: TaskPlanV2;
	tasks: SelectedDeltaTask[];
	finalTreeShas: string[];
}

export function readRegisteredQualityWorktrees(runDir: string): QualityWorktree[] {
	const databasePath = path.join(runDir, 'runtime.sqlite');
	if (!fs.existsSync(databasePath)) return [];
	let database: DatabaseSync | undefined;
	try {
		database = new DatabaseSync(databasePath, { readOnly: true });
		const rows = z.array(z.object({ record_json: z.string() })).parse(database.prepare(
			"SELECT record_json FROM quality_records WHERE kind='worktree' ORDER BY record_id",
		).all());
		return rows.map(row => QualityWorktreeSchema.parse(JSON.parse(row.record_json)));
	} catch {
		return [];
	} finally {
		database?.close();
	}
}

export function registeredWorktreePaths(runDir: string): string[] {
	return readRegisteredQualityWorktrees(runDir).map(record => {
		return assertSafeQualityPath(runDir, record.relativePath);
	});
}

export function isCheckpointWorktree(runDir: string, candidate: string): boolean {
	return readRegisteredQualityWorktrees(runDir).some(record =>
		record.kind !== 'task' && path.resolve(runDir, record.relativePath) === path.resolve(candidate));
}

export function readSelectedQualityPlan(runDir: string, runId: string): SelectedQualityPlan | null {
	const databasePath = path.join(runDir, 'runtime.sqlite');
	if (!fs.existsSync(databasePath)) return null;
	let database: DatabaseSync | undefined;
	try {
		database = new DatabaseSync(databasePath, { readOnly: true });
		const qualityTable = z.object({ name: z.literal('quality_records') }).optional().parse(database.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='quality_records'",
		).get());
		if (!qualityTable) return null;
		const planRow = z.object({ record_json: z.string() }).optional().parse(database.prepare(
			"SELECT record_json FROM quality_records WHERE run_id=? AND kind='task-plan' AND record_id=?",
		).get(runId, runId));
		if (!planRow) return null;
		const rawPlan: unknown = JSON.parse(planRow.record_json);
		const versionRecord = z.object({ schemaVersion: z.unknown() }).passthrough().parse(rawPlan);
		if (versionRecord.schemaVersion !== '2.0.0') return null;
		const plan = TaskPlanV2Schema.parse(rawPlan);
		if (plan.runId !== runId) qualityFailure('Archived quality plan belongs to a different run');
		const planHash = hashTaskPlanProjection(plan);
		const corrections = z.array(z.object({ status: z.string().nullable() })).parse(database.prepare(
			"SELECT status FROM quality_records WHERE run_id=? AND kind='correction'",
		).all(runId));
		if (corrections.some(correction => correction.status !== 'completed')) {
			qualityFailure('Cannot archive a quality run with an incomplete correction');
		}
		const rows = z.array(z.object({
			task_id: z.string(), execution_revision: z.number().int(), eligible: z.number().int(), record_json: z.string(),
		})).parse(database.prepare(`
			SELECT c.task_id,c.execution_revision,c.eligible,r.record_json
			FROM quality_current_revisions c
			JOIN quality_records r ON r.run_id=c.run_id AND r.kind='revision'
				AND r.record_id=c.task_id || ':' || c.execution_revision
			WHERE c.run_id=? ORDER BY c.task_id
		`).all(runId));
		if (rows.length !== plan.tasks.length || rows.some(row => row.eligible !== 1)) {
			qualityFailure('Cannot archive a quality run without every eligible selected revision');
		}
		const revisions = new Map(rows.map(row => {
			const revision = TaskRevisionSchema.parse(JSON.parse(row.record_json));
			if (revision.runId !== runId || revision.taskId !== row.task_id ||
				revision.executionRevision !== row.execution_revision || revision.taskPlanHash !== planHash ||
				revision.status !== 'completed' || !revision.targetTreeSha || !revision.patchHash) {
				qualityFailure(`Selected revision for '${row.task_id}' is not a completed plan-bound delta`);
			}
			return [row.task_id, revision];
		}));
		const tasks = plan.integrationOrder.map((taskId): SelectedDeltaTask => {
			const task = plan.tasks.find(entry => entry.taskId === taskId);
			const revision = revisions.get(taskId);
			if (!task || !revision || !revision.targetTreeSha || !revision.patchHash) {
				qualityFailure(`Missing selected quality task '${taskId}'`);
			}
			const parentRevisionSetHash = sha256(eligibleParentTasks(plan, taskId).map(parent => {
				const selected = revisions.get(parent.taskId);
				if (!selected) qualityFailure(`Missing selected parent '${parent.taskId}'`);
				return { taskId: selected.taskId, executionRevision: selected.executionRevision, patchHash: selected.patchHash };
			}));
			if (revision.parentRevisionSetHash !== parentRevisionSetHash) {
				qualityFailure(`Selected revision for '${taskId}' has stale parent provenance`);
			}
			return {
				...task,
				status: 'completed',
				parentTreeSha: revision.parentTreeSha,
				targetTreeSha: revision.targetTreeSha,
				patchHash: revision.patchHash,
			};
		});
		const closureRows = z.array(z.object({ record_json: z.string(), status: z.string().nullable() })).parse(
			database.prepare("SELECT record_json,status FROM quality_records WHERE run_id=? AND kind='closure'").all(runId));
		const finalTreeShas = closureRows.flatMap(row => {
			const closure = ClosureRecordSchema.parse(JSON.parse(row.record_json));
			if (closure.binding.checkpointKind !== 'final' || closure.binding.taskPlanHash !== planHash ||
				row.status === 'invalidated' || closure.status === 'invalidated' ||
				closure.selectedRevisions.length !== revisions.size || !closure.selectedRevisions.every(selected => {
					const current = revisions.get(selected.taskId);
					return current?.executionRevision === selected.executionRevision && current.patchHash === selected.patchHash;
				})) return [];
			return [closure.binding.treeSha];
		});
		return { plan, tasks, finalTreeShas };
	} finally {
		database?.close();
	}
}
