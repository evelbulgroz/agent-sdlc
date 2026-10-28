import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
	ReviewGenerationAdapter,
	anyHighRiskPaths,
	isHighRiskPath,
	materializeGenerationTree,
} from './review-generation.ts';
import { evaluateAcCoverageFromWorktree } from '../execution/ac-worktree-coverage.ts';
import { collectTouchedTestFiles } from './critic-gate.ts';
import { makeFixture } from '../testing/test-support.mjs';

function setupGitWorktree(worktreeDir) {
	fs.mkdirSync(worktreeDir, { recursive: true });
	execFileSync('git', ['init'], { cwd: worktreeDir });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: worktreeDir });
	execFileSync('git', ['config', 'user.name', 'test'], { cwd: worktreeDir });

	fs.writeFileSync(path.join(worktreeDir, '.gitignore'), 'ignored.txt\nnode_modules/\n');
	fs.mkdirSync(path.join(worktreeDir, 'apps/services/conditioning/src'), { recursive: true });
	fs.writeFileSync(
		path.join(worktreeDir, 'apps/services/conditioning/src/initial.ts'),
		'export const v = 1;\n',
	);
	execFileSync('git', ['add', '-A'], { cwd: worktreeDir });
	execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: worktreeDir });

	return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreeDir, encoding: 'utf8' }).trim();
}

test('isHighRiskPath and anyHighRiskPaths detect protected repository surfaces', () => {
	assert.equal(isHighRiskPath('apps/services/authentication/src/auth.service.ts'), true);
	assert.equal(isHighRiskPath('apps/services/registry/src/main.ts'), true);
	assert.equal(isHighRiskPath('packages/ddd-base/src/entity.ts'), true);
	assert.equal(isHighRiskPath('packages/fitnessapp-base/src/index.ts'), true);
	assert.equal(isHighRiskPath('.github/workflows/ci.yml'), true);
	assert.equal(isHighRiskPath('tools/quality/gate.mjs'), true);
	assert.equal(isHighRiskPath('security-config/local.env'), true);

	assert.equal(isHighRiskPath('apps/services/conditioning/src/service.ts'), false);
	assert.equal(isHighRiskPath('apps/services/journal/src/entry.ts'), false);

	assert.equal(
		anyHighRiskPaths([
			'apps/services/conditioning/src/service.ts',
			'packages/ddd-base/src/entity.ts',
		]),
		true,
	);
	assert.equal(
		anyHighRiskPaths(['apps/services/conditioning/src/service.ts']),
		false,
	);
});

test('materializeGenerationTree writes uncommitted tree and records generation in store', () => {
	const fixture = makeFixture('gen-tree-1', []);
	const worktreeDir = path.join(fixture.runtimeDir, 'worktree');

	try {
		const baseCommitSha = setupGitWorktree(worktreeDir);
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Test generation tree',
		});

		// Create uncommitted modifications, additions, and ignored files
		fs.writeFileSync(
			path.join(worktreeDir, 'apps/services/conditioning/src/initial.ts'),
			'export const v = 2;\n',
		);
		fs.writeFileSync(
			path.join(worktreeDir, 'apps/services/conditioning/src/added.ts'),
			'export const added = true;\n',
		);
		fs.writeFileSync(path.join(worktreeDir, 'ignored.txt'), 'ignored content');

		const gen = materializeGenerationTree({
			runId: fixture.runId,
			worktreeDir,
			baseCommitSha,
			allowedPackages: ['apps/services/conditioning'],
			allowedPathPrefixes: ['apps/services/conditioning/src'],
			generation: 0,
			runtimeStore: fixture.store,
		});

		assert.equal(gen.generation, 0);
		assert.equal(gen.baseCommitSha, baseCommitSha);
		assert.match(gen.targetTreeSha, /^[a-f0-9]{40}$/);
		assert.ok(gen.scopeFingerprints['apps/services/conditioning']);
		assert.deepEqual(gen.taskOwnedPaths, [
			'apps/services/conditioning/src/added.ts',
			'apps/services/conditioning/src/initial.ts',
		]);

		// Verify generation was saved in SQLite
		const retrieved = fixture.store.getGeneration(fixture.runId, 0);
		assert.equal(retrieved.targetTreeSha, gen.targetTreeSha);

		// Verify working tree still shows uncommitted files (worktree index was not mutated)
		const status = execFileSync('git', ['status', '--short'], {
			cwd: worktreeDir,
			encoding: 'utf8',
		});
		assert.ok(status.includes('M apps/services/conditioning/src/initial.ts'));
		assert.ok(status.includes('?? apps/services/conditioning/src/added.ts'));

		// Verify targetTreeSha does not contain hydration marker
		const lsTree = execFileSync('git', ['ls-tree', '-r', '--name-only', gen.targetTreeSha], {
			cwd: worktreeDir,
			encoding: 'utf8',
		});
		assert.equal(lsTree.includes('.hydration-fingerprint.json'), false);
		assert.equal(lsTree.includes('hydration.json'), false);
	} finally {
		fixture.close();
	}
});

test('materializeGenerationTree preserves exact newly authored test paths', () => {
	const fixture = makeFixture('gen-tree-exact-test-path', []);
	const worktreeDir = path.join(fixture.runtimeDir, 'worktree');
	const testPath =
		'apps/services/conditioning/src/conditioning/domain/helpers/derive-elevation-totals.helper.spec.ts';

	try {
		const baseCommitSha = setupGitWorktree(worktreeDir);
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Record exact changed test paths',
		});
		fs.mkdirSync(path.dirname(path.join(worktreeDir, testPath)), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(worktreeDir, testPath),
			"it('@ac AC-09 derives totals', () => expect(true).toBe(true));\n",
		);

		const generation = materializeGenerationTree({
			runId: fixture.runId,
			worktreeDir,
			baseCommitSha,
			allowedPackages: ['apps/services/conditioning'],
			allowedPathPrefixes: [testPath],
			generation: 0,
			runtimeStore: fixture.store,
		});

		assert.deepEqual(generation.taskOwnedPaths, [testPath]);
		assert.equal(generation.taskOwnedPaths[0].endsWith('/**'), false);
		const touchedTestFiles = collectTouchedTestFiles({
			runtime: fixture.runtime,
			snapshot: {
				runId: fixture.runId,
				activeGeneration: 0,
				worktreePath: worktreeDir,
			},
			auth: { baseCommitSha },
		});
		assert.deepEqual(touchedTestFiles, [testPath]);
		const coverage = evaluateAcCoverageFromWorktree({
			draft: {
				acceptanceCriteria: [
					'AC-09: Elevation totals are derived. Given finite samples. Then totals use the deadband.',
				],
			},
			worktreeDir,
			touchedTestFiles,
			allowedPathPrefixes: [testPath],
		});
		assert.equal(coverage.pass, true);
		assert.deepEqual(coverage.uncoveredAcIds, []);
	} finally {
		fixture.close();
	}
});

test('materializeGenerationTree preserves tracked files matching .gitignore without reporting out-of-scope deletions', () => {
	const fixture = makeFixture('gen-tree-ignore-test', []);
	const worktreeDir = path.join(fixture.runtimeDir, 'worktree');

	try {
		fs.mkdirSync(worktreeDir, { recursive: true });
		execFileSync('git', ['init', '-b', 'main'], { cwd: worktreeDir, stdio: 'ignore' });
		execFileSync('git', ['config', 'user.email', 'test@fitnessapp.local'], { cwd: worktreeDir });
		execFileSync('git', ['config', 'user.name', 'test'], { cwd: worktreeDir });

		fs.mkdirSync(path.join(worktreeDir, 'packages/ddd-base'), { recursive: true });
		fs.mkdirSync(path.join(worktreeDir, 'coverage.root-owned.bak'), { recursive: true });
		fs.writeFileSync(path.join(worktreeDir, '.env.example'), 'VITE_GATEWAY_BASE_URL=/gateway/api/v1\n');
		fs.writeFileSync(
			path.join(worktreeDir, 'coverage.root-owned.bak/coverage-summary.json'),
			'{}\n',
		);
		fs.writeFileSync(path.join(worktreeDir, 'packages/ddd-base/fixture.ts'), 'export const value = 1;\n');
		execFileSync('git', ['add', '-A'], { cwd: worktreeDir });
		execFileSync('git', ['commit', '-m', 'track fixture files'], {
			cwd: worktreeDir,
			stdio: 'ignore',
		});

		fs.writeFileSync(
			path.join(worktreeDir, '.gitignore'),
			'.env.example\ncoverage.root-owned.bak/\n',
		);
		execFileSync('git', ['add', '.gitignore'], { cwd: worktreeDir });
		execFileSync('git', ['commit', '-m', 'ignore tracked fixture files'], {
			cwd: worktreeDir,
			stdio: 'ignore',
		});
		const baseCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
			cwd: worktreeDir,
			encoding: 'utf8',
		}).trim();

		fs.writeFileSync(
			path.join(worktreeDir, 'packages/ddd-base/fixture.ts'),
			'export const value = 2;\n',
		);

		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Test ignore handling',
		});

		const gen = materializeGenerationTree({
			runId: fixture.runId,
			worktreeDir,
			baseCommitSha,
			allowedPackages: ['packages/ddd-base'],
			allowedPathPrefixes: ['packages/ddd-base/'],
			generation: 0,
			runtimeStore: fixture.store,
		});

		const changedFiles = execFileSync(
			'git',
			['diff-tree', '-r', '--name-status', baseCommitSha, gen.targetTreeSha],
			{ cwd: worktreeDir, encoding: 'utf8' },
		)
			.trim()
			.split('\n');

		assert.deepEqual(changedFiles, ['M\tpackages/ddd-base/fixture.ts']);
	} finally {
		fixture.close();
	}
});

test('ReviewGenerationAdapter supports generation queries, review recording, and repair checks', async () => {
	const fixture = makeFixture('gen-adapter-1', []);
	const worktreeDir = path.join(fixture.runtimeDir, 'worktree');

	try {
		const baseCommitSha = setupGitWorktree(worktreeDir);
		const initial = fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Test review generation adapter',
		});

		materializeGenerationTree({
			runId: fixture.runId,
			worktreeDir,
			baseCommitSha,
			allowedPackages: ['apps/services/conditioning'],
			generation: 0,
			runtimeStore: fixture.store,
		});

		const adapter = new ReviewGenerationAdapter({
			runtimeStore: fixture.store,
			artifactStore: fixture.artifacts,
			maxSemanticRepairs: 2,
		});

		// 1. Get current generation
		const currentGen = await adapter.getCurrentGeneration(
			fixture.runId,
			initial.runtimeRevision,
		);
		assert.equal(currentGen.generation, 0);
		assert.match(currentGen.targetTreeSha, /^[a-f0-9]{40}$/);

		// Revision mismatch throws
		await assert.rejects(
			() => adapter.getCurrentGeneration(fixture.runId, 999),
			(err) => err.code === 'STORE_RECONCILIATION_FAILED',
		);

		// 2. Record review outcome
		const reportHash = 'a'.repeat(64);
		const outcome = await adapter.recordReviewOutcome(fixture.runId, 0, reportHash, {
			hasP1: false,
			findingCount: 0,
		});
		assert.equal(outcome.runtimeRevision, initial.runtimeRevision);
		const genAfterReview = fixture.store.getGeneration(fixture.runId, 0);
		assert.equal(genAfterReview.reviewReportHash, reportHash);
		assert.equal(genAfterReview.findingCount, 0);
		assert.equal(genAfterReview.hasP1, false);

		// 3. Request semantic repair (first attempt accepted)
		const repair1 = await adapter.requestSemanticRepair(
			fixture.runId,
			0,
			'report-hash-1',
			['finding-1'],
			['apps/services/conditioning'],
		);
		assert.equal(repair1.kind, 'accepted');
		assert.equal(repair1.retryCount, 1);
		assert.equal(fixture.store.getSemanticRepairsCount(fixture.runId), 1);

		// Second attempt accepted
		const repair2 = await adapter.requestSemanticRepair(
			fixture.runId,
			0,
			'report-hash-2',
			['finding-2'],
			['apps/services/conditioning'],
		);
		assert.equal(repair2.kind, 'accepted');
		assert.equal(repair2.retryCount, 2);

		// Third attempt exceeds maxSemanticRepairs (2) -> returns interrupt
		const repair3 = await adapter.requestSemanticRepair(
			fixture.runId,
			0,
			'report-hash-3',
			['finding-3'],
			['apps/services/conditioning'],
		);
		assert.equal(repair3.kind, 'interrupt');
		assert.equal(repair3.reason, 'REPAIR_BUDGET_EXHAUSTED');

		// High-risk path attempt -> returns interrupt immediately
		const highRiskRepair = await adapter.requestSemanticRepair(
			fixture.runId,
			0,
			'report-hash-4',
			['finding-4'],
			['packages/ddd-base/src/aggregate.ts'],
		);
		assert.equal(highRiskRepair.kind, 'interrupt');
		assert.equal(highRiskRepair.reason, 'HIGH_RISK_PATH_REPAIR_PROHIBITED');
	} finally {
		fixture.close();
	}
});
