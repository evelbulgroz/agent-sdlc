import test from 'node:test';
import assert from 'node:assert/strict';

test('@case AC-01.1 adds numbers', () => {
	assert.equal(1 + 1, 2);
});

test('@case AC-01.2 rejects a planted failure', () => {
	assert.equal(1 + 1, 3);
});

test('@case AC-02.1 stays green', () => {});
