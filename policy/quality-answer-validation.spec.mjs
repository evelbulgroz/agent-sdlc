import assert from 'node:assert/strict';
import test from 'node:test';
import { validateQualityAnswerClaims } from './quality-answer-validation.ts';

const H = 'a'.repeat(64), E = 'b'.repeat(64);
const answer = { action: 'refute', bindingHash: H, findingIds: ['first', 'second'], evidenceHashes: [H] };
const request = { status: 'FAIL', findings: [{ findingId: 'first' }, { findingId: 'second' }] };
test('refutation evidence must bind and address each pending claim', () => {
	const claim = { schemaVersion: '1.0.0', bindingHash: H, findingId: 'first',
		rationale: 'The exact case disproves this claim.', evidenceHashes: [E] };
	const artifacts = { readJson: () => claim, read: () => 'underlying reproduction' };
	assert.throws(() => validateQualityAnswerClaims(answer, request, artifacts), /every claim/);
	validateQualityAnswerClaims({ ...answer, evidenceHashes: [H, E] }, request, {
		...artifacts, readJson: hash => ({ ...claim, findingId: hash === H ? 'first' : 'second' }),
	});
	assert.throws(() => validateQualityAnswerClaims(answer, request, {
		...artifacts, readJson: () => ({ ...claim, bindingHash: E }),
	}), /foreign/);
	assert.throws(() => validateQualityAnswerClaims(answer, request));
	assert.throws(() => validateQualityAnswerClaims(answer, { ...request, failureId: 'failure-a' }, artifacts));
});
