import assert from 'node:assert/strict';
import test from 'node:test';
import { makeFixture, initialize } from '../testing/quality-test-support.ts';

test('budget reservations are idempotent, interrupted dispatch remains charged, and overrun blocks new calls', () => {
	const fixture = makeFixture('quality-budgets');
	try {
		initialize(fixture);
		const q = fixture.store.quality;
		const reserve = { operationId: 'op-0', kind: 'execution', checkpointId: 'slice-a', candidateRevision: 0, status: 'reserved' };
		q.reserveBudget(fixture.runId, reserve);
		q.reserveBudget(fixture.runId, reserve);
		assert.equal(q.getBudget(fixture.runId).counters.executionInvocations, 1);
		assert.throws(() => q.reserveBudget(fixture.runId, { ...reserve, kind: 'review' }), /collision/);
		q.chargeBudget(fixture.runId, 'op-0', { executionDurationMs: 101 }, 'interrupted');
		assert.equal(q.getBudget(fixture.runId).counters.executionDurationMs, 101);
		assert.throws(() => q.reserveBudget(fixture.runId, { ...reserve, operationId: 'op-1' }), /exhausted/);
		assert.throws(() => q.chargeBudget(fixture.runId, 'missing', {}), /no reservation/);
		assert.throws(() => q.chargeBudget(fixture.runId, 'op-0', null));
	} finally { fixture.close(); }
});

test('review ceilings apply across changed-tree candidates instead of resetting R on every revision', () => {
	const fixture = makeFixture('quality-review-budget');
	try {
		initialize(fixture);
		for (let i = 0; i < 2; i++) fixture.store.quality.reserveBudget(fixture.runId, {
			operationId: `review-${i}`, kind: 'review', checkpointId: 'slice-a', candidateRevision: i, status: 'reserved' });
		assert.throws(() => fixture.store.quality.reserveBudget(fixture.runId, {
			operationId: 'review-2', kind: 'review', checkpointId: 'slice-a', candidateRevision: 2, status: 'reserved' }), /exhausted/);
	} finally { fixture.close(); }
});
