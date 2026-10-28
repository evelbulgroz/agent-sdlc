import assert from 'node:assert/strict';
import test from 'node:test';
import { exitCodeForResult, exitCodeForState } from './exit-codes.ts';

test('a null result exits 0', () => {
	assert.equal(exitCodeForResult(null), 0);
	assert.equal(exitCodeForResult(undefined), 0);
});

test('help and waiting states keep their exit codes', () => {
	assert.equal(exitCodeForState('HELP'), 0);
	assert.equal(exitCodeForResult({ state: 'HELP' }), 0);
	assert.equal(exitCodeForState('WAITING_FOR_ANSWERS'), 2);
	assert.equal(exitCodeForState('SPEC_APPROVED'), 2);
	assert.equal(exitCodeForState('FAILED'), 3);
	assert.equal(exitCodeForState('CANCELLED'), 4);
	assert.equal(exitCodeForState('DONE'), 0);
});

test('a continuation exit wins over the state exit', () => {
	assert.equal(exitCodeForResult({
		state: 'DONE',
		continuation: { action: 'resume', reason: 'INFRASTRUCTURE_RETRY' },
	}), 3);
	assert.equal(exitCodeForResult({
		state: 'READY_FOR_GIT_APPROVAL',
		continuation: { action: 'stop', reason: 'GIT_APPROVAL' },
	}), 0);
});
