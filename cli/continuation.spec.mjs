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

test('only a durable consumed quality answer permits recovery, and unprovable edits halt it', () => {
	const state = { state: 'BLOCKED', blockedReason: 'QUALITY_REVIEW_BLOCKED', pendingInterruptId: 'quality-a' };
	assert.deepEqual(computeContinuation(state), { action: 'answer', reason: 'HUMAN_RESPONSE_REQUIRED' });
	assert.deepEqual(computeContinuation(state, { qualityAnswerRecorded: true }),
		{ action: 'resume', reason: 'INFRASTRUCTURE_RETRY' });
	assert.deepEqual(computeContinuation({
		...state, lastError: { metadata: { qualityRecoveryAllowed: false } },
	}, { qualityAnswerRecorded: true }), { action: 'stop', reason: 'HALTED' });
	assert.deepEqual(computeContinuation(state, {
		qualityAnswerRecorded: true, qualityRecoveryHalted: true,
	}), { action: 'stop', reason: 'HALTED' });
});
