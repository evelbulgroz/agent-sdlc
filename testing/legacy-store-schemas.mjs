// Legacy DDL fixtures for store migration tests. Not a spec, so the navigability ceiling does not apply.
export const LEGACY_SCHEMA_V1 = `
			CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
			INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-09-01T00:00:00.000Z');
			CREATE TABLE runs (
				run_id TEXT PRIMARY KEY,
				thread_id TEXT NOT NULL UNIQUE,
				runtime_revision INTEGER NOT NULL,
				projection_revision INTEGER NOT NULL DEFAULT 0,
				state TEXT NOT NULL,
				state_hash TEXT NOT NULL,
				state_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE events (
				event_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
				runtime_revision INTEGER NOT NULL,
				event_type TEXT NOT NULL,
				event_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				UNIQUE(run_id, runtime_revision, event_type, event_id)
			);
			CREATE TABLE artifacts (
				hash TEXT PRIMARY KEY,
				type TEXT NOT NULL,
				media_type TEXT NOT NULL,
				byte_length INTEGER NOT NULL,
				storage_path TEXT NOT NULL,
				redaction_status TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE TABLE interrupts (
				interrupt_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
				kind TEXT NOT NULL,
				state_hash TEXT NOT NULL,
				request_artifact TEXT NOT NULL REFERENCES artifacts(hash),
				status TEXT NOT NULL,
				response_artifact TEXT REFERENCES artifacts(hash),
				created_at TEXT NOT NULL,
				response_recorded_at TEXT,
				resolved_at TEXT
			);
			CREATE TABLE model_operations (
				operation_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
				synthetic INTEGER NOT NULL,
				status TEXT NOT NULL,
				output_artifact TEXT REFERENCES artifacts(hash),
				usage_record_ids_json TEXT NOT NULL,
				error_code TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE projection_outbox (
				run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
				runtime_revision INTEGER NOT NULL,
				projection_revision INTEGER,
				published_at TEXT,
				PRIMARY KEY(run_id, runtime_revision)
			);
			CREATE TABLE checkpoints (
				thread_id TEXT NOT NULL,
				checkpoint_ns TEXT NOT NULL,
				checkpoint_id TEXT NOT NULL,
				parent_checkpoint_id TEXT,
				checkpoint_type TEXT NOT NULL,
				checkpoint BLOB NOT NULL,
				metadata_type TEXT NOT NULL,
				metadata BLOB NOT NULL,
				PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id)
			);
			CREATE TABLE checkpoint_writes (
				thread_id TEXT NOT NULL,
				checkpoint_ns TEXT NOT NULL,
				checkpoint_id TEXT NOT NULL,
				task_id TEXT NOT NULL,
				write_index INTEGER NOT NULL,
				channel TEXT NOT NULL,
				value_type TEXT NOT NULL,
				value BLOB NOT NULL,
				PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id, task_id, write_index)
			);
		`;

export const LEGACY_SCHEMA_V2 = `
			CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
			INSERT INTO schema_migrations (version, applied_at) VALUES (2, '2026-09-02T00:00:00.000Z');
			CREATE TABLE runs (
				run_id TEXT PRIMARY KEY,
				thread_id TEXT NOT NULL UNIQUE,
				runtime_revision INTEGER NOT NULL,
				projection_revision INTEGER NOT NULL DEFAULT 0,
				state TEXT NOT NULL,
				state_hash TEXT NOT NULL,
				state_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE events (
				event_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
				runtime_revision INTEGER NOT NULL,
				event_type TEXT NOT NULL,
				event_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				UNIQUE(run_id, runtime_revision, event_type, event_id)
			);
			CREATE TABLE artifacts (
				hash TEXT PRIMARY KEY,
				type TEXT NOT NULL,
				media_type TEXT NOT NULL,
				byte_length INTEGER NOT NULL,
				storage_path TEXT NOT NULL,
				redaction_status TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE TABLE interrupts (
				interrupt_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
				kind TEXT NOT NULL,
				state_hash TEXT NOT NULL,
				request_artifact TEXT NOT NULL REFERENCES artifacts(hash),
				status TEXT NOT NULL,
				response_artifact TEXT REFERENCES artifacts(hash),
				created_at TEXT NOT NULL,
				response_recorded_at TEXT,
				resolved_at TEXT
			);
			CREATE TABLE model_operations (
				operation_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
				synthetic INTEGER NOT NULL,
				status TEXT NOT NULL,
				output_artifact TEXT REFERENCES artifacts(hash),
				usage_record_ids_json TEXT NOT NULL,
				error_code TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE projection_outbox (
				run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
				runtime_revision INTEGER NOT NULL,
				projection_revision INTEGER,
				reservation_json TEXT,
				projection_event_json TEXT,
				status_json TEXT,
				intent_text TEXT,
				published_at TEXT,
				PRIMARY KEY(run_id, runtime_revision)
			);
			CREATE TABLE checkpoints (
				thread_id TEXT NOT NULL,
				checkpoint_ns TEXT NOT NULL,
				checkpoint_id TEXT NOT NULL,
				parent_checkpoint_id TEXT,
				checkpoint_type TEXT NOT NULL,
				checkpoint BLOB NOT NULL,
				metadata_type TEXT NOT NULL,
				metadata BLOB NOT NULL,
				PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id)
			);
			CREATE TABLE checkpoint_writes (
				thread_id TEXT NOT NULL,
				checkpoint_ns TEXT NOT NULL,
				checkpoint_id TEXT NOT NULL,
				task_id TEXT NOT NULL,
				write_index INTEGER NOT NULL,
				channel TEXT NOT NULL,
				value_type TEXT NOT NULL,
				value BLOB NOT NULL,
				PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id, task_id, write_index)
			);
		`;

export const LEGACY_SCHEMA_V3_DOWNGRADE = `
			DROP TABLE IF EXISTS dag_tasks;
			DROP TABLE IF EXISTS reconciliations;
			DROP TABLE IF EXISTS git_commits;
			DROP TABLE IF EXISTS critic_reviews;
			DROP TABLE IF EXISTS optional_role_executions;
			DELETE FROM schema_migrations WHERE version >= 4;
			INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (3, '2026-09-03T00:00:00.000Z');
		`;

export const LEGACY_SCHEMA_V4 = `
			CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
			INSERT INTO schema_migrations (version, applied_at) VALUES (4, '2026-09-04T00:00:00.000Z');
			CREATE TABLE runs (
				run_id TEXT PRIMARY KEY,
				thread_id TEXT NOT NULL UNIQUE,
				runtime_revision INTEGER NOT NULL,
				projection_revision INTEGER NOT NULL DEFAULT 0,
				state TEXT NOT NULL,
				state_hash TEXT NOT NULL,
				state_json TEXT NOT NULL,
				semantic_repairs_count INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE events (
				event_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
				runtime_revision INTEGER NOT NULL,
				event_type TEXT NOT NULL,
				event_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				UNIQUE(run_id, runtime_revision, event_type, event_id)
			);
			CREATE TABLE artifacts (
				hash TEXT PRIMARY KEY,
				type TEXT NOT NULL,
				media_type TEXT NOT NULL,
				byte_length INTEGER NOT NULL,
				storage_path TEXT NOT NULL,
				redaction_status TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE TABLE interrupts (
				interrupt_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
				kind TEXT NOT NULL,
				state_hash TEXT NOT NULL,
				request_artifact TEXT NOT NULL REFERENCES artifacts(hash),
				status TEXT NOT NULL,
				response_artifact TEXT REFERENCES artifacts(hash),
				created_at TEXT NOT NULL,
				response_recorded_at TEXT,
				resolved_at TEXT
			);
			CREATE TABLE model_operations (
				operation_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
				synthetic INTEGER NOT NULL,
				status TEXT NOT NULL,
				output_artifact TEXT REFERENCES artifacts(hash),
				usage_record_ids_json TEXT NOT NULL,
				error_code TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE projection_outbox (
				run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
				runtime_revision INTEGER NOT NULL,
				projection_revision INTEGER,
				reservation_json TEXT,
				projection_event_json TEXT,
				status_json TEXT,
				intent_text TEXT,
				published_at TEXT,
				PRIMARY KEY(run_id, runtime_revision)
			);
			CREATE TABLE checkpoints (
				thread_id TEXT NOT NULL,
				checkpoint_ns TEXT NOT NULL,
				checkpoint_id TEXT NOT NULL,
				parent_checkpoint_id TEXT,
				checkpoint_type TEXT NOT NULL,
				checkpoint BLOB NOT NULL,
				metadata_type TEXT NOT NULL,
				metadata BLOB NOT NULL,
				PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id)
			);
			CREATE TABLE checkpoint_writes (
				thread_id TEXT NOT NULL,
				checkpoint_ns TEXT NOT NULL,
				checkpoint_id TEXT NOT NULL,
				task_id TEXT NOT NULL,
				write_index INTEGER NOT NULL,
				channel TEXT NOT NULL,
				value_type TEXT NOT NULL,
				value BLOB NOT NULL,
				PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id, task_id, write_index)
			);
			CREATE TABLE run_authorizations (
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
			CREATE TABLE generations (
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
				PRIMARY KEY(run_id, generation)
			);
			CREATE TABLE tool_executions (
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
			CREATE TABLE git_commits (
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
			CREATE TABLE critic_reviews (
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
			CREATE TABLE optional_role_executions (
				run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
				role_id TEXT NOT NULL,
				insertion_point TEXT NOT NULL,
				generation INTEGER NOT NULL,
				status TEXT NOT NULL,
				summary TEXT NOT NULL,
				executed_at TEXT NOT NULL,
				PRIMARY KEY(run_id, role_id, generation)
			);
			INSERT INTO runs (
				run_id, thread_id, runtime_revision, projection_revision, state,
				state_hash, state_json, semantic_repairs_count, created_at, updated_at
			) VALUES (
				'2026-09-04-test-run-v4', 'thread-v4', 0, 0, 'SPEC_DRAFTING',
				'hash', '{}', 0, '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z'
			);
			INSERT INTO tool_executions (
				execution_id, run_id, role_id, generation, step_index,
				tool_name, input_hash, output_artifact, exit_code, created_at
			) VALUES (
				'exec-v4-0', '2026-09-04-test-run-v4', 'implementer', 0, 0,
				'write_file', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', null, 0, '2026-09-04T00:00:00.000Z'
			);
			INSERT INTO optional_role_executions (
				run_id, role_id, insertion_point, generation, status, summary, executed_at
			) VALUES (
				'2026-09-04-test-run-v4', 'cleaner', 'post_implement', 0, 'passed', 'clean', '2026-09-04T00:00:00.000Z'
			);
		`;

export const LEGACY_SCHEMA_V5 = `
			CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
			INSERT INTO schema_migrations (version, applied_at) VALUES (5, '2026-09-05T00:00:00.000Z');
			CREATE TABLE runs (
				run_id TEXT PRIMARY KEY,
				thread_id TEXT NOT NULL UNIQUE,
				runtime_revision INTEGER NOT NULL,
				projection_revision INTEGER NOT NULL DEFAULT 0,
				state TEXT NOT NULL,
				state_hash TEXT NOT NULL,
				state_json TEXT NOT NULL,
				semantic_repairs_count INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE critic_reviews (
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
			CREATE TABLE model_operations (
				operation_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
				synthetic INTEGER NOT NULL,
				status TEXT NOT NULL,
				output_artifact TEXT,
				usage_record_ids_json TEXT NOT NULL,
				error_code TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`;

export const LEGACY_LEARNING_TABLES_V7 = `
			DROP TABLE learning_outbox;
			DROP TABLE candidate_learnings;
			UPDATE schema_migrations SET version = 7;
			CREATE TABLE candidate_learnings (
				candidate_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
				generation INTEGER NOT NULL,
				stage TEXT NOT NULL,
				source_role TEXT NOT NULL,
				learning_type TEXT NOT NULL,
				learning_key TEXT NOT NULL,
				scope TEXT NOT NULL,
				query TEXT NOT NULL,
				insight TEXT NOT NULL,
				confidence INTEGER NOT NULL,
				status TEXT NOT NULL,
				graduation_target TEXT,
				created_at TEXT NOT NULL
			);
			CREATE TABLE learning_outbox (
				outbox_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
				candidate_id TEXT REFERENCES candidate_learnings(candidate_id) ON DELETE SET NULL,
				learning_json TEXT NOT NULL,
				status TEXT NOT NULL,
				created_at TEXT NOT NULL,
				published_at TEXT
			);
		`;

export const LEGACY_SCHEMA_V8_WITHOUT_FRICTION = `
			DROP TABLE IF EXISTS prompt_friction_findings;
			UPDATE schema_migrations SET version = 8;
		`;
