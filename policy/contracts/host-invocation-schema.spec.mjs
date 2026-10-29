import assert from 'node:assert/strict';
import test from 'node:test';
import { DRAFT_FIELDS } from './draft-schema.ts';
import {
	HOST_FORBIDDEN_FLAGS,
	hostInvocationChangeSlots,
	validateContinuation,
	validateHostInvocation,
} from './host-invocation-schema.ts';

test('host invocation rejects null, a forbidden flag, and accepts a no-slot invocation', () => {
	assert.throws(() => validateHostInvocation(null), /must be an object/);
	assert.throws(() => validateHostInvocation({
		schemaVersion: '1.0.0',
		executable: true,
		packetConsumed: false,
		exitCode: 0,
		argv: ['pnpm', 'run', 'test:unit', '--push'],
		forbiddenFlags: HOST_FORBIDDEN_FLAGS,
		retry: { allowed: false, maxAdditionalInvocations: 0 },
		responseDocument: null,
		responseSlots: null,
	}), /forbidden flag/);
	const invocation = validateHostInvocation({
		schemaVersion: '1.0.0',
		executable: false,
		packetConsumed: false,
		exitCode: 0,
		argv: null,
		forbiddenFlags: HOST_FORBIDDEN_FLAGS,
		retry: { allowed: false, maxAdditionalInvocations: 0 },
		responseDocument: null,
		responseSlots: null,
	});
	assert.equal(invocation.executable, false);
	assert.equal(invocation.argv, null);
	const slots = hostInvocationChangeSlots();
	assert.equal(slots.field, 'changes');
	assert.equal(slots.targets.length, DRAFT_FIELDS.length);
	assert.deepEqual(slots.targets.map((target) => target.field), [...DRAFT_FIELDS]);
});

test('continuation contracts reject an unknown action and a null document', () => {
	assert.throws(() => validateContinuation({ action: 'fly', reason: 'HALTED' }), /Invalid continuation action/);
	assert.throws(() => validateContinuation(null), /must be an object/);
});
