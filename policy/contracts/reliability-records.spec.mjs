import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCanaryQualification, validateFalseEconomyDiagnostic, validateMutationAttempt, validateRouteAttribution, validateVerificationAttempt } from './reliability-records.ts';

test('validateFalseEconomyDiagnostic validates closed schema, types, and invariants', () => {
	const valid = {
		initialRouteIds: ['openai-compatible-conservative'],
		effectiveStrategy: 'min-cost',
		costInitialMicrousd: 500,
		repairAttemptCount: 1,
		costRepairMicrousd: 1500,
		netChurnCostMicrousd: 2000,
		deltaMicrousd: 1000,
		burnedRepairAttempts: 1,
	};

	const parsed = validateFalseEconomyDiagnostic(valid);
	assert.equal(parsed.netChurnCostMicrousd, 2000);
	assert.equal(parsed.deltaMicrousd, 1000);

	// Missing required fields
	assert.throws(
		() => validateFalseEconomyDiagnostic({ ...valid, deltaMicrousd: undefined }),
		/deltaMicrousd is required/,
	);

	// Unknown fields
	assert.throws(
		() => validateFalseEconomyDiagnostic({ ...valid, extra: 1 }),
		/unknown field 'extra'/,
	);

	// Empty initialRouteIds
	assert.throws(
		() => validateFalseEconomyDiagnostic({ ...valid, initialRouteIds: [] }),
		/must be non-empty array/,
	);

	// Invalid strategy
	assert.throws(
		() => validateFalseEconomyDiagnostic({ ...valid, effectiveStrategy: 'super-cheap' }),
		/effectiveStrategy is invalid/,
	);

	// Negative cost
	assert.throws(
		() => validateFalseEconomyDiagnostic({ ...valid, costInitialMicrousd: -1 }),
		/must be non-negative integer/,
	);

	// Non-positive repairAttemptCount
	assert.throws(
		() => validateFalseEconomyDiagnostic({ ...valid, repairAttemptCount: 0 }),
		/must be positive integer/,
	);
});

test('reliability record validators reject null and a bad canary qualification', () => {
	assert.throws(() => validateMutationAttempt(null), /must be an object/);
	assert.throws(() => validateVerificationAttempt(null), /must be an object/);
	assert.throws(() => validateRouteAttribution(null), /must be an object/);
	const valid = {
		schemaVersion: '1.0.0',
		repositoryId: 'fitness-app',
		runId: '2026-10-22-canary-probe',
		status: 'PASSED',
		failureCategories: [],
		inconclusiveCause: null,
		baseCommitSha: 'a'.repeat(40),
		workflowHash: 'b'.repeat(64),
		boundedPlanningHash: 'c'.repeat(64),
		implementerRoleHash: 'd'.repeat(64),
		modelPolicyHash: 'e'.repeat(64),
		taskPlanHash: 'f'.repeat(64),
		taskManifestHash: '1'.repeat(64),
		qualifiedAt: '2026-10-22T00:00:00.000Z',
	};
	assert.equal(validateCanaryQualification(valid).status, 'PASSED');
	assert.throws(
		() => validateCanaryQualification({ ...valid, boundedPlanningHash: 'short' }),
		(error) => error.code === 'INVALID_CONTRACT' && /boundedPlanningHash is invalid/.test(error.message),
	);
	assert.throws(
		() => validateCanaryQualification({ ...valid, status: 'FAILED', failureCategories: [] }),
		/requires a failure category/,
	);
});
