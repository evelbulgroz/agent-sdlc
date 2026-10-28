import {
	type DagTask,
	RUNTIME_SCHEMA_VERSION,
	type ReconciliationRecord,
	type TaskPlan,
	validateDagTask,
	validateReconciliationRecord,
	validateRunId,
	validateTaskPlan,
} from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import type { StoreContext } from './run-ledger.ts';

interface TaskPlanDbRow {
	run_id: string;
	plan_policy_hash: string;
	task_manifest_hash: string | null;
	base_commit_sha: string;
	slices_json: string | null;
	integration_order_json: string;
	is_parallel: number;
	created_at: string;
}

interface DagTaskDbRow {
	task_id: string;
	run_id: string;
	title: string;
	target_package: string;
	path_prefixes_json: string;
	depends_on_json: string;
	status: string;
	integration_order: number;
	worktree_subdir: string;
	base_commit_sha: string;
	parent_tree_sha: string | null;
	parent_commit_sha: string | null;
	target_tree_sha: string | null;
	patch_hash: string | null;
	failure_packet_artifact: string | null;
	repair_count: number | null;
	manifest_metadata_json: string | null;
}

interface ReconciliationDbRow {
	reconciliation_id: string;
	run_id: string;
	integration_order_json: string;
	reconciled_tree_sha: string;
	status: string;
	conflict_details_json: string | null;
	reconciled_at: string;
}

export interface TaskPlanRecords {
	saveTaskPlan(planInput: unknown): Readonly<TaskPlan>;
	getTaskPlan(runId: string): Readonly<TaskPlan> | null;
	getTask(runId: string, taskId: string): Readonly<DagTask> | null;
	updateTaskStatus(
		runId: string,
		taskId: string,
		updates?: Record<string, unknown>,
	): Readonly<DagTask>;
	listTasks(runId: string): Readonly<DagTask>[];
	saveReconciliation(recordInput: unknown): Readonly<ReconciliationRecord>;
	getReconciliation(reconciliationId: string): Readonly<ReconciliationRecord> | null;
	getLatestReconciliation(runId: string): Readonly<ReconciliationRecord> | null;
}

const TASK_MANIFEST_METADATA_FIELDS = Object.freeze([
	'sliceId',
	'authoredPaths',
	'generatedOutputs',
	'deliveryLayers',
	'dependencyMutations',
	'shadowPaths',
	'verificationCommand',
	'generatorCommand',
	'acceptanceCriteria',
	'complexityInputs',
	'complexityScore',
	'contractProducer',
	'highRisk',
	'changeClass',
	'maxAutonomousRepairs',
	'humanReviewEvidence',
	'exceededLimits',
] as const);

function taskManifestMetadata(task: Readonly<DagTask>): Record<string, unknown> {
	const record = task as Record<string, unknown>;
	const metadata: Record<string, unknown> = {};
	for (const field of TASK_MANIFEST_METADATA_FIELDS) {
		if (record[field] !== undefined) metadata[field] = record[field];
	}
	return metadata;
}

function mapDagTaskRow(row: DagTaskDbRow): Readonly<DagTask> {
	const manifestMetadata = row.manifest_metadata_json
		? (JSON.parse(row.manifest_metadata_json) as Record<string, unknown>)
		: {};
	return validateDagTask({
		taskId: row.task_id,
		title: row.title,
		targetPackage: row.target_package,
		pathPrefixes: JSON.parse(row.path_prefixes_json),
		dependsOn: JSON.parse(row.depends_on_json),
		status: row.status,
		integrationOrder: row.integration_order,
		worktreeSubdir: row.worktree_subdir,
		baseCommitSha: row.base_commit_sha,
		parentTreeSha: row.parent_tree_sha ?? null,
		parentCommitSha: row.parent_commit_sha ?? null,
		targetTreeSha: row.target_tree_sha ?? null,
		patchHash: row.patch_hash ?? null,
		failurePacketArtifact: row.failure_packet_artifact ?? null,
		repairCount: row.repair_count ?? 0,
		...manifestMetadata,
	});
}

function mapReconciliationRow(row: ReconciliationDbRow): Readonly<ReconciliationRecord> {
	return validateReconciliationRecord({
		reconciliationId: row.reconciliation_id,
		runId: row.run_id,
		integrationOrder: JSON.parse(row.integration_order_json),
		reconciledTreeSha: row.reconciled_tree_sha,
		status: row.status,
		conflictDetails: row.conflict_details_json ? JSON.parse(row.conflict_details_json) : null,
		reconciledAt: row.reconciled_at,
	});
}

export function createTaskPlanRecords(ctx: StoreContext): TaskPlanRecords {
	function saveTaskPlan(planInput: unknown): Readonly<TaskPlan> {
		ctx.assertOpen();
		const plan = validateTaskPlan(planInput);
		return ctx.transaction(() => {
			ctx.database
				.prepare(
					`
					INSERT INTO task_plans (
						run_id, plan_policy_hash, task_manifest_hash, base_commit_sha,
						slices_json, integration_order_json, is_parallel, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(run_id) DO UPDATE SET
						plan_policy_hash = excluded.plan_policy_hash,
						task_manifest_hash = excluded.task_manifest_hash,
						base_commit_sha = excluded.base_commit_sha,
						slices_json = excluded.slices_json,
						integration_order_json = excluded.integration_order_json,
						is_parallel = excluded.is_parallel,
						created_at = excluded.created_at
				`,
				)
				.run(
					plan.runId,
					plan.planPolicyHash,
					plan.taskManifestHash ?? null,
					plan.baseCommitSha,
					plan.slices ? JSON.stringify(plan.slices) : null,
					JSON.stringify(plan.integrationOrder),
					plan.isParallel ? 1 : 0,
					plan.createdAt,
				);

			const taskStmt = ctx.database.prepare(`
				INSERT INTO dag_tasks (
					task_id, run_id, title, target_package, path_prefixes_json,
					depends_on_json, status, integration_order, worktree_subdir,
					base_commit_sha, parent_tree_sha, parent_commit_sha, target_tree_sha, patch_hash,
					failure_packet_artifact, repair_count, manifest_metadata_json
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(run_id, task_id) DO UPDATE SET
					title = excluded.title,
					target_package = excluded.target_package,
					path_prefixes_json = excluded.path_prefixes_json,
					depends_on_json = excluded.depends_on_json,
					status = excluded.status,
					integration_order = excluded.integration_order,
					worktree_subdir = excluded.worktree_subdir,
					base_commit_sha = excluded.base_commit_sha,
					parent_tree_sha = excluded.parent_tree_sha,
					parent_commit_sha = excluded.parent_commit_sha,
					target_tree_sha = excluded.target_tree_sha,
					patch_hash = excluded.patch_hash,
					failure_packet_artifact = excluded.failure_packet_artifact,
					repair_count = excluded.repair_count,
					manifest_metadata_json = excluded.manifest_metadata_json
			`);
			for (const task of plan.tasks) {
				taskStmt.run(
					task.taskId,
					plan.runId,
					task.title,
					task.targetPackage,
					JSON.stringify(task.pathPrefixes),
					JSON.stringify(task.dependsOn),
					task.status,
					task.integrationOrder,
					task.worktreeSubdir,
					task.baseCommitSha,
					task.parentTreeSha ?? null,
					task.parentCommitSha ?? null,
					task.targetTreeSha ?? null,
					task.patchHash ?? null,
					task.failurePacketArtifact ?? null,
					task.repairCount ?? 0,
					JSON.stringify(taskManifestMetadata(task)),
				);
			}
			return plan;
		});
	}

	function getTaskPlan(runId: string): Readonly<TaskPlan> | null {
		ctx.assertOpen();
		validateRunId(runId);
		const rawPlanRow: unknown = ctx.database
			.prepare('SELECT * FROM task_plans WHERE run_id = ?')
			.get(runId);
		const planRow = rawPlanRow as TaskPlanDbRow | undefined;
		if (!planRow) return null;
		const tasks = listTasks(runId);
		return validateTaskPlan({
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			runId,
			planPolicyHash: planRow.plan_policy_hash,
			taskManifestHash: planRow.task_manifest_hash ?? null,
			baseCommitSha: planRow.base_commit_sha,
			...(planRow.slices_json ? { slices: JSON.parse(planRow.slices_json) } : {}),
			tasks,
			integrationOrder: JSON.parse(planRow.integration_order_json),
			isParallel: Boolean(planRow.is_parallel),
			createdAt: planRow.created_at,
		});
	}

	function getTask(runId: string, taskId: string): Readonly<DagTask> | null {
		ctx.assertOpen();
		validateRunId(runId);
		const raw: unknown = ctx.database
			.prepare('SELECT * FROM dag_tasks WHERE run_id = ? AND task_id = ?')
			.get(runId, taskId);
		const row = raw as DagTaskDbRow | undefined;
		if (!row) return null;
		return mapDagTaskRow(row);
	}

	function updateTaskStatus(
		runId: string,
		taskId: string,
		updates: Record<string, unknown> = {},
	): Readonly<DagTask> {
		ctx.assertOpen();
		validateRunId(runId);
		return ctx.transaction(() => {
			const current = getTask(runId, taskId);
			if (!current) {
				throw new SdlcError('TASK_NOT_FOUND', `Task '${taskId}' not found for run '${runId}'`);
			}
			const updated = validateDagTask({
				...current,
				...updates,
			});
			ctx.database
				.prepare(
					`
					UPDATE dag_tasks SET
						title = ?,
						target_package = ?,
						path_prefixes_json = ?,
						depends_on_json = ?,
						status = ?,
						integration_order = ?,
						worktree_subdir = ?,
						base_commit_sha = ?,
						parent_tree_sha = ?,
						parent_commit_sha = ?,
						target_tree_sha = ?,
						patch_hash = ?,
						failure_packet_artifact = ?,
						repair_count = ?,
						manifest_metadata_json = ?
					WHERE run_id = ? AND task_id = ?
				`,
				)
				.run(
					updated.title,
					updated.targetPackage,
					JSON.stringify(updated.pathPrefixes),
					JSON.stringify(updated.dependsOn),
					updated.status,
					updated.integrationOrder,
					updated.worktreeSubdir,
					updated.baseCommitSha,
					updated.parentTreeSha ?? null,
					updated.parentCommitSha ?? null,
					updated.targetTreeSha ?? null,
					updated.patchHash ?? null,
					updated.failurePacketArtifact ?? null,
					updated.repairCount ?? 0,
					JSON.stringify(taskManifestMetadata(updated)),
					runId,
					taskId,
				);
			return updated;
		});
	}

	function listTasks(runId: string): Readonly<DagTask>[] {
		ctx.assertOpen();
		validateRunId(runId);
		const raw: unknown = ctx.database
			.prepare('SELECT * FROM dag_tasks WHERE run_id = ? ORDER BY integration_order ASC, rowid ASC')
			.all(runId);
		const rows = raw as DagTaskDbRow[];
		return rows.map(mapDagTaskRow);
	}

	function saveReconciliation(recordInput: unknown): Readonly<ReconciliationRecord> {
		ctx.assertOpen();
		const record = validateReconciliationRecord(recordInput);
		return ctx.transaction(() => {
			ctx.database
				.prepare(
					`
					INSERT INTO reconciliations (
						reconciliation_id, run_id, integration_order_json, reconciled_tree_sha,
						status, conflict_details_json, reconciled_at
					) VALUES (?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(reconciliation_id) DO UPDATE SET
						integration_order_json = excluded.integration_order_json,
						reconciled_tree_sha = excluded.reconciled_tree_sha,
						status = excluded.status,
						conflict_details_json = excluded.conflict_details_json,
						reconciled_at = excluded.reconciled_at
				`,
				)
				.run(
					record.reconciliationId,
					record.runId,
					JSON.stringify(record.integrationOrder),
					record.reconciledTreeSha,
					record.status,
					record.conflictDetails ? JSON.stringify(record.conflictDetails) : null,
					record.reconciledAt,
				);
			return record;
		});
	}

	function getReconciliation(reconciliationId: string): Readonly<ReconciliationRecord> | null {
		ctx.assertOpen();
		const raw: unknown = ctx.database
			.prepare('SELECT * FROM reconciliations WHERE reconciliation_id = ?')
			.get(reconciliationId);
		const row = raw as ReconciliationDbRow | undefined;
		if (!row) return null;
		return mapReconciliationRow(row);
	}

	function getLatestReconciliation(runId: string): Readonly<ReconciliationRecord> | null {
		ctx.assertOpen();
		validateRunId(runId);
		const raw: unknown = ctx.database
			.prepare(
				'SELECT * FROM reconciliations WHERE run_id = ? ORDER BY reconciled_at DESC, rowid DESC LIMIT 1',
			)
			.get(runId);
		const row = raw as ReconciliationDbRow | undefined;
		if (!row) return null;
		return mapReconciliationRow(row);
	}

	return {
		saveTaskPlan,
		getTaskPlan,
		getTask,
		updateTaskStatus,
		listTasks,
		saveReconciliation,
		getReconciliation,
		getLatestReconciliation,
	};
}
