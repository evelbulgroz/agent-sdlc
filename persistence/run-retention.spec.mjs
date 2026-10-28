import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { applyBaselineSchema } from './migrations/baseline-schema.ts';
import { liveRunRoot } from './run-paths.ts';
import { decideRunRetention, listRecordedRuns } from './run-retention.ts';

const FIXED_NOW = '2026-11-10T00:00:00Z';

function seedRunDir(rootDir, { runId, state, updatedAt, withWorktree = true }) {
	const runDir = path.join(liveRunRoot(rootDir), runId);
	fs.mkdirSync(runDir, { recursive: true });
	if (withWorktree) {
		fs.mkdirSync(path.join(runDir, 'worktree'), { recursive: true });
	}
	const db = new DatabaseSync(path.join(runDir, 'runtime.sqlite'));
	try {
		applyBaselineSchema(db);
		db.prepare(
			`INSERT INTO runs (
				run_id, thread_id, runtime_revision, projection_revision,
				state, state_hash, state_json, semantic_repairs_count, created_at, updated_at
			) VALUES (?, ?, 1, 1, ?, 'hash', '{}', 0, ?, ?)`,
		).run(runId, `thread-${runId}`, state, updatedAt, updatedAt);
	} finally {
		db.close();
	}
	return runDir;
}

// @ac AC-01
test('AC-01: decideRunRetention classifies runs across all retention cases', async (t) => {
	// @case AC-01.1
	await t.test('AC-01.1: DONE 2 days old with landed=true selects clean-merged', () => {
		const decision = decideRunRetention({
			state: 'DONE',
			updatedAt: '2026-11-08T00:00:00Z',
			now: FIXED_NOW,
			landed: true,
			hasWorktree: true,
		});
		assert.equal(decision.action, 'clean-merged');
		assert.equal(decision.skipped, false);
	});

	// @case AC-01.2
	await t.test(
		'AC-01.2: READY_FOR_GIT_APPROVAL 2 days old with landed=true selects clean-merged',
		() => {
			const decision = decideRunRetention({
				state: 'READY_FOR_GIT_APPROVAL',
				updatedAt: '2026-11-08T00:00:00Z',
				now: FIXED_NOW,
				landed: true,
				hasWorktree: true,
			});
			assert.equal(decision.action, 'clean-merged');
			assert.equal(decision.skipped, false);
		},
	);

	// @case AC-01.3
	await t.test('AC-01.3: READY_FOR_GIT_APPROVAL 2 days old with landed=false selects keep', () => {
		const decision = decideRunRetention({
			state: 'READY_FOR_GIT_APPROVAL',
			updatedAt: '2026-11-08T00:00:00Z',
			now: FIXED_NOW,
			landed: false,
			hasWorktree: true,
		});
		assert.equal(decision.action, 'keep');
		assert.equal(decision.skipped, false);
	});

	// @case AC-01.4
	await t.test('AC-01.4: any state idle for at least 7 days selects archive', () => {
		for (const state of [
			'DONE',
			'READY_FOR_GIT_APPROVAL',
			'FAILED',
			'ABORTED',
			'WAITING_FOR_SPEC_APPROVAL',
			'WAITING_FOR_ANSWERS',
			'RUNNING',
		]) {
			const exactBoundary = decideRunRetention({
				state,
				updatedAt: '2026-11-03T00:00:00Z',
				now: FIXED_NOW,
				landed: false,
				hasWorktree: true,
			});
			assert.equal(exactBoundary.action, 'archive', `expected archive for ${state} at 7d`);

			const eightDays = decideRunRetention({
				state,
				updatedAt: '2026-11-02T00:00:00Z',
				now: FIXED_NOW,
				landed: true,
				hasWorktree: true,
			});
			assert.equal(eightDays.action, 'archive', `expected archive for ${state} at 8d`);
		}
	});

	// @case AC-01.5
	await t.test(
		'AC-01.5: FAILED, ABORTED, WAITING_FOR_*, and RUNNING 6 days old select keep',
		() => {
			for (const state of [
				'FAILED',
				'ABORTED',
				'WAITING_FOR_SPEC_APPROVAL',
				'WAITING_FOR_ANSWERS',
				'RUNNING',
			]) {
				const decision = decideRunRetention({
					state,
					updatedAt: '2026-11-04T00:00:00Z',
					now: FIXED_NOW,
					landed: false,
					hasWorktree: true,
				});
				assert.equal(decision.action, 'keep', `expected keep for ${state} at 6d`);
				assert.equal(decision.skipped, false);
			}
		},
	);

	// @case AC-01.6
	await t.test('AC-01.6: landed=unknown selects keep and marks the run as skipped', () => {
		const decision = decideRunRetention({
			state: 'READY_FOR_GIT_APPROVAL',
			updatedAt: '2026-11-08T00:00:00Z',
			now: FIXED_NOW,
			landed: 'unknown',
			hasWorktree: true,
		});
		assert.equal(decision.action, 'keep');
		assert.equal(decision.skipped, true);
		assert.equal(decision.reason, 'landed-unknown');
	});

	// @case AC-01.7
	await t.test('AC-01.7: listRecordedRuns ignores folders without a matching runs row', () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdlc-retention-'));
		try {
			seedRunDir(tempRoot, {
				runId: '2026-11-08-recorded-run',
				state: 'DONE',
				updatedAt: '2026-11-08T00:00:00Z',
			});
			fs.mkdirSync(path.join(liveRunRoot(tempRoot), 'test-fixtures', 'nested'), {
				recursive: true,
			});
			fs.mkdirSync(path.join(liveRunRoot(tempRoot), '2026-11-08-missing-sqlite'), {
				recursive: true,
			});
			const emptySqliteDir = path.join(liveRunRoot(tempRoot), '2026-11-08-empty-runs');
			fs.mkdirSync(emptySqliteDir, { recursive: true });
			const emptyDb = new DatabaseSync(path.join(emptySqliteDir, 'runtime.sqlite'));
			applyBaselineSchema(emptyDb);
			emptyDb.close();

			const recorded = listRecordedRuns(tempRoot);
			assert.deepEqual(
				recorded.map((item) => item.runId),
				['2026-11-08-recorded-run'],
			);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});
