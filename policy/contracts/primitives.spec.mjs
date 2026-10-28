import assert from 'node:assert/strict';
import test from 'node:test';
import { assertClosedContract, canonicalJson, sha256, validateRunId } from './primitives.ts';

test('canonical JSON normalizes Unicode, line endings, keys, and omitted fields', () => {
	const left = { z: undefined, b: 'cafe\u0301\r\n', a: 1 };
	const right = { a: 1, b: 'café\n' };
	assert.equal(canonicalJson(left), canonicalJson(right));
	assert.equal(sha256(left), sha256(right));
});

test('run ID contracts fail closed', () => {
	assert.equal(validateRunId('2026-09-04-example-run'), '2026-09-04-example-run');
	assert.throws(() => validateRunId('../escape'), /YYYY-MM-DD/);
});

test('closed contract helper rejects a non-object and an unknown field', () => {
	assert.throws(() => assertClosedContract(null, [], 'sample'), /must be an object/);
	assert.throws(() => assertClosedContract({ extra: 1 }, [], 'sample'), /unknown field 'extra'/);
	assert.doesNotThrow(() => assertClosedContract({}, [], 'sample'));
});
