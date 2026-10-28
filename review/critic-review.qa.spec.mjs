import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CriticReviewAdapter } from './critic-review.ts';
import { FakeGovernorForCritic } from '../testing/critic-fixtures.mjs';
import { makeFixture } from '../testing/test-support.mjs';

test('AC-08: QA critic output is a per-AC divergence brief omitting COVERED rows', async () => {
	const fixture = makeFixture('critic-ac08-test', []);
	await fixture.runtime.initialize({
		runId: fixture.runId,
		goal: 'QA divergence test',
	});
	for (const file of ['test/ac01.spec.ts', 'test/ac02.spec.ts', 'test/ac02_dup.spec.ts', 'test/overspec.spec.ts']) {
		const absolutePath = path.join(fixture.runtimeDir, file);
		fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
		fs.writeFileSync(absolutePath, '// test fixture\n', 'utf8');
	}
	const rubricsDir = path.join(fixture.runtimeDir, '.agents', 'review-rubrics');
	fs.mkdirSync(rubricsDir, { recursive: true });
	fs.writeFileSync(path.join(rubricsDir, 'qa.md'), '# Test QA Rubric', 'utf8');
	const governor = new FakeGovernorForCritic({
		vendor: 'anthropic',
		output: {
			status: 'FAIL',
			findings: [
				{
					severity: 'P2',
					category: 'testing',
					file: 'test/ac01.spec.ts',
					evidence: 'COVERED AC-01: All assertions match Given/Then. Quote: expect(1).toBe(1);',
					impact: 'None',
					remediation: 'None',
				},
				{
					severity: 'P2',
					category: 'testing',
					file: 'test/ac02.spec.ts',
					evidence: 'GAP AC-02: Then not addressed. Quote: (none)',
					impact: 'Incomplete intent check',
					remediation: 'Add assertion for Then postcondition',
				},
				{
					severity: 'P2',
					category: 'testing',
					file: 'test/ac02_dup.spec.ts',
					evidence: 'GAP AC-02: Another gap for AC-02',
					impact: 'Duplicate',
					remediation: 'Fix',
				},
				{
					severity: 'P2',
					category: 'testing',
					file: 'test/overspec.spec.ts',
					evidence: 'OVERSPEC: Asserts forbidden WebSocket streaming. Quote: expect(ws).toBeDefined();',
					impact: 'Scope creep',
					remediation: 'Remove forbidden assertion',
				},
			],
		},
	});

	const adapter = new CriticReviewAdapter({
		rootDir: fixture.runtimeDir,
		governor,
		runtimeStore: fixture.store,
		reviewBaseDir: fixture.runtimeDir,
	});

	try {
		const result = await adapter.executeReview({
			runId: fixture.runId,
			generation: 0,
			phase: 'qa',
			authorVendor: 'google',
			acceptanceCriteria: [
				'AC-01: outcome 1. Given A. Then B.',
				'AC-02: outcome 2. Given C. Then D.',
			],
		});

		// COVERED AC-01 is omitted from findings[]
		assert.equal(result.findings.some((f) => f.evidence.includes('COVERED AC-01')), false);
		// At most one GAP row for AC-02
		const ac02Gaps = result.findings.filter((f) => f.evidence.includes('GAP AC-02'));
		assert.equal(ac02Gaps.length, 1);
		// OVERSPEC finding is preserved
		const overspec = result.findings.filter((f) => f.evidence.includes('OVERSPEC'));
		assert.equal(overspec.length, 1);
		// Total findings = GAP AC-02 + OVERSPEC = 2
		assert.equal(result.findings.length, 2);

		// coverageMatrix contains full brief
		assert.ok(result.coverageMatrix);
		assert.ok(result.coverageMatrix.covered.includes('AC-01'));
		assert.equal(result.coverageMatrix.gap.length, 1);
		assert.equal(result.coverageMatrix.overspec.length, 1);
	} finally {
		fixture.close();
	}
});
