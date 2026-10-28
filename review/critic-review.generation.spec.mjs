import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CriticReviewAdapter, computeScopeDigest } from './critic-review.ts';
import { FakeGovernorForCritic } from '../testing/critic-fixtures.mjs';
import { makeFixture } from '../testing/test-support.mjs';

test('executeReview advances generation when a prior critic operation for the run and phase failed in the ledger', async (t) => {
	const runId = '2026-09-24-test-failed-op-resume';
	const fixture = makeFixture('critic-failed-op-resume', []);
	t.after(() => fixture.close());
	const runsDir = path.join(fixture.runtimeDir, 'tools/.model-usage/runs');
	fs.mkdirSync(runsDir, { recursive: true });
	const scopeDigest = computeScopeDigest('');
	const failedOpId = `${runId}:critic:spec:${scopeDigest}:g0`;
	fs.writeFileSync(
		path.join(runsDir, `${runId}.json`),
		JSON.stringify({
			runId,
			operations: {
				[failedOpId]: {
					state: 'failed',
					attribution: { generation: 0, phase: 'spec' },
				},
			},
		}),
		'utf8',
	);

	const governor = new FakeGovernorForCritic();
	const adapter = new CriticReviewAdapter({
		rootDir: fixture.runtimeDir,
		governor,
	});

	const result = await adapter.executeReview({
		runId,
		generation: 0,
		phase: 'spec',
		authorVendor: 'google',
		documentText: '# Spec: Test',
		rubric: '# Spec Rubric',
	});

	assert.equal(result.generation, 1);
	assert.equal(governor.calls.length, 1);
	assert.equal(governor.calls[0].operationId, `${runId}:critic:spec:${scopeDigest}:g1`);
	assert.equal(governor.calls[0].attribution.generation, 1);
});

test('executeReview preserves generation when prior operation succeeded in the ledger', async (t) => {
	const runId = '2026-09-24-test-succeeded-op-replay';
	const fixture = makeFixture('critic-succeeded-op-replay', []);
	t.after(() => fixture.close());
	const runsDir = path.join(fixture.runtimeDir, 'tools/.model-usage/runs');
	fs.mkdirSync(runsDir, { recursive: true });
	const scopeDigest = computeScopeDigest('');
	const succeededOpId = `${runId}:critic:spec:${scopeDigest}:g0`;
	fs.writeFileSync(
		path.join(runsDir, `${runId}.json`),
		JSON.stringify({
			runId,
			operations: {
				[succeededOpId]: {
					state: 'succeeded',
					attribution: { generation: 0, phase: 'spec' },
				},
			},
		}),
		'utf8',
	);

	const governor = new FakeGovernorForCritic();
	const adapter = new CriticReviewAdapter({
		rootDir: fixture.runtimeDir,
		governor,
	});

	const result = await adapter.executeReview({
		runId,
		generation: 0,
		phase: 'spec',
		authorVendor: 'google',
		documentText: '# Spec: Test',
		rubric: '# Spec Rubric',
	});

	assert.equal(result.generation, 0);
	assert.equal(governor.calls.length, 1);
	assert.equal(governor.calls[0].operationId, `${runId}:critic:spec:${scopeDigest}:g0`);
});
