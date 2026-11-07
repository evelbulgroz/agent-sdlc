import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreEntry, searchLearningStore } from './learnings.ts';

const item = (key, extra = {}) => ({
	type: 'pitfall',
	key,
	scope: 'global',
	query: 'general test pattern',
	insight: `${key} insight`,
	confidence: 10,
	...extra,
});

test('scoring oracle: key 8, query 6, insight 3 per token, scope bonuses and penalty, confidence factor', () => {
	const inScope = item('auth-dev-token', {
		scope: 'authentication',
		query: 'dev token minting credentials',
		insight: 'Integration tests require dev token minting helper.',
	});
	assert.equal(scoreEntry(inScope, ['dev', 'credentials'], 'authentication'), 38);

	const globalItem = item('in-package-esm-imports', {
		query: 'relative imports esm js extension',
		insight: 'All relative imports inside packages must include explicit .js extension.',
		confidence: 8,
	});
	assert.ok(Math.abs(scoreEntry(globalItem, ['esm'], 'billing') - 15.2) < 0.001);

	const mismatched = item('suunto-binary-parser', {
		scope: 'suunto-t6-sync',
		query: 'binary buffer parsing',
		insight: 'Buffer overflow on header.',
	});
	assert.equal(scoreEntry(mismatched, ['buffer'], 'billing'), -1);
});

test('matching is whole-word: auth does not match authentication', () => {
	const entry = item('authentication-header', {
		query: 'authentication bearer tokens',
		insight: 'Ensure authentication service is online.',
	});
	assert.equal(scoreEntry(entry, ['auth'], null), 0);
	assert.equal(scoreEntry(entry, ['authentication'], null), 17);
});

test('search drops non-positive scores and ranks by score then recency', async () => {
	const items = [
		item('item-low', { ts: '2026-08-01T10:00:00Z' }),
		item('item-high', { ts: '2026-08-02T10:00:00Z', scope: 'billing', query: 'general test pattern specific' }),
		item('item-dropped', { ts: '2026-08-03T10:00:00Z', scope: 'suunto-t6-sync', query: 'unrelated binary sync' }),
	];
	const results = await searchLearningStore(items, { query: 'test pattern', scope: 'billing' });
	assert.deepEqual(results.map((result) => result.key), ['item-high', 'item-low']);
});

test('search excludes entries below the confidence floor of 7', async () => {
	const items = [
		item('low-confidence', { confidence: 6, scope: 'billing', query: 'strong matching terms' }),
		item('accepted', { confidence: 7, scope: 'billing', query: 'strong matching terms' }),
	];
	const results = await searchLearningStore(items, { query: 'strong matching terms', scope: 'billing' });
	assert.deepEqual(results.map((result) => result.key), ['accepted']);
});

test('search limit defaults to 3, accepts 1..20 and rejects values outside it', async () => {
	const items = Array.from({ length: 25 }, (_, i) =>
		item(`item-${i}`, { ts: `2026-08-01T10:00:${String(i).padStart(2, '0')}Z`, query: 'token match test' }),
	);
	assert.equal((await searchLearningStore(items, { query: 'token' })).length, 3);
	assert.equal((await searchLearningStore(items, { query: 'token', limit: 1 })).length, 1);
	assert.equal((await searchLearningStore(items, { query: 'token', limit: 20 })).length, 20);
	for (const limit of [0, 21, -1, 'abc']) {
		await assert.rejects(() => searchLearningStore(items, { query: 'token', limit }), /Invalid limit/);
	}
});

test('search filters by allowed types; an empty filter allows all', async () => {
	const items = ['pitfall', 'pattern', 'preference', 'architecture'].map((type, i) =>
		item(`k${i + 1}`, { type, scope: 'billing', query: 'match' }),
	);
	assert.deepEqual((await searchLearningStore(items, { query: 'match', types: ['pitfall'] })).map((r) => r.key), ['k1']);
	const two = await searchLearningStore(items, { query: 'match', types: ['pitfall', 'architecture'] });
	assert.deepEqual(two.map((r) => r.key).sort(), ['k1', 'k4']);
	assert.equal((await searchLearningStore(items, { query: 'match', types: [] })).length, 3);
});
