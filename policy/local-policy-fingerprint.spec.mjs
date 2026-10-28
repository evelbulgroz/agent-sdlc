import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	effectiveContinuationAttempts,
	localPolicyChanged,
	localPolicyFingerprint,
} from './local-policy-fingerprint.ts';

function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'local-policy-fingerprint-'));
}

test('local policy fingerprint is stable for a missing file and for key order', () => {
	const dir = tempDir();
	const missing = path.join(dir, 'missing.json');
	assert.equal(localPolicyFingerprint(dir, missing), localPolicyFingerprint(dir, missing));

	const file = path.join(dir, 'local-policy.json');
	fs.writeFileSync(file, '{"b":1,"a":{"d":true,"c":false}}\n');
	const first = localPolicyFingerprint(dir, file);
	fs.writeFileSync(file, '{"a":{"c":false,"d":true},"b":1}\n');
	assert.equal(localPolicyFingerprint(dir, file), first);

	fs.writeFileSync(file, '{"a":{"c":true,"d":true},"b":1}\n');
	assert.notEqual(localPolicyFingerprint(dir, file), first);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('invalid local policy json is a distinct fingerprint from an absent file', () => {
	const dir = tempDir();
	const file = path.join(dir, 'local-policy.json');
	const absent = localPolicyFingerprint(dir, file);
	fs.writeFileSync(file, '');
	const empty = localPolicyFingerprint(dir, file);
	assert.notEqual(empty, absent);
	fs.writeFileSync(file, '{');
	assert.notEqual(localPolicyFingerprint(dir, file), empty);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('a legacy continuation row changes only when the policy file is newer', () => {
	const dir = tempDir();
	const file = path.join(dir, 'local-policy.json');
	const legacy = {
		attempts: 2,
		policyFingerprint: null,
		updatedAt: '2099-01-01T00:00:00.000Z',
	};
	assert.equal(localPolicyChanged(legacy, dir, file), false);
	assert.equal(effectiveContinuationAttempts(legacy, dir, file), 2);

	fs.writeFileSync(file, '{"routes":[{"id":"xai-grok-quality","enabled":false}]}\n');
	const stale = { ...legacy, updatedAt: '2000-01-01T00:00:00.000Z' };
	assert.equal(localPolicyChanged(stale, dir, file), true);
	assert.equal(effectiveContinuationAttempts(stale, dir, file), 0);

	const current = localPolicyFingerprint(dir, file);
	const bound = { attempts: 2, policyFingerprint: current, updatedAt: stale.updatedAt };
	assert.equal(localPolicyChanged(bound, dir, file), false);
	assert.equal(effectiveContinuationAttempts(bound, dir, file), 2);
	fs.rmSync(dir, { recursive: true, force: true });
});
