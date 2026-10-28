import assert from 'node:assert/strict';
import test from 'node:test';
import * as criticGate from './critic-gate.ts';
import { isTouchedTestFile, qaArtifactHash } from './critic-gate.ts';

test('@ac AC-04 @case AC-04.3 critic-gate exports the runners and none of the retired code-critic helpers', () => {
	for (const retired of [
		'runCodeCritic',
		'codeAttemptKey',
		'shouldRunResidualCodeCritic',
		'sha256Artifact',
		'assessCriticReview',
	]) {
		assert.equal(retired in criticGate, false, `${retired} must not be exported`);
	}
	for (const kept of ['runSpecCritic', 'runPlanCritic', 'runQaCritic']) {
		assert.equal(typeof criticGate[kept], 'function', `${kept} must stay exported`);
	}
});

test('qaArtifactHash binds the approved spec to the preflight result', () => {
	const hash = qaArtifactHash({
		approvedSpecHash: 'a'.repeat(64),
		preflightResultHash: 'e'.repeat(64),
	});
	assert.equal(hash.length, 64);
	assert.notEqual(
		hash,
		qaArtifactHash({ approvedSpecHash: 'b'.repeat(64), preflightResultHash: 'e'.repeat(64) }),
	);
});

test('isTouchedTestFile recognizes spec files and rejects blanks and production paths', () => {
	assert.equal(isTouchedTestFile('apps/services/conditioning/src/feature.spec.ts'), true);
	assert.equal(isTouchedTestFile('apps\\services\\conditioning\\test\\feature.ts'), true);
	assert.equal(isTouchedTestFile('apps/services/conditioning/src/feature.ts'), false);
	assert.equal(isTouchedTestFile(''), false);
	assert.equal(isTouchedTestFile(null), false);
});
