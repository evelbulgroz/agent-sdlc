import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSanitizedValue } from './sanitization.ts';

test('@ac AC-02 @case AC-02.5 assertSanitizedValue rejects a secret-like token without echoing it', () => {
	const secret = `sk-${'a'.repeat(12)}`;
	assert.throws(
		() => assertSanitizedValue(secret),
		(error) => {
			assert.equal(error.code, 'INVALID_CONTRACT');
			assert.equal(error.message.includes(secret), false);
			assert.match(error.message, /Secret-like corpus value is forbidden/);
			return true;
		},
	);
});

test('assertSanitizedValue accepts an empty string and ignores null', () => {
	assert.doesNotThrow(() => assertSanitizedValue(''));
	assert.doesNotThrow(() => assertSanitizedValue(null));
});
