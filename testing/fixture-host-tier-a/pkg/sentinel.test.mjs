import test from 'node:test';
import assert from 'node:assert/strict';

test('@case AC-99.1 planted failure', () => {
	assert.fail('planted');
});

test('@case AC-99.2 stays green', () => {});
