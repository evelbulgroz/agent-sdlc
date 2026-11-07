import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
	addLearningBatch,
	addLearningEntry,
	loadLearningStore,
	resolveLearningStorePath,
	validateLearningEntry,
} from './learnings.ts';

const SCOPES = { learnings: { filePath: '.learnings.jsonl', scopes: ['billing', 'strength', 'api-gateway'] } };
const entry = (key, extra = {}) => ({
	type: 'pitfall',
	key,
	scope: 'billing',
	query: `${key} query`,
	insight: `${key} insight`,
	...extra,
});

function withDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), 'sdlc-learnings-'));
	return Promise.resolve()
		.then(() => fn(dir, join(dir, '.learnings.jsonl')))
		.finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('store path precedence: --store, then AGENT_SDLC_LEARNINGS_PATH, then profile filePath, then default', async () => {
	await withDir(async (dir) => {
		const saved = process.env.AGENT_SDLC_LEARNINGS_PATH;
		try {
			delete process.env.AGENT_SDLC_LEARNINGS_PATH;
			assert.equal(await resolveLearningStorePath({ rootDir: dir }, dir), resolve(dir, '.learnings.jsonl'));
			assert.equal(
				await resolveLearningStorePath({ profile: { schemaVersion: '1.4.0', adapter: 'default', learnings: { filePath: 'x/l.jsonl' } } }, dir),
				resolve(dir, 'x/l.jsonl'),
			);
			process.env.AGENT_SDLC_LEARNINGS_PATH = join(dir, 'env.jsonl');
			assert.equal(await resolveLearningStorePath({ rootDir: dir }, dir), join(dir, 'env.jsonl'));
			assert.equal(await resolveLearningStorePath({ store: join(dir, 'flag.jsonl'), rootDir: dir }, dir), join(dir, 'flag.jsonl'));
		} finally {
			if (saved === undefined) delete process.env.AGENT_SDLC_LEARNINGS_PATH;
			else process.env.AGENT_SDLC_LEARNINGS_PATH = saved;
		}
	});
});

test('validation applies defaults and rejects missing fields, non-kebab keys, unknown scopes, long insights, bad confidence and source', async () => {
	const ok = await validateLearningEntry(entry('workout-lock-race'), SCOPES);
	assert.equal(ok.valid, true);
	assert.equal(ok.normalized.confidence, 8);
	assert.equal(ok.normalized.source, 'observed');
	assert.ok(ok.normalized.ts);

	for (const field of ['type', 'key', 'scope', 'query', 'insight']) {
		const raw = entry('some-key');
		delete raw[field];
		const res = await validateLearningEntry(raw, SCOPES);
		assert.equal(res.valid, false, `missing ${field}`);
		assert.ok(res.errors.some((message) => message.includes(field)));
	}
	for (const key of ['WorkoutLock', 'workout_lock', 'workout lock', '-workout', 'workout-', '']) {
		assert.equal((await validateLearningEntry(entry(key), SCOPES)).valid, false, `key "${key}"`);
	}
	for (const scope of ['nested/scope/path', 'unknown-scope', 'frontend']) {
		const res = await validateLearningEntry(entry('scoped', { scope }), SCOPES);
		assert.equal(res.valid, false, `scope "${scope}"`);
		assert.ok(res.errors.some((message) => message.includes('scope')));
	}
	assert.equal((await validateLearningEntry(entry('g', { scope: 'global' }), SCOPES)).valid, true);
	assert.equal((await validateLearningEntry(entry('long', { insight: 'A'.repeat(300) }), SCOPES)).valid, true);
	const tooLong = await validateLearningEntry(entry('long', { insight: 'A'.repeat(301) }), SCOPES);
	assert.ok(tooLong.errors.some((message) => message.includes('300 characters')));
	assert.equal((await validateLearningEntry(entry('c', { confidence: 15 }), SCOPES)).valid, false);
	assert.equal((await validateLearningEntry(entry('s', { source: 'hallucinated' }), SCOPES)).valid, false);
});

test('add rejects a duplicate key without upsert and replaces with upsert, refreshing ts', async () => {
	await withDir(async (_dir, store) => {
		await addLearningEntry(store, entry('dup-key', { ts: '2020-01-01T00:00:00.000Z' }), SCOPES);
		await assert.rejects(() => addLearningEntry(store, entry('dup-key'), SCOPES), /already exists/);
		await addLearningEntry(store, entry('dup-key', { insight: 'Replaced' }), { upsert: true, ...SCOPES });
		const rows = await loadLearningStore(store);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].insight, 'Replaced');
		assert.notEqual(rows[0].ts, '2020-01-01T00:00:00.000Z');
	});
});

test('batch ingests an array or a candidates envelope in one write', async () => {
	await withDir(async (_dir, store) => {
		const added = await addLearningBatch(store, [entry('batch-one'), entry('batch-two', { scope: 'strength' })], SCOPES);
		assert.deepEqual(added.map((item) => item.key), ['batch-one', 'batch-two']);
		await addLearningBatch(store, { candidates: [entry('envelope-one', { scope: 'api-gateway' })] }, SCOPES);
		assert.deepEqual((await loadLearningStore(store)).map((item) => item.key), ['batch-one', 'batch-two', 'envelope-one']);
		await assert.rejects(() => addLearningBatch(store, 'nope', SCOPES), /array of learnings/);
	});
});

test('batch fails closed: an invalid item, an intra-batch duplicate or a store collision leaves the store byte-identical', async () => {
	await withDir(async (_dir, store) => {
		await addLearningEntry(store, entry('existing-key', { insight: 'Untouched' }), SCOPES);
		const before = readFileSync(store, 'utf-8');
		await assert.rejects(
			() => addLearningBatch(store, [entry('valid-one'), entry('bad-type', { type: 'invalid-type-xyz' })], SCOPES),
			/Validation failed for item 2/,
		);
		await assert.rejects(
			() => addLearningBatch(store, [entry('same-key'), entry('same-key', { scope: 'strength' })], SCOPES),
			/Duplicate key "same-key" within batch payload/,
		);
		await assert.rejects(
			() => addLearningBatch(store, [entry('new-key'), entry('existing-key')], { upsert: false, ...SCOPES }),
			/Key "existing-key" already exists/,
		);
		assert.equal(readFileSync(store, 'utf-8'), before);
	});
});

test('batch upsert replaces existing keys and appends new ones', async () => {
	await withDir(async (_dir, store) => {
		await addLearningEntry(store, entry('upsert-key', { ts: '2020-01-01T00:00:00.000Z' }), SCOPES);
		await addLearningBatch(store, [entry('upsert-key', { type: 'pattern', insight: 'Updated' }), entry('brand-new')], { upsert: true, ...SCOPES });
		const rows = await loadLearningStore(store);
		assert.equal(rows.length, 2);
		const updated = rows.find((row) => row.key === 'upsert-key');
		assert.equal(updated.insight, 'Updated');
		assert.equal(updated.type, 'pattern');
		assert.notEqual(updated.ts, '2020-01-01T00:00:00.000Z');
	});
});

test('loading a store with a malformed line names the line number', async () => {
	await withDir(async (_dir, store) => {
		writeFileSync(store, `${JSON.stringify(entry('ok-one'))}\n{bad\n`);
		await assert.rejects(() => loadLearningStore(store), /line 2/);
	});
});
