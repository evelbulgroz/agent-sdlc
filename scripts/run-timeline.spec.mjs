import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { applyBaselineSchema } from '../persistence/migrations/baseline-schema.ts';
import { applyQualitySchema } from '../persistence/quality-storage.ts';
import { buildTimeline, renderTimeline } from './run-timeline.ts';

test('timeline attributes wall time to events and sums evidence spans', () => {
	const db = new DatabaseSync(':memory:');
	applyBaselineSchema(db);
	applyQualitySchema(db);
	db.prepare(
		`INSERT INTO runs (
			run_id, thread_id, runtime_revision, projection_revision,
			state, state_hash, state_json, semantic_repairs_count, created_at, updated_at
		) VALUES ('r1', 't1', 1, 1, 'DONE', 'h', '{}', 0, '2026-11-05T10:00:00Z', '2026-11-05T10:00:00Z')`,
	).run();
	const event = db.prepare(
		`INSERT INTO events (event_id, run_id, runtime_revision, event_type, event_json, created_at)
		 VALUES (?, 'r1', ?, ?, '{}', ?)`,
	);
	event.run('e1', 0, 'RUN_INITIALIZED', '2026-11-05T10:00:00.000Z');
	event.run('e2', 1, 'TASK_COMPLETED', '2026-11-05T10:01:00.000Z');
	event.run('e3', 2, 'AC_COVERAGE_PASSED', '2026-11-05T10:01:05.000Z');
	db.prepare(
		`INSERT INTO quality_records (run_id, kind, record_id, content_hash, record_json, status)
		 VALUES ('r1', 'completion', 'op1', 'h', ?, 'failed')`,
	).run(JSON.stringify({ invocation: {
		operationId: 'op1', status: 'failed', failureReason: 'evidence-cases-failed',
		startedAt: '2026-11-05T10:00:10.000Z', finishedAt: '2026-11-05T10:00:50.000Z',
	} }));

	const summary = buildTimeline(db, 'r1');
	assert.deepEqual(summary.eventIntervals, [
		{ label: 'TASK_COMPLETED', ms: 60000 },
		{ label: 'AC_COVERAGE_PASSED', ms: 5000 },
	]);
	assert.equal(summary.spanMsByKind.evidence, 40000);
	assert.equal(summary.endMs - summary.startMs, 65000);
	assert.match(renderTimeline(summary), /evidence-cases-failed/);
	assert.equal(buildTimeline(db, 'missing').entries.length, 0);
});
