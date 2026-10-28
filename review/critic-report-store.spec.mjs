import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { persistCriticReview } from './critic-report-store.ts';

function baseInput(rootDir, overrides = {}) {
	return {
		rootDir,
		reviewBaseDir: path.join(rootDir, 'tools/.review'),
		runtimeStore: undefined,
		runId: '2026-10-24-report-store',
		generation: 0,
		phase: 'spec',
		canonicalAuthors: ['google'],
		reviewerVendor: 'openai',
		reviewerModel: 'gpt-4o',
		artifactHash: 'a'.repeat(64),
		attemptKey: 'spec:0',
		status: 'PASS',
		findings: [],
		ungroundedFindings: [],
		coverageMatrix: null,
		hasP1: false,
		operationId: 'op-1',
		usageRecordIds: ['rec-1'],
		...overrides,
	};
}

function withRoot(run) {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'critic-report-store-'));
	try {
		return run(rootDir);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
}

test('@ac AC-02 @case AC-02.1 a first review writes the report and a one-review manifest with a root-relative reportPath', () => {
	withRoot((rootDir) => {
		const result = persistCriticReview(baseInput(rootDir));
		const runDir = path.join(rootDir, 'tools/.review/2026-10-24-report-store');
		assert.equal(result.reportPath, path.join('tools/.review/2026-10-24-report-store', 'g0-spec-report.json'));
		assert.equal(result.manifestPath, path.join('tools/.review/2026-10-24-report-store', 'manifest.json'));
		const report = JSON.parse(fs.readFileSync(path.join(runDir, 'g0-spec-report.json'), 'utf8'));
		assert.equal(report.reviewId, result.reviewId);
		assert.equal(report.status, 'PASS');
		assert.deepEqual(report.authorVendors, ['google']);
		const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
		assert.equal(manifest.reviews.length, 1);
		assert.equal(manifest.reviews[0].reportPath, result.reportPath);
		assert.equal(manifest.reviews[0].reviewId, result.reviewId);
		assert.equal(fs.statSync(runDir).mode & 0o777, 0o700);
	});
});

test('@ac AC-02 @case AC-02.2 a second review appends to the existing manifest and keeps the first entry', () => {
	withRoot((rootDir) => {
		const first = persistCriticReview(baseInput(rootDir));
		const second = persistCriticReview(baseInput(rootDir, { generation: 1, phase: 'plan', operationId: 'op-2' }));
		const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, second.manifestPath), 'utf8'));
		assert.deepEqual(
			manifest.reviews.map((review) => review.reviewId),
			[first.reviewId, second.reviewId],
		);
		assert.equal(manifest.reviews[1].phase, 'plan');
		assert.ok(fs.existsSync(path.join(rootDir, second.reportPath)));
	});
});

test('@ac AC-02 @case AC-02.2 an unreadable manifest is replaced by a fresh one', () => {
	withRoot((rootDir) => {
		const runDir = path.join(rootDir, 'tools/.review/2026-10-24-report-store');
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(path.join(runDir, 'manifest.json'), '{not json');
		const result = persistCriticReview(baseInput(rootDir));
		const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, result.manifestPath), 'utf8'));
		assert.equal(manifest.reviews.length, 1);
	});
});

test('@ac AC-02 @case AC-02.3 a runtime store receives one validated record and an omitted store still writes both files', () => {
	withRoot((rootDir) => {
		const saved = [];
		const result = persistCriticReview(
			baseInput(rootDir, {
				runtimeStore: { saveCriticReview: (record) => saved.push(record) },
				findings: [{ severity: 'P2', category: 'testing', file: 'a.ts', lineRange: '1', evidence: 'e', impact: 'i', remediation: 'r' }],
			}),
		);
		assert.equal(saved.length, 1);
		assert.equal(saved[0].reviewId, result.reviewId);
		assert.equal(saved[0].manifestPath, result.manifestPath);
		assert.equal(saved[0].reportArtifact, result.reportPath);
		assert.equal(saved[0].findingsCount, 1);

		const second = persistCriticReview(baseInput(rootDir, { generation: 2 }));
		assert.ok(fs.existsSync(path.join(rootDir, second.reportPath)));
		assert.ok(fs.existsSync(path.join(rootDir, second.manifestPath)));
	});
});

test('@ac AC-02 @case AC-02.3 an invalid record fails before the runtime store is called', () => {
	withRoot((rootDir) => {
		const saved = [];
		assert.throws(() =>
			persistCriticReview(
				baseInput(rootDir, {
					artifactHash: 'not-a-hash',
					runtimeStore: { saveCriticReview: (record) => saved.push(record) },
				}),
			),
		);
		assert.equal(saved.length, 0);
	});
});
