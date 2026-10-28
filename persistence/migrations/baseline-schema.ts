import type { StoreDatabase } from '../run-ledger.ts';

export interface MigrationHelpers {
	hasColumn?: (database: StoreDatabase, table: string, name: string) => boolean;
}

export interface MigrationStep {
	readonly version: number;
	up(db: StoreDatabase, helpers: MigrationHelpers): void;
}

export function applyBaselineSchema(database: { exec(sql: string): void }): void {
	database.exec(`
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
						updated_at TEXT NOT NULL,
						effective_strategy TEXT,
						selected_quality_tier INTEGER,
						counterfactual_tier2_cost_microusd INTEGER,
						task_id TEXT,
						role_id TEXT,
						route_id TEXT,
						provider TEXT,
						model_id TEXT,
						physical_attempts INTEGER,
						attempted_routes_json TEXT
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
						task_manifest_hash TEXT,
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
						oracle_snapshot_json TEXT,
						PRIMARY KEY(run_id, generation)
					);
					CREATE TABLE tool_executions (
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
					CREATE TABLE pull_requests (
						run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
						pr_url TEXT NOT NULL,
						pr_number INTEGER NOT NULL,
						draft INTEGER NOT NULL DEFAULT 1,
						branch_name TEXT NOT NULL,
						base_branch TEXT NOT NULL,
						created_at TEXT NOT NULL
					);
					CREATE TABLE critic_reviews (
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
						findings_json TEXT,
						report_artifact TEXT,
						UNIQUE(run_id, phase, artifact_hash)
					);
					CREATE INDEX idx_critic_reviews_attempt ON critic_reviews(run_id, phase, attempt_key);
					CREATE TABLE optional_role_executions (
						run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
						task_id TEXT NOT NULL DEFAULT 'task-0',
						role_id TEXT NOT NULL,
						insertion_point TEXT NOT NULL,
						generation INTEGER NOT NULL,
						status TEXT NOT NULL,
						summary TEXT NOT NULL,
						executed_at TEXT NOT NULL,
						output_artifact TEXT,
						structured_findings_json TEXT,
						PRIMARY KEY(run_id, task_id, role_id, generation)
					);
					CREATE TABLE task_plans (
						run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
						plan_policy_hash TEXT NOT NULL,
						task_manifest_hash TEXT,
						base_commit_sha TEXT NOT NULL,
						slices_json TEXT,
						integration_order_json TEXT NOT NULL,
						is_parallel INTEGER NOT NULL,
						created_at TEXT NOT NULL
					);
					CREATE TABLE dag_tasks (
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
						manifest_metadata_json TEXT,
						PRIMARY KEY(run_id, task_id)
					);
					CREATE INDEX idx_dag_tasks_run ON dag_tasks(run_id, integration_order);
					CREATE TABLE reconciliations (
						reconciliation_id TEXT PRIMARY KEY,
						run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
						integration_order_json TEXT NOT NULL,
						reconciled_tree_sha TEXT NOT NULL,
						status TEXT NOT NULL,
						conflict_details_json TEXT,
						reconciled_at TEXT NOT NULL
					);
					CREATE INDEX idx_reconciliations_run ON reconciliations(run_id, reconciled_at);
					CREATE TABLE diagnostics (
						diagnostic_id TEXT PRIMARY KEY,
						run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
						task_id TEXT NOT NULL,
						kind TEXT NOT NULL,
						payload_json TEXT NOT NULL,
						created_at TEXT NOT NULL
					);
					CREATE INDEX idx_diagnostics_run ON diagnostics(run_id, kind);
					CREATE TABLE candidate_learnings (
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
					CREATE INDEX idx_candidate_learnings_run ON candidate_learnings(run_id, task_id, generation);
					CREATE TABLE learning_outbox (
						outbox_id TEXT PRIMARY KEY,
						run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
						runtime_revision INTEGER NOT NULL,
						learning_key TEXT NOT NULL,
						payload_json TEXT NOT NULL,
						published_at TEXT,
						created_at TEXT NOT NULL
					);
					CREATE INDEX idx_learning_outbox_pending
						ON learning_outbox(run_id) WHERE published_at IS NULL;
					CREATE TABLE prompt_friction_findings (
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
					CREATE INDEX idx_prompt_friction_findings_run
						ON prompt_friction_findings(run_id);
					CREATE INDEX idx_prompt_friction_findings_key
						ON prompt_friction_findings(finding_key);
					CREATE TABLE continuation_attempts (
						run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
						blocked_reason TEXT NOT NULL,
						attempts INTEGER NOT NULL DEFAULT 1,
						policy_fingerprint TEXT,
						updated_at TEXT NOT NULL,
						PRIMARY KEY(run_id, blocked_reason)
					);
					CREATE TABLE continuation_projections (
						run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
						runtime_revision INTEGER NOT NULL,
						projection_revision INTEGER NOT NULL,
						status_json TEXT NOT NULL,
						created_at TEXT NOT NULL,
						PRIMARY KEY(run_id, projection_revision)
					);
				`);
}
