import assert from 'node:assert/strict';
import test from 'node:test';
import { getEvaluator } from './evaluator-registry.ts';

test('review-rubric-v1 evaluator evaluates passing and failing review outcomes', () => {
	const evaluator = getEvaluator('review-rubric-v1');
	const runId = '2026-09-05-review-eval-1';

	// 1. Clean PASS without findings
	const cleanPass = evaluator.evaluate(
		{
			status: 'PASS',
			findings: [],
		},
		{ runId, generation: 0 },
	);
	assert.equal(cleanPass.status, 'PASS');
	assert.equal(cleanPass.hasP1, false);
	assert.equal(cleanPass.findingCount, 0);
	assert.equal(cleanPass.p1Count, 0);

	// 2. PASS with advisory P2/P3 findings
	const advisoryPass = evaluator.evaluate(
		{
			status: 'PASS',
			findings: [
				{
					findingId: 'f-p2',
					severity: 'P2',
					category: 'style',
					path: 'services/billing/src/file.ts',
					lineRange: [10, 15],
					evidence: 'const x = 1;',
					failureMechanism: 'Variable could be const',
					remediation: 'Keep const',
				},
				{
					findingId: 'f-p3',
					severity: 'P3',
					category: 'docs',
					path: 'services/billing/README.md',
					lineRange: [1, 2],
					evidence: '# Title',
					failureMechanism: 'Typo in heading',
					remediation: 'Fix typo',
				},
			],
		},
		{ runId, generation: 0 },
	);
	assert.equal(advisoryPass.status, 'PASS');
	assert.equal(advisoryPass.hasP1, false);
	assert.equal(advisoryPass.findingCount, 2);
	assert.equal(advisoryPass.p1Count, 0);

	// 3. FAIL with P1 finding
	const p1Fail = evaluator.evaluate(
		{
			status: 'FAIL',
			findings: [
				{
					findingId: 'f-p1',
					severity: 'P1',
					category: 'correctness',
					path: 'services/billing/src/service.ts',
					lineRange: [42, 50],
					evidence: 'return null;',
					failureMechanism: 'Null pointer dereference under edge case',
					remediation: 'Add null check',
				},
			],
		},
		{ runId, generation: 0 },
	);
	assert.equal(p1Fail.status, 'FAIL');
	assert.equal(p1Fail.hasP1, true);
	assert.equal(p1Fail.findingCount, 1);
	assert.equal(p1Fail.p1Count, 1);
});

test('review-rubric-v1 derives status from findings and rejects malformed findings', () => {
	const evaluator = getEvaluator('review-rubric-v1');
	const runId = '2026-09-05-review-eval-2';

	const p1Review = evaluator.evaluate(
		{
			status: 'PASS',
			findings: [
				{
					findingId: 'f-1',
					severity: 'P1',
					category: 'bug',
					path: 'src/main.ts',
					lineRange: [1, 5],
					evidence: 'code',
					failureMechanism: 'bug',
					remediation: 'fix',
				},
			],
		},
		{ runId, generation: 0 },
	);
	assert.equal(p1Review.status, 'FAIL');
	assert.equal(p1Review.hasP1, true);

	const cleanReview = evaluator.evaluate(
		{
			status: 'FAIL',
			findings: [],
		},
		{ runId, generation: 0 },
	);
	assert.equal(cleanReview.status, 'PASS');
	assert.equal(cleanReview.hasP1, false);

	// Invalid lineRange (start > end)
	assert.throws(
		() =>
			evaluator.evaluate(
				{
					status: 'PASS',
					findings: [
						{
							findingId: 'f-2',
							severity: 'P2',
							category: 'style',
							path: 'src/main.ts',
							lineRange: [10, 5],
							evidence: 'code',
							failureMechanism: 'bad',
							remediation: 'fix',
						},
					],
				},
				{ runId, generation: 0 },
			),
		/lineRange/,
	);

	// Invalid severity
	assert.throws(
		() =>
			evaluator.evaluate(
				{
					status: 'PASS',
					findings: [
						{
							findingId: 'f-3',
							severity: 'P0',
							category: 'style',
							path: 'src/main.ts',
							lineRange: [1, 2],
							evidence: 'code',
							failureMechanism: 'bad',
							remediation: 'fix',
						},
					],
				},
				{ runId, generation: 0 },
			),
		/severity must be P1, P2, or P3/,
	);
});

test('review-rubric-v1 preserves structurally valid P1 findings for evidence assessment', () => {
	const evaluator = getEvaluator('review-rubric-v1');
	const result = evaluator.evaluate(
		{
			status: 'FAIL',
			findings: [
				{
					findingId: 'F1',
					severity: 'P1',
					category: 'Functionality',
					path: 'src/SignInPage.tsx',
					lineRange: [102, 102],
					evidence: 'disabled={!userName || !password}',
					failureMechanism:
						'The state might be accessing an incorrect variable.',
					remediation: 'Revise the state management.',
				},
			],
		},
		{ runId: '2026-09-29-rerun-8', generation: 0 },
	);
	assert.equal(result.status, 'FAIL');
	assert.equal(result.hasP1, true);
	assert.equal(result.findings[0].findingId, 'F1');
});
