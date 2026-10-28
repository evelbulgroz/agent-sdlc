import type { MigrationStep } from './baseline-schema.ts';

interface TableInfoRow {
	name: string;
}

export const upgradesV8ToV13: readonly MigrationStep[] = [
	{
		version: 8,
		up(db, helpers) {
			if (typeof helpers.hasColumn !== 'function') {
				throw new Error('Migration step requires hasColumn');
			}
			const rawTables: unknown = db
				.prepare("SELECT name FROM sqlite_master WHERE type='table'")
				.all();
			const tables = (rawTables as TableInfoRow[]).map((r) => r.name);
			if (tables.includes('critic_reviews')) {
				const rawCriticCols: unknown = db.prepare('PRAGMA table_info(critic_reviews)').all();
				const criticCols = rawCriticCols as TableInfoRow[];
				if (!criticCols.some((col) => col.name === 'findings_json')) {
					db.exec('ALTER TABLE critic_reviews ADD COLUMN findings_json TEXT');
				}
				if (!criticCols.some((col) => col.name === 'report_artifact')) {
					db.exec('ALTER TABLE critic_reviews ADD COLUMN report_artifact TEXT');
				}
			}

			if (tables.includes('optional_role_executions')) {
				const rawOptCols: unknown = db.prepare('PRAGMA table_info(optional_role_executions)').all();
				const optCols = rawOptCols as TableInfoRow[];
				if (!optCols.some((col) => col.name === 'output_artifact')) {
					db.exec('ALTER TABLE optional_role_executions ADD COLUMN output_artifact TEXT');
				}
				if (!optCols.some((col) => col.name === 'structured_findings_json')) {
					db.exec('ALTER TABLE optional_role_executions ADD COLUMN structured_findings_json TEXT');
				}
			}

			const rawCandidateCols: unknown = tables.includes('candidate_learnings')
				? db.prepare('PRAGMA table_info(candidate_learnings)').all()
				: [];
			const candidateColumns = rawCandidateCols as TableInfoRow[];
			const rawOutboxCols: unknown = tables.includes('learning_outbox')
				? db.prepare('PRAGMA table_info(learning_outbox)').all()
				: [];
			const outboxColumns = rawOutboxCols as TableInfoRow[];
			const hasLegacyCandidates =
				candidateColumns.length > 0 &&
				!candidateColumns.some((column) => column.name === 'source_phase');
			const hasLegacyOutbox =
				outboxColumns.length > 0 &&
				!outboxColumns.some((column) => column.name === 'runtime_revision');
			if (hasLegacyOutbox) {
				db.exec('ALTER TABLE learning_outbox RENAME TO learning_outbox_v7');
			}
			if (hasLegacyCandidates) {
				db.exec('ALTER TABLE candidate_learnings RENAME TO candidate_learnings_v7');
			}
			db.exec(`
				CREATE TABLE IF NOT EXISTS candidate_learnings (
					candidate_id TEXT PRIMARY KEY,
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					task_id TEXT NOT NULL DEFAULT 'task-0',
					generation INTEGER NOT NULL,
					source_phase TEXT NOT NULL,
					learning_type TEXT NOT NULL,
					learning_key TEXT NOT NULL,
					scope TEXT NOT NULL,
					query TEXT NOT NULL,
					insight TEXT NOT NULL,
					confidence INTEGER NOT NULL,
					source TEXT NOT NULL,
					graduation_target TEXT,
					created_at TEXT NOT NULL,
					UNIQUE(run_id, task_id, generation, source_phase, learning_key)
				);
				CREATE INDEX IF NOT EXISTS idx_candidate_learnings_run
					ON candidate_learnings(run_id, task_id, generation);
				CREATE TABLE IF NOT EXISTS learning_outbox (
					outbox_id TEXT PRIMARY KEY,
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					runtime_revision INTEGER NOT NULL,
					learning_key TEXT NOT NULL,
					payload_json TEXT NOT NULL,
					published_at TEXT,
					created_at TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_learning_outbox_pending
					ON learning_outbox(run_id) WHERE published_at IS NULL;
			`);
			if (hasLegacyCandidates) {
				db.exec(`
					INSERT INTO candidate_learnings (
						candidate_id, run_id, task_id, generation, source_phase,
						learning_type, learning_key, scope, query, insight, confidence,
						source, graduation_target, created_at
					)
					SELECT
						candidate_id,
						run_id,
						'task-0',
						generation,
						CASE
							WHEN source_role = 'operator' THEN 'post-mortem'
							WHEN source_role = 'repairer' THEN 'repair'
							ELSE source_role
						END,
						learning_type,
						learning_key,
						scope,
						query,
						insight,
						confidence,
						CASE WHEN source_role = 'operator' THEN 'user-stated' ELSE 'observed' END,
						graduation_target,
						created_at
					FROM candidate_learnings_v7;
				`);
			}
			if (hasLegacyOutbox) {
				db.exec(`
					INSERT INTO learning_outbox (
						outbox_id, run_id, runtime_revision, learning_key,
						payload_json, published_at, created_at
					)
					SELECT
						outbox_id,
						run_id,
						COALESCE((SELECT runtime_revision FROM runs WHERE runs.run_id = learning_outbox_v7.run_id), 0),
						COALESCE(json_extract(learning_json, '$.key'), outbox_id),
						learning_json,
						published_at,
						created_at
					FROM learning_outbox_v7;
				`);
			}
			if (hasLegacyOutbox) {
				db.exec('DROP TABLE learning_outbox_v7');
			}
			if (hasLegacyCandidates) {
				db.exec('DROP TABLE candidate_learnings_v7');
			}
			db.exec(`
				CREATE INDEX IF NOT EXISTS idx_candidate_learnings_run
					ON candidate_learnings(run_id, task_id, generation);
				CREATE INDEX IF NOT EXISTS idx_learning_outbox_pending
					ON learning_outbox(run_id) WHERE published_at IS NULL;
			`);
		},
	},
	{
		version: 9,
		up(db, helpers) {
			if (typeof helpers.hasColumn !== 'function') {
				throw new Error('Migration step requires hasColumn');
			}
			db.exec(`
				CREATE TABLE IF NOT EXISTS prompt_friction_findings (
					finding_id TEXT PRIMARY KEY,
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					role_id TEXT NOT NULL,
					signal_type TEXT NOT NULL,
					category TEXT NOT NULL,
					finding_key TEXT NOT NULL,
					status TEXT NOT NULL CHECK(status IN ('PROVISIONAL', 'RECOMMENDED', 'APPLIED', 'REJECTED')),
					attribution_layer TEXT NOT NULL CHECK(attribution_layer IN ('layer1', 'layer3', 'layer5')),
					evidence_json TEXT NOT NULL,
					proposed_diff_json TEXT,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					UNIQUE(run_id, finding_key)
				);
				CREATE INDEX IF NOT EXISTS idx_prompt_friction_findings_run
					ON prompt_friction_findings(run_id);
				CREATE INDEX IF NOT EXISTS idx_prompt_friction_findings_key
					ON prompt_friction_findings(finding_key);
			`);
		},
	},
	{
		version: 10,
		up(db, helpers) {
			if (typeof helpers.hasColumn !== 'function') {
				throw new Error('Migration step requires hasColumn');
			}
			db.exec(`
				CREATE TABLE IF NOT EXISTS continuation_projections (
					run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
					runtime_revision INTEGER NOT NULL,
					projection_revision INTEGER NOT NULL,
					status_json TEXT NOT NULL,
					created_at TEXT NOT NULL,
					PRIMARY KEY(run_id, projection_revision)
				);
			`);
		},
	},
	{
		version: 11,
		up(db, helpers) {
			if (typeof helpers.hasColumn !== 'function') {
				throw new Error('Migration step requires hasColumn');
			}
			const rawAuthCols: unknown = db.prepare('PRAGMA table_info(run_authorizations)').all();
			const authorizationColumns = rawAuthCols as TableInfoRow[];
			if (
				authorizationColumns.length > 0 &&
				!authorizationColumns.some((column) => column.name === 'task_manifest_hash')
			) {
				db.exec('ALTER TABLE run_authorizations ADD COLUMN task_manifest_hash TEXT');
			}
			const rawTaskPlanCols: unknown = db.prepare('PRAGMA table_info(task_plans)').all();
			const taskPlanColumns = rawTaskPlanCols as TableInfoRow[];
			if (
				taskPlanColumns.length > 0 &&
				!taskPlanColumns.some((column) => column.name === 'task_manifest_hash')
			) {
				db.exec('ALTER TABLE task_plans ADD COLUMN task_manifest_hash TEXT');
			}
		},
	},
	{
		version: 12,
		up(db, helpers) {
			if (typeof helpers.hasColumn !== 'function') {
				throw new Error('Migration step requires hasColumn');
			}
			const rawTaskPlanCols: unknown = db.prepare('PRAGMA table_info(task_plans)').all();
			const taskPlanColumns = rawTaskPlanCols as TableInfoRow[];
			if (
				taskPlanColumns.length > 0 &&
				!taskPlanColumns.some((column) => column.name === 'slices_json')
			) {
				db.exec('ALTER TABLE task_plans ADD COLUMN slices_json TEXT');
			}
			const rawTaskCols: unknown = db.prepare('PRAGMA table_info(dag_tasks)').all();
			const taskColumns = rawTaskCols as TableInfoRow[];
			if (
				taskColumns.length > 0 &&
				!taskColumns.some((column) => column.name === 'manifest_metadata_json')
			) {
				db.exec('ALTER TABLE dag_tasks ADD COLUMN manifest_metadata_json TEXT');
			}
		},
	},
	{
		version: 13,
		up(db, helpers) {
			if (typeof helpers.hasColumn !== 'function') {
				throw new Error('Migration step requires hasColumn');
			}
			const rawOpCols: unknown = db.prepare('PRAGMA table_info(model_operations)').all();
			const operationColumns = rawOpCols as TableInfoRow[];
			for (const [column, type] of [
				['task_id', 'TEXT'],
				['role_id', 'TEXT'],
				['route_id', 'TEXT'],
				['provider', 'TEXT'],
				['model_id', 'TEXT'],
				['physical_attempts', 'INTEGER'],
				['attempted_routes_json', 'TEXT'],
			] as const) {
				if (!operationColumns.some((candidate) => candidate.name === column)) {
					db.exec(`ALTER TABLE model_operations ADD COLUMN ${column} ${type}`);
				}
			}
		},
	},
];
