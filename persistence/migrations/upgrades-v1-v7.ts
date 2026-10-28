import { sha256 } from '../../policy/contracts.ts';
import type { MigrationStep } from './baseline-schema.ts';

interface LegacyCriticReviewRow {
	review_id: string;
	run_id: string;
	generation: number;
	phase: string;
	reviewer_vendor: string;
	reviewer_model: string;
	manifest_path: string;
	findings_count: number;
	has_p1: number;
	reviewed_at: string;
}

interface TableInfoRow {
	name: string;
}

export const upgradesV1ToV7: readonly MigrationStep[] = [
	{
		version: 2,
		up(db, helpers) {
			if (typeof helpers.hasColumn !== 'function') {
				throw new Error('Migration step requires hasColumn');
			}
			db.exec(`
				ALTER TABLE projection_outbox ADD COLUMN reservation_json TEXT;
				ALTER TABLE projection_outbox ADD COLUMN projection_event_json TEXT;
				ALTER TABLE projection_outbox ADD COLUMN status_json TEXT;
				ALTER TABLE projection_outbox ADD COLUMN intent_text TEXT;
			`);
		},
	},
	{
		version: 3,
		up(db, helpers) {
			if (typeof helpers.hasColumn !== 'function') {
				throw new Error('Migration step requires hasColumn');
			}
			db.exec(`
				ALTER TABLE runs ADD COLUMN semantic_repairs_count INTEGER NOT NULL DEFAULT 0;
				CREATE TABLE IF NOT EXISTS run_authorizations (
					run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
					approved_spec_hash TEXT NOT NULL,
					approved_plan_policy_hash TEXT NOT NULL,
					repository_id TEXT NOT NULL,
					base_commit_sha TEXT NOT NULL,
					allowed_packages_json TEXT NOT NULL,
					allowed_path_prefixes_json TEXT NOT NULL,
					allowed_operations_json TEXT NOT NULL,
					max_semantic_repairs INTEGER NOT NULL,
					model_usage_profile TEXT NOT NULL,
					expires_at TEXT NOT NULL,
					approved_at TEXT NOT NULL,
					approval_method TEXT NOT NULL,
					created_at TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS generations (
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					generation INTEGER NOT NULL,
					base_commit_sha TEXT NOT NULL,
					target_tree_sha TEXT NOT NULL,
					scope_fingerprints_json TEXT NOT NULL,
					task_owned_paths_json TEXT NOT NULL,
					materialized_at TEXT NOT NULL,
					review_report_hash TEXT,
					finding_count INTEGER,
					has_p1 INTEGER,
					oracle_snapshot_json TEXT,
					PRIMARY KEY(run_id, generation)
				);
				CREATE TABLE IF NOT EXISTS tool_executions (
					execution_id TEXT PRIMARY KEY,
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					role_id TEXT NOT NULL,
					generation INTEGER NOT NULL,
					step_index INTEGER NOT NULL,
					tool_name TEXT NOT NULL,
					input_hash TEXT NOT NULL,
					output_artifact TEXT REFERENCES artifacts(hash),
					exit_code INTEGER,
					created_at TEXT NOT NULL,
					UNIQUE(run_id, role_id, generation, step_index)
				);
			`);
		},
	},
	{
		version: 4,
		up(db, helpers) {
			if (typeof helpers.hasColumn !== 'function') {
				throw new Error('Migration step requires hasColumn');
			}
			db.exec(`
				CREATE TABLE IF NOT EXISTS git_commits (
					run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
					target_branch TEXT NOT NULL,
					commit_sha TEXT NOT NULL,
					tree_sha TEXT NOT NULL,
					parent_sha TEXT NOT NULL,
					message TEXT NOT NULL,
					author_name TEXT NOT NULL,
					author_email TEXT NOT NULL,
					committed_at TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS critic_reviews (
					review_id TEXT PRIMARY KEY,
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					generation INTEGER NOT NULL,
					phase TEXT NOT NULL,
					reviewer_vendor TEXT NOT NULL,
					reviewer_model TEXT NOT NULL,
					manifest_path TEXT NOT NULL,
					findings_count INTEGER NOT NULL,
					has_p1 INTEGER NOT NULL,
					reviewed_at TEXT NOT NULL,
					UNIQUE(run_id, generation, phase)
				);
				CREATE TABLE IF NOT EXISTS optional_role_executions (
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					role_id TEXT NOT NULL,
					insertion_point TEXT NOT NULL,
					generation INTEGER NOT NULL,
					status TEXT NOT NULL,
					summary TEXT NOT NULL,
					executed_at TEXT NOT NULL,
					PRIMARY KEY(run_id, role_id, generation)
				);
			`);
		},
	},
	{
		version: 5,
		up(db, helpers) {
			if (typeof helpers.hasColumn !== 'function') {
				throw new Error('Migration step requires hasColumn');
			}
			db.exec(`
				CREATE TABLE tool_executions_v5 (
					execution_id TEXT PRIMARY KEY,
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					task_id TEXT NOT NULL DEFAULT 'task-0',
					role_id TEXT NOT NULL,
					generation INTEGER NOT NULL,
					step_index INTEGER NOT NULL,
					tool_name TEXT NOT NULL,
					input_hash TEXT NOT NULL,
					output_artifact TEXT REFERENCES artifacts(hash),
					exit_code INTEGER,
					created_at TEXT NOT NULL,
					UNIQUE(run_id, task_id, role_id, generation, step_index)
				);
				INSERT INTO tool_executions_v5 (
					execution_id, run_id, task_id, role_id, generation, step_index,
					tool_name, input_hash, output_artifact, exit_code, created_at
				)
				SELECT
					execution_id, run_id, 'task-0', role_id, generation, step_index,
					tool_name, input_hash, output_artifact, exit_code, created_at
				FROM tool_executions;
				DROP TABLE tool_executions;
				ALTER TABLE tool_executions_v5 RENAME TO tool_executions;
				CREATE INDEX IF NOT EXISTS idx_tool_executions_run ON tool_executions(run_id, generation);

				CREATE TABLE optional_role_executions_v5 (
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					task_id TEXT NOT NULL DEFAULT 'task-0',
					role_id TEXT NOT NULL,
					insertion_point TEXT NOT NULL,
					generation INTEGER NOT NULL,
					status TEXT NOT NULL,
					summary TEXT NOT NULL,
					executed_at TEXT NOT NULL,
					PRIMARY KEY(run_id, task_id, role_id, generation)
				);
				INSERT INTO optional_role_executions_v5 (
					run_id, task_id, role_id, insertion_point, generation, status, summary, executed_at
				)
				SELECT
					run_id, 'task-0', role_id, insertion_point, generation, status, summary, executed_at
				FROM optional_role_executions;
				DROP TABLE optional_role_executions;
				ALTER TABLE optional_role_executions_v5 RENAME TO optional_role_executions;
				CREATE INDEX IF NOT EXISTS idx_optional_role_executions_run ON optional_role_executions(run_id, generation);

				CREATE TABLE IF NOT EXISTS task_plans (
					run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
					plan_policy_hash TEXT NOT NULL,
					base_commit_sha TEXT NOT NULL,
					integration_order_json TEXT NOT NULL,
					is_parallel INTEGER NOT NULL,
					created_at TEXT NOT NULL
				);

				CREATE TABLE IF NOT EXISTS dag_tasks (
					task_id TEXT NOT NULL,
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					title TEXT NOT NULL,
					target_package TEXT NOT NULL,
					path_prefixes_json TEXT NOT NULL,
					depends_on_json TEXT NOT NULL,
					status TEXT NOT NULL,
					integration_order INTEGER NOT NULL,
					worktree_subdir TEXT NOT NULL,
					base_commit_sha TEXT NOT NULL,
					parent_tree_sha TEXT,
					parent_commit_sha TEXT,
					target_tree_sha TEXT,
					patch_hash TEXT,
					failure_packet_artifact TEXT,
					repair_count INTEGER NOT NULL DEFAULT 0,
					PRIMARY KEY(run_id, task_id)
				);
				CREATE INDEX IF NOT EXISTS idx_dag_tasks_run ON dag_tasks(run_id, integration_order);

				CREATE TABLE IF NOT EXISTS reconciliations (
					reconciliation_id TEXT PRIMARY KEY,
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					integration_order_json TEXT NOT NULL,
					reconciled_tree_sha TEXT NOT NULL,
					status TEXT NOT NULL,
					conflict_details_json TEXT,
					reconciled_at TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_reconciliations_run ON reconciliations(run_id, reconciled_at);
				CREATE TABLE IF NOT EXISTS pull_requests (
					run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
					pr_url TEXT NOT NULL,
					pr_number INTEGER NOT NULL,
					draft INTEGER NOT NULL DEFAULT 1,
					branch_name TEXT NOT NULL,
					base_branch TEXT NOT NULL,
					created_at TEXT NOT NULL
				);
			`);
		},
	},
	{
		version: 6,
		up(db, helpers) {
			if (typeof helpers.hasColumn !== 'function') {
				throw new Error('Migration step requires hasColumn');
			}
			db.exec(`
				CREATE TABLE critic_reviews_v6 (
					review_id TEXT PRIMARY KEY,
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					generation INTEGER NOT NULL,
					phase TEXT NOT NULL,
					artifact_hash TEXT NOT NULL,
					attempt_key TEXT NOT NULL,
					reviewer_vendor TEXT NOT NULL,
					reviewer_model TEXT NOT NULL,
					manifest_path TEXT NOT NULL,
					findings_count INTEGER NOT NULL,
					has_p1 INTEGER NOT NULL,
					reviewed_at TEXT NOT NULL,
					UNIQUE(run_id, phase, artifact_hash)
				);
			`);
			const rawExisting: unknown = db.prepare('SELECT * FROM critic_reviews').all();
			const existing = rawExisting as LegacyCriticReviewRow[];
			const insert = db.prepare(`
				INSERT INTO critic_reviews_v6 (
					review_id, run_id, generation, phase, artifact_hash, attempt_key,
					reviewer_vendor, reviewer_model, manifest_path, findings_count, has_p1, reviewed_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`);
			for (const row of existing) {
				insert.run(
					row.review_id,
					row.run_id,
					row.generation,
					row.phase,
					sha256(`legacy:${row.run_id}:${row.generation}:${row.phase}`),
					`legacy:${row.run_id}:${row.phase}`,
					row.reviewer_vendor,
					row.reviewer_model,
					row.manifest_path,
					row.findings_count,
					row.has_p1,
					row.reviewed_at,
				);
			}
			db.exec(`
				DROP TABLE critic_reviews;
				ALTER TABLE critic_reviews_v6 RENAME TO critic_reviews;
				CREATE INDEX IF NOT EXISTS idx_critic_reviews_attempt ON critic_reviews(run_id, phase, attempt_key);
			`);
		},
	},
	{
		version: 7,
		up(db, helpers) {
			if (typeof helpers.hasColumn !== 'function') {
				throw new Error('Migration step requires hasColumn');
			}
			const rawOpCols: unknown = db.prepare('PRAGMA table_info(model_operations)').all();
			const opCols = rawOpCols as TableInfoRow[];
			if (!opCols.some((col) => col.name === 'effective_strategy')) {
				db.exec('ALTER TABLE model_operations ADD COLUMN effective_strategy TEXT');
			}
			if (!opCols.some((col) => col.name === 'selected_quality_tier')) {
				db.exec('ALTER TABLE model_operations ADD COLUMN selected_quality_tier INTEGER');
			}
			if (!opCols.some((col) => col.name === 'counterfactual_tier2_cost_microusd')) {
				db.exec('ALTER TABLE model_operations ADD COLUMN counterfactual_tier2_cost_microusd INTEGER');
			}
			db.exec(`
				CREATE TABLE IF NOT EXISTS diagnostics (
					diagnostic_id TEXT PRIMARY KEY,
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					task_id TEXT NOT NULL,
					kind TEXT NOT NULL,
					payload_json TEXT NOT NULL,
					created_at TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_diagnostics_run ON diagnostics(run_id, kind);
			`);
		},
	},
];
