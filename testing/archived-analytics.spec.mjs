import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { applyBaselineSchema } from '../persistence/migrations/baseline-schema.ts';
import { sweepRuns } from '../persistence/run-archive.ts';
import { archiveRoot, liveRunRoot } from '../persistence/run-paths.ts';
import {
	listRunDatabases,
	readDatabaseFindings,
	readSkillsDatabaseFindings,
} from '../scripts/critic-trends-sources.ts';
import { aggregateFingerprints, summarizeRun } from '../scripts/trace-summary.ts';
import { readFleetFrictionSummary } from '../workflow/fleet.ts';

const FIXED_NOW = '2026-11-10T00:00:00Z';
const EIGHT_DAYS_AGO = '2026-11-02T00:00:00Z';

function seedAnalyticsRun(rootDir, runId) {
	const runDir = path.join(liveRunRoot(rootDir), runId);
	fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
	const db = new DatabaseSync(path.join(runDir, 'runtime.sqlite'));
	try {
		applyBaselineSchema(db);
		db.prepare(
			`INSERT INTO runs (
				run_id, thread_id, runtime_revision, projection_revision,
				state, state_hash, state_json, semantic_repairs_count, created_at, updated_at
			) VALUES (?, ?, 1, 1, 'FAILED', 'hash', '{}', 0, ?, ?)`,
		).run(runId, `thread-${runId}`, EIGHT_DAYS_AGO, EIGHT_DAYS_AGO);

		db.prepare(
			`INSERT INTO events (event_id, run_id, runtime_revision, event_type, event_json, created_at)
			 VALUES (?, ?, 1, 'PROMPT_FRICTION_DETECTED', '{}', ?)`,
		).run(`evt-${runId}`, runId, EIGHT_DAYS_AGO);

		db.prepare(
			`INSERT INTO critic_reviews (
				review_id, run_id, generation, phase, artifact_hash, attempt_key,
				reviewer_vendor, reviewer_model, manifest_path, findings_count, has_p1, reviewed_at, findings_json
			) VALUES (?, ?, 1, 'qa', 'art-1', 'att-1', 'anthropic', 'claude', 'manifest.json', 1, 1, ?, ?)`,
		).run(
			`rev-${runId}`,
			runId,
			EIGHT_DAYS_AGO,
			JSON.stringify([{ ruleId: 'boundary-leak', severity: 'P1' }]),
		);

		db.prepare(
			`INSERT INTO optional_role_executions (
				run_id, task_id, role_id, insertion_point, generation, status, summary, executed_at, structured_findings_json
			) VALUES (?, 'task-0', 'architect', 'post-implement', 1, 'COMPLETED', 'found 1', ?, ?)`,
		).run(
			runId,
			EIGHT_DAYS_AGO,
			JSON.stringify({ violations: [{ boundary: 'cross-service' }] }),
		);

		db.prepare(
			`INSERT INTO prompt_friction_findings (
				finding_id, run_id, role_id, signal_type, category, finding_key, status,
				attribution_layer, evidence_json, created_at, updated_at
			) VALUES (?, ?, 'implementer', 'retry', 'schema', 'shared-friction-key', 'RECOMMENDED', 'layer3', '{"count":2}', ?, ?)`,
		).run(`pf-${runId}`, runId, EIGHT_DAYS_AGO, EIGHT_DAYS_AGO);

		db.prepare(
			`INSERT INTO dag_tasks (
				task_id, run_id, title, target_package, path_prefixes_json, depends_on_json,
				status, integration_order, worktree_subdir, base_commit_sha
			) VALUES ('task-0', ?, 'Task 0', 'root', '[]', '[]', 'FAILED', 0, 'worktrees/task-0', 'abc1234')`,
		).run(runId);

		db.prepare(
			`INSERT INTO model_operations (
				operation_id, run_id, synthetic, status, usage_record_ids_json, created_at, updated_at, task_id, role_id, route_id
			) VALUES (?, ?, 0, 'SUCCEEDED', '[]', ?, ?, 'task-0', 'implementer', 'openai-gpt-5')`,
		).run(`op-${runId}`, runId, EIGHT_DAYS_AGO, EIGHT_DAYS_AGO);
	} finally {
		db.close();
	}

	fs.writeFileSync(
		path.join(runDir, 'artifacts', 'trace-1.json'),
		JSON.stringify({
			taskId: 'task-0',
			capturedAt: EIGHT_DAYS_AGO,
			failureClass: 'non-progress:repeated-rejection',
			failureFingerprint: 'fp-recurring-1',
			whyNonProgress: { repeatedInputs: ['edit_file'] },
			steps: [],
		}),
	);
}

// @ac AC-07
test('AC-07: critic trends, fleet friction, and trace summary return identical output before and after archiving', async (t) => {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdlc-archived-analytics-'));
	const runIds = [
		'2026-11-01-analytics-1',
		'2026-11-01-analytics-2',
		'2026-11-01-analytics-3',
	];
	try {
		for (const runId of runIds) {
			seedAnalyticsRun(rootDir, runId);
		}

		const beforeCritic = listRunDatabases(rootDir).flatMap(({ runId, databasePath }) =>
			readDatabaseFindings(databasePath, runId, rootDir),
		);
		const beforeSkills = listRunDatabases(rootDir).flatMap(({ runId, databasePath }) =>
			readSkillsDatabaseFindings(databasePath, runId),
		);
		const beforeFleet = readFleetFrictionSummary({ rootDir });
		const beforeSummary = summarizeRun({ rootDir, runId: runIds[0] });
		const beforeFingerprints = aggregateFingerprints({ rootDir });

		const sweep = sweepRuns({ rootDir, now: FIXED_NOW });
		assert.deepEqual(sweep.archived, runIds);
		for (const runId of runIds) {
			assert.equal(fs.existsSync(path.join(liveRunRoot(rootDir), runId)), false);
			assert.equal(fs.existsSync(path.join(archiveRoot(rootDir), runId, 'runtime.sqlite')), true);
		}

		// @case AC-07.1
		await t.test(
			'AC-07.1: critic-trends-sources returns identical critic and skills findings after archiving',
			() => {
				const afterCritic = listRunDatabases(rootDir).flatMap(({ runId, databasePath }) =>
					readDatabaseFindings(databasePath, runId, rootDir),
				);
				const afterSkills = listRunDatabases(rootDir).flatMap(({ runId, databasePath }) =>
					readSkillsDatabaseFindings(databasePath, runId),
				);
				assert.deepEqual(afterCritic, beforeCritic);
				assert.deepEqual(afterSkills, beforeSkills);
				assert.equal(afterCritic.length, 6);
				assert.equal(afterSkills.length, 3);
			},
		);

		// @case AC-07.2
		await t.test(
			'AC-07.2: readFleetFrictionSummary returns identical counts and recommendations after archiving',
			() => {
				const afterFleet = readFleetFrictionSummary({ rootDir });
				assert.deepEqual(afterFleet, beforeFleet);
				assert.equal(afterFleet.unreviewedFrictionCount, 3);
				assert.deepEqual(afterFleet.recommendedKeys, ['shared-friction-key']);
			},
		);

		// @case AC-07.3
		await t.test(
			'AC-07.3: summarizeRun and aggregateFingerprints return identical output after archiving',
			() => {
				const afterSummary = summarizeRun({ rootDir, runId: runIds[0] });
				const afterFingerprints = aggregateFingerprints({ rootDir });
				assert.deepEqual(afterSummary, beforeSummary);
				assert.deepEqual(afterFingerprints, beforeFingerprints);
			},
		);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});
