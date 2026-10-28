import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { applyBaselineSchema } from './migrations/baseline-schema.ts';
import { compactRunDatabase } from './run-compaction.ts';

function createSeededRunDatabase(databasePath) {
	const db = new DatabaseSync(databasePath);
	try {
		applyBaselineSchema(db);
		const now = '2026-11-01T00:00:00Z';
		const runId = '2026-11-01-compaction-sample';
		db.prepare(
			`INSERT INTO runs (
				run_id, thread_id, runtime_revision, projection_revision,
				state, state_hash, state_json, semantic_repairs_count, created_at, updated_at
			) VALUES (?, ?, 1, 1, 'DONE', 'hash-1', '{"runId":"2026-11-01-compaction-sample"}', 0, ?, ?)`,
		).run(runId, `thread-${runId}`, now, now);

		db.prepare(
			`INSERT INTO events (event_id, run_id, runtime_revision, event_type, event_json, created_at)
			 VALUES ('evt-1', ?, 1, 'RUN_INITIALIZED', '{}', ?)`,
		).run(runId, now);

		db.prepare(
			`INSERT INTO artifacts (hash, type, media_type, byte_length, storage_path, redaction_status, created_at)
			 VALUES ('art-hash-1', 'spec', 'application/json', 12, 'artifacts/art-hash-1.json', 'CLEAN', ?)`,
		).run(now);

		db.prepare(
			`INSERT INTO interrupts (
				interrupt_id, run_id, kind, state_hash, request_artifact, status, response_artifact,
				created_at, response_recorded_at, resolved_at
			) VALUES ('int-1', ?, 'approval', 'hash-1', 'art-hash-1', 'RESOLVED', 'art-hash-1', ?, ?, ?)`,
		).run(runId, now, now, now);

		db.prepare(
			`INSERT INTO model_operations (
				operation_id, run_id, synthetic, status, output_artifact, usage_record_ids_json,
				created_at, updated_at, role_id, provider, model_id, physical_attempts
			) VALUES ('op-1', ?, 0, 'SUCCEEDED', 'art-hash-1', '["u-1"]', ?, ?, 'implementer', 'openai', 'gpt-5', 1)`,
		).run(runId, now, now);

		db.prepare(
			`INSERT INTO projection_outbox (run_id, runtime_revision, projection_revision, published_at)
			 VALUES (?, 1, 1, ?)`,
		).run(runId, now);

		db.prepare(
			`INSERT INTO run_authorizations (
				run_id, approved_spec_hash, task_manifest_hash, approved_plan_policy_hash, repository_id,
				base_commit_sha, allowed_packages_json, allowed_path_prefixes_json, allowed_operations_json,
				max_semantic_repairs, model_usage_profile, expires_at, approved_at, approval_method, created_at
			) VALUES (?, 'spec-hash-1', 'manifest-hash-1', 'policy-hash-1', 'fitness-app', 'abc1234', '[]', '[]', '[]', 2, 'default', ?, ?, 'operator', ?)`,
		).run(runId, now, now, now);

		db.prepare(
			`INSERT INTO generations (
				run_id, generation, base_commit_sha, target_tree_sha, scope_fingerprints_json,
				task_owned_paths_json, materialized_at, finding_count, has_p1
			) VALUES (?, 1, 'abc1234', 'def5678', '{}', '[]', ?, 0, 0)`,
		).run(runId, now);

		db.prepare(
			`INSERT INTO tool_executions (
				execution_id, run_id, task_id, role_id, generation, step_index, tool_name, input_hash, output_artifact, exit_code, created_at
			) VALUES ('exec-1', ?, 'task-0', 'implementer', 1, 0, 'read_file', 'in-1', 'art-hash-1', 0, ?)`,
		).run(runId, now);

		db.prepare(
			`INSERT INTO git_commits (
				run_id, target_branch, commit_sha, tree_sha, parent_sha, message, author_name, author_email, committed_at
			) VALUES (?, 'sdlc/sample', 'commit123', 'tree123', 'parent123', 'feat: sample', 'Bot', 'bot@example.com', ?)`,
		).run(runId, now);

		db.prepare(
			`INSERT INTO pull_requests (run_id, pr_url, pr_number, draft, branch_name, base_branch, created_at)
			 VALUES (?, 'https://example.test/pr/1', 1, 1, 'sdlc/sample', 'main', ?)`,
		).run(runId, now);

		db.prepare(
			`INSERT INTO critic_reviews (
				review_id, run_id, generation, phase, artifact_hash, attempt_key, reviewer_vendor,
				reviewer_model, manifest_path, findings_count, has_p1, reviewed_at, findings_json, report_artifact
			) VALUES ('rev-1', ?, 1, 'qa', 'art-hash-1', 'att-1', 'anthropic', 'claude', 'manifest.json', 0, 0, ?, '[]', 'art-hash-1')`,
		).run(runId, now);

		db.prepare(
			`INSERT INTO optional_role_executions (
				run_id, task_id, role_id, insertion_point, generation, status, summary, executed_at
			) VALUES (?, 'task-0', 'security-reviewer', 'post-implement', 1, 'COMPLETED', 'clean', ?)`,
		).run(runId, now);

		db.prepare(
			`INSERT INTO task_plans (
				run_id, plan_policy_hash, task_manifest_hash, base_commit_sha, slices_json, integration_order_json, is_parallel, created_at
			) VALUES (?, 'policy-1', 'manifest-1', 'abc1234', '[]', '["task-0"]', 0, ?)`,
		).run(runId, now);

		db.prepare(
			`INSERT INTO dag_tasks (
				task_id, run_id, title, target_package, path_prefixes_json, depends_on_json, status,
				integration_order, worktree_subdir, base_commit_sha, target_tree_sha
			) VALUES ('task-0', ?, 'Task 0', 'root', '["tools/agent-sdlc"]', '[]', 'COMPLETED', 0, 'worktrees/task-0', 'abc1234', 'def5678')`,
		).run(runId);

		db.prepare(
			`INSERT INTO reconciliations (
				reconciliation_id, run_id, integration_order_json, reconciled_tree_sha, status, reconciled_at
			) VALUES ('rec-1', ?, '["task-0"]', 'def5678', 'SUCCEEDED', ?)`,
		).run(runId, now);

		db.prepare(
			`INSERT INTO diagnostics (diagnostic_id, run_id, task_id, kind, payload_json, created_at)
			 VALUES ('diag-1', ?, 'task-0', 'preflight', '{"ok":true}', ?)`,
		).run(runId, now);

		db.prepare(
			`INSERT INTO candidate_learnings (
				candidate_id, run_id, task_id, generation, source_phase, learning_type, learning_key,
				scope, query, insight, confidence, source, created_at
			) VALUES ('cand-1', ?, 'task-0', 1, 'qa', 'pattern', 'key-1', 'tools', 'query', 'insight', 90, 'critic', ?)`,
		).run(runId, now);

		db.prepare(
			`INSERT INTO learning_outbox (
				outbox_id, run_id, runtime_revision, learning_key, payload_json, created_at
			) VALUES ('out-1', ?, 1, 'key-1', '{}', ?)`,
		).run(runId, now);

		db.prepare(
			`INSERT INTO prompt_friction_findings (
				finding_id, run_id, role_id, signal_type, category, finding_key, status,
				attribution_layer, evidence_json, created_at, updated_at
			) VALUES ('pf-1', ?, 'implementer', 'retry', 'schema', 'fk-1', 'PROVISIONAL', 'layer1', '{}', ?, ?)`,
		).run(runId, now, now);

		db.prepare(
			`INSERT INTO continuation_attempts (run_id, blocked_reason, attempts, policy_fingerprint, updated_at)
			 VALUES (?, 'none', 1, 'fp-1', ?)`,
		).run(runId, now);

		db.prepare(
			`INSERT INTO continuation_projections (run_id, runtime_revision, projection_revision, status_json, created_at)
			 VALUES (?, 1, 1, '{"state":"DONE"}', ?)`,
		).run(runId, now);

		const bigBlob = crypto.randomBytes(65536);
		for (let i = 0; i < 8; i += 1) {
			db.prepare(
				`INSERT INTO checkpoints (
					thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
					checkpoint_type, checkpoint, metadata_type, metadata
				) VALUES (?, '', ?, NULL, 'json', ?, 'json', ?)`,
			).run(`thread-${runId}`, `cp-${i}`, bigBlob, Buffer.from('{}'));
			db.prepare(
				`INSERT INTO checkpoint_writes (
					thread_id, checkpoint_ns, checkpoint_id, task_id, write_index, channel, value_type, value
				) VALUES (?, '', ?, 'task-0', ?, 'state', 'json', ?)`,
			).run(`thread-${runId}`, `cp-${i}`, i, bigBlob);
		}
	} finally {
		db.close();
	}
}

// @ac AC-04
test('AC-04: compactRunDatabase drops checkpoint tables via VACUUM INTO and verifies all retained tables', async (t) => {
	// @case AC-04.1
	// @case AC-04.2
	await t.test(
		'AC-04.1 & AC-04.2: compacted database passes PRAGMA integrity_check, drops checkpoints and checkpoint_writes, and preserves every retained table row count',
		() => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdlc-compact-'));
			try {
				const sourcePath = path.join(dir, 'source.sqlite');
				const targetPath = path.join(dir, 'target.sqlite');
				createSeededRunDatabase(sourcePath);

				const sourceSize = fs.statSync(sourcePath).size;
				const verification = compactRunDatabase(sourcePath, targetPath);
				const targetSize = fs.statSync(targetPath).size;

				assert.equal(verification.integrity, 'ok');
				assert.ok(targetSize < sourceSize, `expected ${targetSize} < ${sourceSize}`);
				assert.equal(verification.retainedTables.includes('checkpoints'), false);
				assert.equal(verification.retainedTables.includes('checkpoint_writes'), false);
				assert.equal(verification.rowCounts.runs, 1);
				assert.equal(verification.rowCounts.events, 1);
				assert.equal(verification.rowCounts.critic_reviews, 1);
				assert.equal(verification.rowCounts.prompt_friction_findings, 1);
				assert.equal(verification.rowCounts.candidate_learnings, 1);
				assert.equal(verification.rowCounts.dag_tasks, 1);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	await t.test('rejects compacted database when a retained table row count mismatches', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdlc-compact-mismatch-'));
		try {
			const sourcePath = path.join(dir, 'source.sqlite');
			const targetPath = path.join(dir, 'target.sqlite');
			createSeededRunDatabase(sourcePath);

			assert.throws(
				() =>
					compactRunDatabase(sourcePath, targetPath, {
						beforeVerify(compactedPath) {
							const db = new DatabaseSync(compactedPath);
							try {
								db.exec('DELETE FROM events');
							} finally {
								db.close();
							}
						},
					}),
				(error) => error.code === 'STORE_CORRUPT' && /events/.test(error.message),
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
