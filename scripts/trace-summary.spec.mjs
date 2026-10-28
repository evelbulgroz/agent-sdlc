import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { applyBaselineSchema } from '../persistence/migrations/baseline-schema.ts';
import {
	REPOSITORY_ROOT,
	archiveRoot,
	liveRunRoot,
} from '../persistence/run-paths.ts';
import { aggregateFingerprints, summarizeRun } from './trace-summary.ts';

function writeTranscript(runDir, name, value) {
	const artifactsDir = path.join(runDir, 'artifacts');
	fs.mkdirSync(artifactsDir, { recursive: true });
	fs.writeFileSync(path.join(artifactsDir, name), JSON.stringify(value));
}

function summarize(runId, taskId) {
	return execFileSync(
		process.execPath,
		[
			path.join(REPOSITORY_ROOT, 'scripts/trace-summary.ts'),
			'--run',
			runId,
			'--task',
			taskId,
		],
		{ cwd: REPOSITORY_ROOT, encoding: 'utf8' },
	);
}

test('@ac AC-10 @case AC-10.1 @case AC-10.2 trace-summary lists attempt prompts, tool calls, and results', () => {
	const runId = `trace-summary-${Date.now()}`;
	const runDir = path.join(liveRunRoot(REPOSITORY_ROOT), runId);
	try {
		writeTranscript(runDir, 'passed.json', {
			kind: 'minimal-executor-attempt',
			taskId: 'passed-task',
			attempt: 1,
			prompt: 'PROMPT-PASSED',
			toolCalls: [
				{
					toolName: 'read_file',
					parameters: { path: 'src/note.txt' },
					result: { content: 'FILE-BODY' },
				},
			],
			failureReason: null,
			passed: true,
			wallMs: 4,
		});
		fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
		fs.writeFileSync(path.join(runDir, 'artifacts', 'broken.json'), '{');
		writeTranscript(runDir, 'failed-1.json', {
			kind: 'minimal-executor-attempt',
			taskId: 'failed-task',
			attempt: 1,
			prompt: 'PROMPT-ONE',
			toolCalls: [
				{
					toolName: 'read_file',
					parameters: { path: 'src/note.txt' },
					result: { content: 'FILE-BODY' },
				},
			],
			failureReason: 'verification-failed',
			passed: false,
			wallMs: 5,
		});
		writeTranscript(runDir, 'failed-2.json', {
			kind: 'minimal-executor-attempt',
			taskId: 'failed-task',
			attempt: 2,
			prompt: 'PROMPT-TWO',
			toolCalls: [],
			failureReason: 'verification-failed',
			passed: false,
			wallMs: 6,
		});
		const passed = summarize(runId, 'passed-task');
		assert.match(passed, /Attempt 1 passed/);
		assert.match(passed, /PROMPT-PASSED/);
		assert.match(passed, /read_file/);
		assert.match(passed, /FILE-BODY/);
		assert.equal(passed.includes('failure reason'), false);
		const failed = summarize(runId, 'failed-task');
		assert.match(failed, /Attempt 1 failed/);
		assert.match(failed, /Attempt 2 failed/);
		assert.match(failed, /failure reason: verification-failed/);
		assert.match(failed, /PROMPT-ONE/);
		assert.match(failed, /PROMPT-TWO/);
		assert.match(failed, /FILE-BODY/);
	} finally {
		fs.rmSync(runDir, { recursive: true, force: true });
	}
});

// @ac AC-07
// @case AC-07.3
test('AC-07.3: summarizeRun and aggregateFingerprints read archived runs under archiveRoot', () => {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-summary-archived-'));
	const runId = '2026-10-01-archived-trace';
	try {
		const archivedDir = path.join(archiveRoot(rootDir), runId);
		fs.mkdirSync(path.join(archivedDir, 'artifacts'), { recursive: true });
		const db = new DatabaseSync(path.join(archivedDir, 'runtime.sqlite'));
		applyBaselineSchema(db);
		db.prepare(
			`INSERT INTO runs (
				run_id, thread_id, runtime_revision, projection_revision,
				state, state_hash, state_json, semantic_repairs_count, created_at, updated_at
			) VALUES (?, ?, 1, 1, 'FAILED', 'hash', '{}', 0, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
		).run(runId, `thread-${runId}`);
		db.prepare(
			`INSERT INTO dag_tasks (
				task_id, run_id, title, target_package, path_prefixes_json, depends_on_json,
				status, integration_order, worktree_subdir, base_commit_sha
			) VALUES ('task-1', ?, 'Task 1', 'root', '[]', '[]', 'FAILED', 0, 'worktrees/task-1', 'abc')`,
		).run(runId);
		db.close();

		fs.writeFileSync(
			path.join(archivedDir, 'artifacts', 'trace-1.json'),
			JSON.stringify({
				taskId: 'task-1',
				capturedAt: '2026-10-01T00:01:00Z',
				failureClass: 'non-progress:loop',
				failureFingerprint: 'fp-archived-1',
				whyNonProgress: { repeatedInputs: ['read_file'] },
				steps: [],
			}),
		);

		const summary = summarizeRun({ rootDir, runId });
		assert.equal(summary.runId, runId);
		assert.equal(summary.tasks.length, 1);
		assert.equal(summary.traces.length, 1);
		assert.equal(summary.traces[0].fingerprint, 'fp-archived-1');

		const fingerprints = aggregateFingerprints({ rootDir });
		assert.equal(fingerprints.length, 1);
		assert.equal(fingerprints[0].fingerprint, 'fp-archived-1');
		assert.deepEqual(fingerprints[0].runs, [runId]);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});
