import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeFixture } from '../testing/test-support.mjs';
import {
	reconcileTasks,
	resetIntegrationWorktree,
} from './reconciliation.ts';

test('reconcileTasks performs identity reconcile for single-task runs without second checkout', async () => {
	const fixture = makeFixture('recon-identity', []);
	const baseCommitSha = 'a'.repeat(40);
	const targetTreeSha = '1'.repeat(40);

	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Test 1-task identity reconcile',
		});

		const taskPlan = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			planPolicyHash: '1'.repeat(64),
			baseCommitSha,
			isParallel: false,
			tasks: [
				{
					taskId: 'task-0',
					title: 'Single task',
					targetPackage: 'services/billing',
					pathPrefixes: ['services/billing'],
					dependsOn: [],
					status: 'completed',
					integrationOrder: 0,
					worktreeSubdir: 'worktree',
					baseCommitSha,
					parentTreeSha: '0'.repeat(40),
					targetTreeSha,
					patchHash: 'p'.repeat(64),
					failurePacketArtifact: null,
					repairCount: 0,
				},
			],
			integrationOrder: ['task-0'],
			createdAt: new Date().toISOString(),
		};

		const gitCalls = [];
		const mockGitCli = (cmd, args) => {
			gitCalls.push({ cmd, args });
			return '';
		};

		const result = await reconcileTasks({
			runId: fixture.runId,
			taskPlan,
			authorization: { allowedPackages: ['services/billing'], allowedPathPrefixes: ['services/billing'] },
			runtimeStore: fixture.store,
			gitCli: mockGitCli,
			taskPlanFrozen: true,
		});

		assert.equal(result.status, 'RECONCILIATION_COMPLETED');
		assert.equal(result.reconciledTreeSha, targetTreeSha);
		assert.ok(result.integrationWorktreePath.endsWith('worktree'));
		assert.equal(gitCalls.length, 0); // Identity reconcile creates no checkouts or git calls

		const stored = fixture.store.getLatestReconciliation(fixture.runId);
		assert.ok(stored);
		assert.equal(stored.status, 'RECONCILIATION_COMPLETED');
		assert.equal(stored.reconciledTreeSha, targetTreeSha);
	} finally {
		fixture.close();
	}
});

test('reconcileTasks reconciles multi-task patches in integrationOrder', async () => {
	const fixture = makeFixture('recon-multi', []);
	const baseCommitSha = 'a'.repeat(40);
	const reconciledTreeSha = '3'.repeat(40);

	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Test multi-task reconcile',
		});

		const task1 = {
			taskId: 'task-ddd',
			title: 'Update shared-base',
			targetPackage: 'packages/shared-base',
			pathPrefixes: ['packages/shared-base'],
			dependsOn: [],
			status: 'completed',
			integrationOrder: 0,
			worktreeSubdir: 'worktrees/task-ddd',
			baseCommitSha,
			parentTreeSha: '0'.repeat(40),
			targetTreeSha: '1'.repeat(40),
			patchHash: '1'.repeat(64),
			failurePacketArtifact: null,
			repairCount: 0,
		};

		const task2 = {
			taskId: 'task-cond',
			title: 'Update billing',
			targetPackage: 'services/billing',
			pathPrefixes: ['services/billing'],
			dependsOn: ['task-ddd'],
			status: 'completed',
			integrationOrder: 1,
			worktreeSubdir: 'worktrees/task-cond',
			baseCommitSha,
			parentTreeSha: '1'.repeat(40),
			targetTreeSha: '2'.repeat(40),
			patchHash: '2'.repeat(64),
			failurePacketArtifact: null,
			repairCount: 0,
		};

		const taskPlan = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			planPolicyHash: '2'.repeat(64),
			baseCommitSha,
			isParallel: true,
			tasks: [task1, task2],
			integrationOrder: ['task-ddd', 'task-cond'],
			createdAt: new Date().toISOString(),
		};

		const gitCalls = [];
		const mockGitCli = (cmd, args, opts) => {
			gitCalls.push({ cmd, args, cwd: opts?.cwd });
			if (args[0] === 'rev-parse' && args[1] === 'HEAD') return baseCommitSha + '\n';
			if (args[0] === 'worktree' && args[1] === 'add') {
				fs.mkdirSync(args[3], { recursive: true });
				return '';
			}
			if (args[0] === 'diff-tree' && args[1] === '-p') {
				return 'diff --git a/test.ts b/test.ts\n+patch';
			}
			if (args[0] === 'diff-tree' && args[1] === '--name-only') {
				if (args[3] === task1.parentTreeSha) return 'packages/shared-base/src/entity.ts\n';
				return 'services/billing/src/service.ts\n';
			}
			if (args[0] === 'apply') {
				return '';
			}
			if (args[0] === 'write-tree') {
				return reconciledTreeSha + '\n';
			}
			return '';
		};

		const result = await reconcileTasks({
			runId: fixture.runId,
			taskPlan,
			authorization: {
				allowedPackages: ['packages/shared-base', 'services/billing'],
				allowedPathPrefixes: ['packages/shared-base', 'services/billing'],
			},
			runtimeStore: fixture.store,
			gitCli: mockGitCli,
			taskPlanFrozen: true,
		});

		assert.equal(result.status, 'RECONCILIATION_COMPLETED');
		assert.equal(result.reconciledTreeSha, reconciledTreeSha);
		assert.ok(result.integrationWorktreePath.endsWith(path.join('worktrees', 'integration')));

		// Verify apply calls were executed in integration worktree
		const applyCalls = gitCalls.filter((c) => c.args[0] === 'apply');
		// 2 dry-run check calls + 2 actual apply calls = 4 apply calls
		assert.equal(applyCalls.length, 4);
		assert.deepEqual(applyCalls[0].args, ['apply', '--check', '--binary', '-']);
		assert.deepEqual(applyCalls[1].args, ['apply', '--binary', '-']);

		const stored = fixture.store.getLatestReconciliation(fixture.runId);
		assert.ok(stored);
		assert.equal(stored.status, 'RECONCILIATION_COMPLETED');
		assert.equal(stored.reconciledTreeSha, reconciledTreeSha);
	} finally {
		fixture.close();
	}
});

test('reconcileTasks detects conflicts during dry-run and records RECONCILIATION_CONFLICT', async () => {
	const fixture = makeFixture('recon-conflict', []);
	const baseCommitSha = 'a'.repeat(40);

	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Test reconciliation conflict',
		});

		const task1 = {
			taskId: 'task-1',
			title: 'Task 1',
			targetPackage: 'services/billing',
			pathPrefixes: ['services/billing'],
			dependsOn: [],
			status: 'completed',
			integrationOrder: 0,
			worktreeSubdir: 'worktrees/task-1',
			baseCommitSha,
			parentTreeSha: '0'.repeat(40),
			targetTreeSha: '1'.repeat(40),
			patchHash: '1'.repeat(64),
			failurePacketArtifact: null,
			repairCount: 0,
		};

		const taskPlan = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			planPolicyHash: '3'.repeat(64),
			baseCommitSha,
			isParallel: true,
			tasks: [task1, { ...task1, taskId: 'task-2', integrationOrder: 1, worktreeSubdir: 'worktrees/task-2' }],
			integrationOrder: ['task-1', 'task-2'],
			createdAt: new Date().toISOString(),
		};

		const mockGitCli = (cmd, args) => {
			if (args[0] === 'rev-parse') return baseCommitSha + '\n';
			if (args[0] === 'worktree' && args[1] === 'add') {
				fs.mkdirSync(args[3], { recursive: true });
				return '';
			}
			if (args[0] === 'diff-tree' && args[1] === '-p') {
				return 'diff --git a/test.ts b/test.ts\n+collision';
			}
			if (args[0] === 'diff-tree' && args[1] === '--name-only') {
				return 'services/billing/src/file.ts\n';
			}
			if (args[0] === 'apply' && args[1] === '--check') {
				// Simulate patch conflict
				throw new Error('error: patch failed: services/billing/src/file.ts:1');
			}
			return '';
		};

		const result = await reconcileTasks({
			runId: fixture.runId,
			taskPlan,
			authorization: { allowedPackages: ['services/billing'], allowedPathPrefixes: ['services/billing'] },
			runtimeStore: fixture.store,
			gitCli: mockGitCli,
			taskPlanFrozen: true,
		});

		assert.equal(result.status, 'RECONCILIATION_CONFLICT');
		assert.equal(result.failingTaskId, 'task-1');
		assert.ok(result.conflictDetails.error.includes('patch failed'));

		const stored = fixture.store.getLatestReconciliation(fixture.runId);
		assert.ok(stored);
		assert.equal(stored.status, 'RECONCILIATION_CONFLICT');
	} finally {
		fixture.close();
	}
});

test('reconcileTasks detects conflicts when git apply throws after successful dry-run and resets integration worktree', async () => {
	const fixture = makeFixture('recon-apply-err', []);
	const baseCommitSha = 'a'.repeat(40);

	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Test post-check git apply failure',
		});

		const task1 = {
			taskId: 'task-1',
			title: 'Task 1',
			targetPackage: 'services/billing',
			pathPrefixes: ['services/billing'],
			dependsOn: [],
			status: 'completed',
			integrationOrder: 0,
			worktreeSubdir: 'worktrees/task-1',
			baseCommitSha,
			parentTreeSha: '0'.repeat(40),
			targetTreeSha: '1'.repeat(40),
			patchHash: '1'.repeat(64),
			failurePacketArtifact: null,
			repairCount: 0,
		};

		const taskPlan = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			planPolicyHash: '3'.repeat(64),
			baseCommitSha,
			isParallel: true,
			tasks: [task1, { ...task1, taskId: 'task-2', integrationOrder: 1, worktreeSubdir: 'worktrees/task-2' }],
			integrationOrder: ['task-1', 'task-2'],
			createdAt: new Date().toISOString(),
		};

		const gitCalls = [];
		const mockGitCli = (cmd, args) => {
			gitCalls.push({ cmd, args });
			if (args[0] === 'rev-parse') return baseCommitSha + '\n';
			if (args[0] === 'worktree' && args[1] === 'add') {
				fs.mkdirSync(args[3], { recursive: true });
				return '';
			}
			if (args[0] === 'diff-tree' && args[1] === '-p') {
				return 'diff --git a/test.ts b/test.ts\n+content';
			}
			if (args[0] === 'diff-tree' && args[1] === '--name-only') {
				return 'services/billing/src/file.ts\n';
			}
			if (args[0] === 'apply' && args[1] === '--check') {
				// dry-run check succeeds
				return '';
			}
			if (args[0] === 'apply' && args[1] === '--binary') {
				// subsequent git apply fails
				throw new Error('fatal: corrupt patch at line 42');
			}
			return '';
		};

		const result = await reconcileTasks({
			runId: fixture.runId,
			taskPlan,
			authorization: { allowedPackages: ['services/billing'], allowedPathPrefixes: ['services/billing'] },
			runtimeStore: fixture.store,
			gitCli: mockGitCli,
			taskPlanFrozen: true,
		});

		assert.equal(result.status, 'RECONCILIATION_CONFLICT');
		assert.equal(result.failingTaskId, 'task-1');
		assert.ok(result.conflictDetails.error.includes('corrupt patch'));

		// Verify integration worktree was reset by resetIntegrationWorktree
		assert.ok(gitCalls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'add'));

		const stored = fixture.store.getLatestReconciliation(fixture.runId);
		assert.ok(stored);
		assert.equal(stored.status, 'RECONCILIATION_CONFLICT');
	} finally {
		fixture.close();
	}
});

test('reconcileTasks permits files listed in task generatedOutputs even if outside pathPrefixes', async () => {
	const fixture = makeFixture('recon-generated-outputs', []);
	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Test generated outputs reconcile',
		});
		const baseCommitSha = 'a'.repeat(40);
		const treeSha1 = '1'.repeat(40);
		const task1 = {
			taskId: 'task-gen',
			title: 'Task with generated output',
			targetPackage: 'services/billing',
			pathPrefixes: ['services/billing/src'],
			generatedOutputs: ['services/billing/openapi/billing.openapi.json'],
			dependsOn: [],
			status: 'completed',
			integrationOrder: 0,
			worktreeSubdir: 'worktrees/task-gen',
			baseCommitSha,
			parentTreeSha: baseCommitSha,
			targetTreeSha: treeSha1,
			patchHash: 'p1'.repeat(32),
			failurePacketArtifact: null,
			repairCount: 0,
		};
		const taskPlan = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			planPolicyHash: '4'.repeat(64),
			baseCommitSha,
			isParallel: true,
			tasks: [
				task1,
				{
					...task1,
					taskId: 'task-other',
					targetPackage: 'docs',
					pathPrefixes: ['docs'],
					generatedOutputs: [],
					dependsOn: ['task-gen'],
					integrationOrder: 1,
					worktreeSubdir: 'worktrees/task-other',
					targetTreeSha: baseCommitSha,
				},
			],
			integrationOrder: ['task-gen', 'task-other'],
			createdAt: new Date().toISOString(),
		};

		const mockGitCli = (cmd, args) => {
			if (args[0] === 'rev-parse') return baseCommitSha + '\n';
			if (args[0] === 'worktree' && args[1] === 'add') {
				fs.mkdirSync(args[3], { recursive: true });
				return '';
			}
			if (args[0] === 'diff-tree' && args[1] === '-p') {
				return 'diff --git a/openapi/billing.openapi.json b/openapi/billing.openapi.json\n+openapi';
			}
			if (args[0] === 'diff-tree' && args[1] === '--name-only') {
				return 'services/billing/openapi/billing.openapi.json\n';
			}
			if (args[0] === 'write-tree') {
				return treeSha1 + '\n';
			}
			return '';
		};

		const result = await reconcileTasks({
			runId: fixture.runId,
			taskPlan,
			authorization: {
				allowedPackages: ['services/billing', 'docs'],
				allowedPathPrefixes: ['services/billing', 'docs'],
			},
			runtimeStore: fixture.store,
			gitCli: mockGitCli,
			taskPlanFrozen: true,
		});

		assert.equal(result.status, 'RECONCILIATION_COMPLETED');
	} finally {
		fixture.close();
	}
});

