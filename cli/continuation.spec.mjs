import assert from 'node:assert/strict';
import test from 'node:test';
import { computeContinuation, isInfrastructureContinuation, isRunDeadlineHalt } from './continuation.ts';

test('a null state returns the HALTED stop', () => {
	assert.deepEqual(computeContinuation(null), { action: 'stop', reason: 'HALTED' });
});

test('a BLOCKED state with no blockedReason stops', () => {
	assert.equal(isInfrastructureContinuation({ state: 'BLOCKED' }), false);
	assert.deepEqual(computeContinuation({ state: 'BLOCKED' }), { action: 'stop', reason: 'HALTED' });
});

test('a run-deadline halt is not an infrastructure continuation', () => {
	const state = { state: 'BLOCKED', blockedReason: 'GOVERNOR_RUN_DEADLINE_EXPIRED' };
	assert.equal(isRunDeadlineHalt(state), true);
	assert.equal(isInfrastructureContinuation(state), false);
	assert.deepEqual(computeContinuation(state), { action: 'stop', reason: 'HALTED' });
});
