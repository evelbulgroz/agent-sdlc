import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CriticReviewAdapter } from './critic-review.ts';
import { FakeGovernorForCritic } from '../testing/critic-fixtures.mjs';

test('executeReview weeds out findings citing nonexistent files (deterministic anti-fabrication gate)', async () => {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'critic-review-citation-'));
	try {
		const governor = new FakeGovernorForCritic({
			vendor: 'openai',
			model: 'gpt-4o',
			output: {
				status: 'FAIL',
				findings: [
					{
						severity: 'P1',
						category: 'correctness',
						file: 'tests/session_test.rb',
						lineRange: '10-20',
						evidence: 'fabricated: this file does not exist in the repository',
						impact: 'Would be a false blocker',
						remediation: 'n/a',
					},
					{
						severity: 'P2',
						category: 'correctness',
						file: 'src/real.ts',
						lineRange: '1-2',
						evidence: 'grounded: this file and line range are real',
						impact: 'Legitimate finding',
						remediation: 'Fix it',
					},
				],
			},
		});

		fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
		fs.writeFileSync(path.join(rootDir, 'src', 'real.ts'), 'line one\nline two\n', 'utf8');

		const adapter = new CriticReviewAdapter({ rootDir, governor, rubric: undefined });

		const result = await adapter.executeReview({
			runId: '2026-09-22-citation-test',
			authorVendor: 'google',
			phase: 'code',
			scope: 'src',
			rubric: '# Test Rubric',
		});

		// The fabricated P1 finding must be dropped from scoring: status/hasP1 reflect
		// only the grounded P2 finding, even though the raw model output was FAIL/P1.
		assert.equal(result.hasP1, false);
		assert.equal(result.status, 'PASS');
		assert.equal(result.findingsCount, 1);
		assert.equal(result.findings[0].file, 'src/real.ts');

		// The fabricated finding is preserved for audit, not silently discarded.
		assert.equal(result.ungroundedFindings.length, 1);
		assert.equal(result.ungroundedFindings[0].file, 'tests/session_test.rb');
		assert.match(result.ungroundedFindings[0].groundingReason, /file-not-found/);

		const reportPath = path.join(rootDir, result.reportPath);
		const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
		assert.equal(report.ungroundedFindings.length, 1);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('executeReview weeds out a real file cited with an out-of-bounds line range', async () => {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'critic-review-citation-'));
	try {
		fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
		fs.writeFileSync(path.join(rootDir, 'src', 'short.ts'), 'only\nfour\nlines\nhere\n', 'utf8');

		const governor = new FakeGovernorForCritic({
			vendor: 'openai',
			model: 'gpt-4o',
			output: {
				status: 'FAIL',
				findings: [
					{
						severity: 'P1',
						category: 'correctness',
						file: 'src/short.ts',
						lineRange: '50-55',
						evidence: 'fabricated: file only has 4 lines',
						impact: 'Would be a false blocker',
						remediation: 'n/a',
					},
				],
			},
		});

		const adapter = new CriticReviewAdapter({ rootDir, governor });

		const result = await adapter.executeReview({
			runId: '2026-09-22-citation-test-2',
			authorVendor: 'google',
			phase: 'code',
			scope: 'src',
			rubric: '# Test Rubric',
		});

		assert.equal(result.hasP1, false);
		assert.equal(result.findingsCount, 0);
		assert.equal(result.ungroundedFindings.length, 1);
		assert.match(result.ungroundedFindings[0].groundingReason, /line-range-out-of-bounds/);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});
