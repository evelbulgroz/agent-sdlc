import assert from 'node:assert/strict';
import test from 'node:test';
import { specificationSynthesisCapability } from './specification-synthesis.ts';

test('governed-structured-synthesis-v1 buildPrompt partitions unresolved fields and forbids questions when complete', () => {
	const capability = specificationSynthesisCapability;

	// 1. Complete draft (0 unresolved fields)
	const promptComplete = capability.buildPrompt({
		promptPolicy: 'You are specifier.',
		draft: { goal: 'test' },
		completeness: { complete: true, missingFields: [], ambiguousFields: [] },
		maxQuestions: 3,
		criticFindings: [{ findingId: 'F1', severity: 'P1', description: 'Fix grammar' }],
	});
	assert.match(promptComplete, /All required specification fields are populated in the draft\./);
	assert.match(promptComplete, /You MUST NOT return any questions \(set 'questions: \[\]'\)\./);
	assert.match(promptComplete, /Propose all needed remediations, refinements, or critic fixes in 'patch'\./);
	assert.match(promptComplete, /All critic remediations must be made via the `patch` array/);
	assert.doesNotMatch(promptComplete, /verificationPlan/);

	// 2. Exactly 1 unresolved field
	const promptOne = capability.buildPrompt({
		promptPolicy: 'You are specifier.',
		draft: { goal: 'test' },
		completeness: { complete: false, missingFields: ['verificationPlan'], ambiguousFields: [] },
		maxQuestions: 3,
	});
	assert.match(promptOne, /There is only 1 unresolved field remaining: 'verificationPlan'\./);
	assert.match(promptOne, /You can propose an initial starter draft for 'verificationPlan' in 'patch'/);
	assert.match(promptOne, /Do NOT target already-resolved fields like 'goal'\./);

	// 3. Multiple unresolved fields
	const promptMulti = capability.buildPrompt({
		promptPolicy: 'You are specifier.',
		draft: { goal: 'test' },
		completeness: {
			complete: false,
			missingFields: ['nonGoals', 'verificationPlan'],
			ambiguousFields: [],
		},
		maxQuestions: 3,
	});
	assert.match(promptMulti, /You can propose sensible draft values in 'patch' for unresolved fields \(nonGoals, verificationPlan\)/);
	assert.match(promptMulti, /return 1 to 2 questions targeting unresolved fields/);
});
