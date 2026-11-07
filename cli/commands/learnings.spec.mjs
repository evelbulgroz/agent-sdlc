import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import { runCli } from '../cli.ts';

function withStore(entries, fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-learnings-cli-'));
	const store = path.join(dir, 'store.jsonl');
	fs.writeFileSync(store, entries.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n') + '\n');
	return Promise.resolve()
		.then(() => fn({ dir, store }))
		.finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const entry = (key, extra = {}) => ({
	type: 'pitfall',
	key,
	scope: 'global',
	query: 'sample words',
	insight: 'An insight.',
	confidence: 8,
	source: 'observed',
	ts: '2026-01-01T00:00:00.000Z',
	...extra,
});

const run = (args, dir) => runCli(['learnings', ...args, '--root', dir, '--json'], { rootDir: REPOSITORY_ROOT });

test('learnings validate passes a clean store and exits 0', async () => {
	await withStore([entry('a-one'), entry('b-two')], async ({ dir, store }) => {
		const outcome = await run(['validate', '--store', store], dir);
		assert.equal(outcome.exitCode, 0);
		assert.equal(outcome.result.valid, true);
		assert.equal(outcome.result.total, 2);
	});
});

test('learnings validate reports malformed JSON, schema errors and duplicate keys with exit 2', async () => {
	await withStore([entry('a-one'), entry('a-one'), '{bad', entry('Bad_Key')], async ({ dir, store }) => {
		const outcome = await run(['validate', '--store', store], dir);
		assert.equal(outcome.exitCode, 2);
		assert.equal(outcome.result.valid, false);
		const errors = outcome.result.errors.join('\n');
		assert.match(errors, /Duplicate key "a-one"/);
		assert.match(errors, /Malformed JSON/);
		assert.match(errors, /Invalid key "Bad_Key"/);
	});
});

test('learnings prune --missing-files is a dry run until --apply, then removes only stale entries', async () => {
	await withStore(
		[entry('stale-one', { files: ['gone.md'] }), entry('live-one', { files: ['kept.md'] })],
		async ({ dir, store }) => {
			fs.writeFileSync(path.join(dir, 'kept.md'), 'x');
			const dry = await run(['prune', '--store', store, '--missing-files'], dir);
			assert.deepEqual(dry.result.staleEntries, [{ key: 'stale-one', missingFile: 'gone.md' }]);
			assert.equal(dry.result.prunedCount, 0);
			assert.equal(fs.readFileSync(store, 'utf-8').split('\n').filter(Boolean).length, 2);
			const applied = await run(['prune', '--store', store, '--missing-files', '--apply'], dir);
			assert.equal(applied.result.prunedCount, 1);
			assert.deepEqual(fs.readFileSync(store, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l).key), ['live-one']);
		},
	);
});

test('learnings prune requires exactly one mode and rejects an unknown key', async () => {
	await withStore([entry('a-one')], async ({ dir, store }) => {
		const none = await run(['prune', '--store', store], dir);
		assert.equal(none.result.ok, false);
		assert.match(none.result.error.message, /exactly one of/);
		const missing = await run(['prune', '--store', store, '--key', 'nope'], dir);
		assert.equal(missing.result.ok, false);
		assert.match(missing.result.error.message, /not found/);
		assert.equal(fs.readFileSync(store, 'utf-8').split('\n').filter(Boolean).length, 1);
	});
});

test('learnings add rejects duplicates without --upsert and replaces with it; stats and search read the result', async () => {
	await withStore([entry('a-one')], async ({ dir, store }) => {
		const payload = path.join(dir, 'p.json');
		fs.writeFileSync(payload, JSON.stringify(entry('a-one', { insight: 'Replaced.' })));
		const dup = await run(['add', '--store', store, '--file', payload], dir);
		assert.equal(dup.result.ok, false);
		assert.match(dup.result.error.message, /already exists/);
		const ok = await run(['add', '--store', store, '--file', payload, '--upsert'], dir);
		assert.deepEqual(ok.result.added, ['a-one']);
		const stats = await run(['stats', '--store', store], dir);
		assert.equal(stats.result.total, 1);
		assert.deepEqual(stats.result.byType, { pitfall: 1 });
		const found = await run(['search', '--store', store, '--query', 'sample'], dir);
		assert.equal(found.result.results[0].insight, 'Replaced.');
	});
});

test('learnings search without --query or --scope and add without a payload are rejected', async () => {
	await withStore([entry('a-one')], async ({ dir, store }) => {
		assert.equal((await run(['search', '--store', store], dir)).result.ok, false);
		assert.equal((await run(['add', '--store', store], dir)).result.ok, false);
	});
});

test('learnings search rejects limits outside 1..20 with a non-zero exit', async () => {
	await withStore([entry('a-one')], async ({ dir, store }) => {
		for (const limit of ['0', '21', 'abc', '-1']) {
			const outcome = await runCli(['learnings', 'search', '--query', 'sample', '--limit', limit, '--store', store, '--root', dir, '--json'], { rootDir: REPOSITORY_ROOT });
			assert.notEqual(outcome.exitCode, 0, `limit ${limit}`);
			assert.match(outcome.result.error.message, /Invalid limit/);
		}
	});
});

test('learnings add reads a payload from stdin', async () => {
	await withStore([], async ({ dir, store }) => {
		const stdin = Readable.from([JSON.stringify(entry('from-stdin'))]);
		const outcome = await runCli(['learnings', 'add', '--stdin', '--store', store, '--root', dir, '--json'], {
			rootDir: REPOSITORY_ROOT,
			streams: { stdin, stdout: process.stdout, stderr: process.stderr },
		});
		assert.deepEqual(outcome.result.added, ['from-stdin']);
	});
});

test('learnings add of an invalid batch file exits non-zero and leaves the store unchanged', async () => {
	await withStore([entry('a-one')], async ({ dir, store }) => {
		const before = fs.readFileSync(store, 'utf-8');
		const batch = path.join(dir, 'candidates.json');
		fs.writeFileSync(batch, JSON.stringify({ candidates: [entry('fine-one'), entry('bad-one', { type: 'nonsense' })] }));
		const outcome = await run(['add', '--store', store, '--file', batch], dir);
		assert.notEqual(outcome.exitCode, 0);
		assert.match(outcome.result.error.message, /Validation failed for item 2/);
		assert.equal(fs.readFileSync(store, 'utf-8'), before);
	});
});
