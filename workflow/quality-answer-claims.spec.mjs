import assert from 'node:assert/strict';
import test from 'node:test';
import { materializeInlineClaims } from './quality-answer-claims.ts';

const bindingHash = 'a'.repeat(64);
const evidence = 'b'.repeat(64);
const store = () => {
	const written = [];
	return { written, writeJson: (type, payload) => { written.push({ type, payload }); return `${written.length}`.padStart(64, '0'); } };
};

test('@ac AC-04 @case AC-04.1 inline claims become bound claim-evidence artifacts on a refute answer', () => {
	const artifacts = store();
	const out = materializeInlineClaims({
		action: 'refute', bindingHash, findingIds: ['f1'],
		claims: [{ findingId: 'f1', rationale: 'out of scope', evidenceHashes: [evidence] }],
	}, artifacts);
	assert.equal(out.claims, undefined);
	assert.equal(out.evidenceHashes.length, 1);
	assert.deepEqual(artifacts.written[0], { type: 'quality-claim-evidence', payload: {
		schemaVersion: '1.0.0', bindingHash, findingId: 'f1', rationale: 'out of scope', evidenceHashes: [evidence] } });
});

test('@ac AC-04 @case AC-04.2 inline claims are rejected off-refute, malformed, or unbound', () => {
	const claims = [{ findingId: 'f1', rationale: 'r', evidenceHashes: [evidence] }];
	assert.throws(() => materializeInlineClaims({ action: 'confirm', bindingHash, claims }, store()), /only valid on a refute/);
	assert.throws(() => materializeInlineClaims({ action: 'refute', claims }, store()), /only valid on a refute/);
	assert.throws(() => materializeInlineClaims({ action: 'refute', bindingHash, claims: [{ findingId: 'f1' }] }, store()), /malformed/);
	assert.throws(() => materializeInlineClaims({ action: 'refute', bindingHash, claims: [{ ...claims[0], extra: 1 }] }, store()), /malformed/);
});

test('@ac AC-04 @case AC-04.3 answers without claims pass through unchanged', () => {
	const answer = { action: 'confirm', bindingHash };
	assert.deepEqual(materializeInlineClaims(answer, store()), answer);
});
