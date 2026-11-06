import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { buildTimeline } from '../scripts/run-timeline.ts';
import { applyBaselineSchema } from './migrations/baseline-schema.ts';
import { applyQualitySchema } from './quality-storage.ts';
import { readSpans, timedExec, timedSpan } from './run-spans.ts';

test('timedExec records command spans without argument leakage, passes results and errors through, and is a no-op without a store', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spans-'));
	try {
		const store = { databasePath: path.join(dir, 'runtime.sqlite') };
		const exec = timedExec(store, (command, args) => {
			if (command === '/usr/bin/fail') throw new Error('nope');
			return `${command}:${args.length}`;
		});
		assert.equal(exec('/usr/bin/pnpm', ['vitest', 'run', 'secret-token-argument']), '/usr/bin/pnpm:3');
		assert.throws(() => exec('/usr/bin/fail', []), /nope/);
		const spans = readSpans(store.databasePath);
		assert.deepEqual(spans.map((s) => [s.kind, s.label, s.ok]), [['tool', 'pnpm vitest', true], ['tool', 'fail', false]]);
		const plain = () => 'x';
		assert.equal(timedExec(null, plain), plain);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('timedSpan records successful and failed work beside the store and never breaks it', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spans-'));
	try {
		const store = { databasePath: path.join(dir, 'runtime.sqlite') };
		assert.equal(await timedSpan(store, 'implementer', 'a', async () => 7), 7);
		await assert.rejects(timedSpan(store, 'prepare', 'b', () => { throw new Error('boom'); }), /boom/);
		fs.appendFileSync(path.join(dir, 'spans.jsonl'), '{"torn":');
		const spans = readSpans(store.databasePath);
		assert.deepEqual(spans.map((s) => [s.kind, s.label, s.ok]), [['implementer', 'a', true], ['prepare', 'b', false]]);
		assert.equal(await timedSpan({}, 'prepare', 'c', () => 1), 1);
		assert.equal(await timedSpan(null, 'prepare', 'd', () => 2), 2);
		fs.chmodSync(dir, 0o500);
		assert.equal(await timedSpan(store, 'prepare', 'e', () => 3), 3);
	} finally {
		fs.chmodSync(dir, 0o700);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('timeline includes engine spans by kind', () => {
	const db = new DatabaseSync(':memory:');
	applyBaselineSchema(db);
	applyQualitySchema(db);
	const summary = buildTimeline(db, 'r1', [
		{ kind: 'implementer', label: 't1 attempt 1 step 0', startedAt: '2026-11-05T10:00:00.000Z', finishedAt: '2026-11-05T10:00:30.000Z', ok: true },
		{ kind: 'prepare', label: 'hydrate', startedAt: '2026-11-05T10:00:30.000Z', finishedAt: '2026-11-05T10:01:00.000Z', ok: false },
	]);
	assert.equal(summary.spanMsByKind.implementer, 30_000);
	assert.equal(summary.entries[1]?.label, 'hydrate (failed)');
});
