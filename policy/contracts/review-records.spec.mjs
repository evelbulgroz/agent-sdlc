import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCriticReviewRecord, validateFailurePacket, validateOptionalRoleRecord, validatePreflightBinding, validateReviewFindings } from './review-records.ts';
import { assertTransition } from './runtime-transitions.ts';

test('review findings, failure packet, and preflight binding contracts validate strictly', () => {
	// Review findings
	const passReview = {
		schemaVersion: '1.0.0',
		runId: '2026-09-04-review-test',
		generation: 0,
		status: 'PASS',
		findings: [
			{
				findingId: 'f1',
				severity: 'P2',
				category: 'maintainability',
				path: 'src/example.ts',
				lineRange: [10, 20],
				evidence: 'const x = 1;',
				failureMechanism: 'unused var',
				remediation: 'remove x',
			},
		],
	};
	assert.equal(validateReviewFindings(passReview).status, 'PASS');

	// P1 finding with PASS status must throw
	const p1Finding = {
		findingId: 'f2',
		severity: 'P1',
		category: 'correctness',
		path: 'src/example.ts',
		lineRange: [1, 5],
		evidence: 'throw new Error();',
		failureMechanism: 'unhandled exception',
		remediation: 'catch error',
	};
	assert.throws(
		() => validateReviewFindings({ ...passReview, findings: [p1Finding] }),
		/must be 'FAIL' when P1 findings exist/,
	);

	// FAIL status with no P1 findings must throw
	assert.throws(
		() => validateReviewFindings({ ...passReview, status: 'FAIL' }),
		/cannot be 'FAIL' without P1 findings/,
	);

	// Failure packet
	const validFailure = {
		schemaVersion: '1.0.0',
		runId: '2026-09-04-failure-test',
		generation: 0,
		failedCommand: 'pnpm run agent:verify -- --base ' + 'a'.repeat(40),
		exitCode: 1,
		sanitizedOutput: 'Test failure output',
		classification: 'test_failure',
		targetPaths: ['services/billing/**'],
		baseCommitSha: 'a'.repeat(40),
		timestamp: new Date().toISOString(),
	};
	assert.equal(validateFailurePacket(validFailure).classification, 'test_failure');
	assert.throws(
		() => validateFailurePacket({ ...validFailure, classification: 'arbitrary_failure' }),
		/invalid/,
	);

	// Preflight binding
	const validBinding = {
		baseCommitSha: 'a'.repeat(40),
		targetTreeSha: 'b'.repeat(40),
		command: 'pnpm run agent:verify -- --base ' + 'a'.repeat(40),
		preflightResultHash: 'c'.repeat(64),
		status: 'OK',
		canonical: true,
	};
	assert.equal(validatePreflightBinding(validBinding).status, 'OK');
	assert.throws(
		() => validatePreflightBinding({ ...validBinding, status: 'FAIL' }),
		/must be 'OK'/,
	);
	assert.throws(
		() => validatePreflightBinding({ ...validBinding, canonical: false }),
		/canonical must be true/,
	);
});

test('critic review record contract validates strictly and fails closed', () => {
	const validReview = {
		schemaVersion: '1.0.0',
		reviewId: 'review-12345678',
		runId: '2026-09-04-critic-test',
		generation: 0,
		phase: 'code',
		reviewerVendor: 'openai',
		reviewerModel: 'gpt-4o',
		manifestPath: 'tools/.review/2026-09-04-critic-test/code-manifest.json',
		artifactHash: 'c'.repeat(64),
		attemptKey: 'code:0:' + 'c'.repeat(64),
		findingsCount: 0,
		hasP1: false,
		reviewedAt: new Date().toISOString(),
	};
	const parsed = validateCriticReviewRecord(validReview);
	assert.equal(parsed.phase, 'code');
	assert.equal(parsed.hasP1, false);

	const parsedSpec = validateCriticReviewRecord({
		...validReview,
		phase: 'spec',
		operationId: '2026-09-04-critic-test:critic:spec:abc:g0',
		usageRecordIds: ['rec-1', 'rec-2'],
	});
	assert.equal(parsedSpec.phase, 'spec');
	assert.equal(parsedSpec.operationId, '2026-09-04-critic-test:critic:spec:abc:g0');
	assert.deepEqual(parsedSpec.usageRecordIds, ['rec-1', 'rec-2']);

	const parsedPlan = validateCriticReviewRecord({ ...validReview, phase: 'plan' });
	assert.equal(parsedPlan.phase, 'plan');

	assert.throws(() => validateCriticReviewRecord(null), /must be an object/);
	assert.throws(
		() => validateCriticReviewRecord({ ...validReview, phase: 'invalid' }),
		/phase must be 'spec', 'plan', 'code', or 'qa'/,
	);
	assert.throws(() => validateCriticReviewRecord({ ...validReview, generation: -1 }), /non-negative integer/);
	assert.throws(() => validateCriticReviewRecord({ ...validReview, hasP1: 'true' }), /boolean/);
	assert.throws(() => validateCriticReviewRecord({ ...validReview, reviewerVendor: '' }), /non-empty/);
	assert.throws(
		() => validateCriticReviewRecord({ ...validReview, artifactHash: 'short' }),
		/artifactHash is invalid/,
	);
	assert.throws(() => validateCriticReviewRecord({ ...validReview, attemptKey: '' }), /non-empty/);
	assert.doesNotThrow(() => assertTransition('SPEC_DRAFTING', 'REVIEWING_SPEC'));
	assert.doesNotThrow(() => assertTransition('REVIEWING_SPEC', 'WAITING_FOR_APPROVAL'));
});

test('optional role execution record contract validates strictly and fails closed', () => {
	const validRoleRecord = {
		schemaVersion: '1.0.0',
		runId: '2026-09-04-role-test',
		roleId: 'cleaner',
		insertionPoint: 'post_implement',
		generation: 0,
		status: 'passed',
		summary: 'Hygiene checks clean',
		executedAt: new Date().toISOString(),
	};
	const parsed = validateOptionalRoleRecord(validRoleRecord);
	assert.equal(parsed.roleId, 'cleaner');
	assert.equal(parsed.status, 'passed');

	assert.throws(() => validateOptionalRoleRecord(null), /must be an object/);
	assert.throws(
		() => validateOptionalRoleRecord({ ...validRoleRecord, insertionPoint: 'invalid' }),
		/must be 'post_implement', 'pre_review', or 'review'/,
	);
	assert.throws(
		() => validateOptionalRoleRecord({ ...validRoleRecord, status: 'unknown' }),
		/must be 'passed', 'modified', or 'failed'/,
	);
	assert.throws(() => validateOptionalRoleRecord({ ...validRoleRecord, roleId: 'INVALID_ROLE' }), /roleId is invalid/);
});
