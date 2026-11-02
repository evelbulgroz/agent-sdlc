import { projectTaskPlan, TaskPlanV2Schema, type DagTask, type TaskPlanV2 } from '../policy/contracts/dag-schema.ts';
import { z } from 'zod';
import type { TaskRevision } from '../policy/contracts/quality-schema.ts';
import { createQualityStorage, qualityFailure } from './quality-storage.ts';
import type { StoreContext } from './run-ledger.ts';

export function staticQualityPlan(input: unknown): TaskPlanV2 | null {
	if (!input || typeof input !== 'object' ||
		(input as { schemaVersion?: unknown }).schemaVersion !== '2.0.0') return null;
	return projectTaskPlan(input);
}

export function createQualityTaskPlan(ctx: StoreContext) {
	const storage = createQualityStorage(ctx);
	function immutablePlanRecordId(runId: string, approvedPlanPolicyHash?: string): string {
		if (!approvedPlanPolicyHash) return runId;
		if (!/^[a-f0-9]{64}$/.test(approvedPlanPolicyHash)) {
			qualityFailure('Invalid approved plan policy hash for immutable task plan');
		}
		return `policy:${approvedPlanPolicyHash}`;
	}
	function getImmutableTaskPlan(runId: string, approvedPlanPolicyHash?: string): TaskPlanV2 | null {
		const key = approvedPlanPolicyHash === undefined
			? selectedPlanRecordId(runId)
			: immutablePlanRecordId(runId, approvedPlanPolicyHash);
		const record = storage.get<unknown>(runId, 'task-plan', key);
		return record === null ? null : TaskPlanV2Schema.parse(record);
	}
	function selectedPlanRecordId(runId: string): string {
		const row = z.object({ record_id: z.string() }).optional().parse(ctx.database.prepare(
			'SELECT record_id FROM quality_task_plan_selections WHERE run_id=?',
		).get(runId));
		return row?.record_id ?? runId;
	}
	function saveImmutableTaskPlan(plan: TaskPlanV2, approvedPlanPolicyHash?: string): void {
		storage.put(
			plan.runId,
			'task-plan',
			immutablePlanRecordId(plan.runId, approvedPlanPolicyHash),
			TaskPlanV2Schema.parse(plan),
		);
	}
	function selectImmutableTaskPlan(runId: string, approvedPlanPolicyHash?: string): void {
		const recordId = immutablePlanRecordId(runId, approvedPlanPolicyHash);
		if (!storage.get<unknown>(runId, 'task-plan', recordId)) {
			qualityFailure('Cannot select a missing immutable task plan');
		}
		ctx.database.prepare(`INSERT INTO quality_task_plan_selections
			(run_id,record_id,approved_plan_policy_hash) VALUES (?,?,?)
			ON CONFLICT(run_id) DO UPDATE SET
				record_id=excluded.record_id,
				approved_plan_policy_hash=excluded.approved_plan_policy_hash`)
			.run(runId, recordId, approvedPlanPolicyHash ?? null);
	}
	function isSelectedTaskPlan(runId: string, approvedPlanPolicyHash?: string): boolean {
		return selectedPlanRecordId(runId) === immutablePlanRecordId(runId, approvedPlanPolicyHash);
	}
	function hydrateTask(runId: string, task: Readonly<DagTask>): Readonly<DagTask> {
		const frozen = getImmutableTaskPlan(runId);
		if (!frozen) return task;
		const approved = frozen.tasks.find(t => t.taskId === task.taskId);
		if (!approved) qualityFailure('Runtime task is absent from immutable plan');
		const corrections = storage.list<{ correctionId: string }>(runId, 'correction');
		const blocked = corrections.some(c => storage.status(runId, 'correction', c.correctionId) !== 'completed');
		const row = z.object({ execution_revision: z.number().int(), eligible: z.number().int() }).optional().parse(ctx.database.prepare(
			'SELECT execution_revision,eligible FROM quality_current_revisions WHERE run_id=? AND task_id=?',
		).get(runId, task.taskId));
		const revision = row && row.eligible === 1 && !blocked ?
			storage.get<TaskRevision>(runId, 'revision', `${task.taskId}:${row.execution_revision}`) : null;
		if (revision && revision.status !== 'completed') qualityFailure('Selected quality revision is incomplete');
		return { ...task, ...approved, status: revision ? 'completed' :
			(task.status === 'completed' ? 'pending' : task.status),
			parentTreeSha: revision?.parentTreeSha ?? (task.status === 'in_progress' ? task.parentTreeSha : null),
			targetTreeSha: revision?.targetTreeSha ?? null, patchHash: revision?.patchHash ?? null };
	}
	return {
		getImmutableTaskPlan,
		saveImmutableTaskPlan,
		selectImmutableTaskPlan,
		isSelectedTaskPlan,
		hydrateTask,
	};
}
