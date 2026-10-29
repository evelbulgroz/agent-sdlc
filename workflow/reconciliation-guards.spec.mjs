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

test('reconcileTasks rejects patch modifying files outside task pathPrefixes', async () => {
	const fixture = makeFixture('recon-leak', []);
	const baseCommitSha = 'a'.repeat(40);

	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Test reconciliation leak containment',
		});

		const task1 = {
			taskId: 'task-leak',
			title: 'Task Leak',
			targetPackage: 'services/billing',
			pathPrefixes: ['services/billing'],
			dependsOn: [],
			status: 'completed',
			integrationOrder: 0,
			worktreeSubdir: 'worktrees/task-leak',
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
			planPolicyHash: '4'.repeat(64),
			baseCommitSha,
			isParallel: true,
			tasks: [task1, { ...task1, taskId: 'task-other', targetPackage: 'docs', pathPrefixes: ['docs'], integrationOrder: 1, worktreeSubdir: 'worktrees/task-other' }],
			integrationOrder: ['task-leak', 'task-other'],
			createdAt: new Date().toISOString(),
		};

		const mockGitCli = (cmd, args) => {
			if (args[0] === 'rev-parse') return baseCommitSha + '\n';
			if (args[0] === 'worktree' && args[1] === 'add') {
				fs.mkdirSync(args[3], { recursive: true });
				return '';
			}
			if (args[0] === 'diff-tree' && args[1] === '-p') {
				return 'diff --git a/leak.ts b/leak.ts\n+leak';
			}
			if (args[0] === 'diff-tree' && args[1] === '--name-only') {
				// Leak outside pathPrefixes
				return 'packages/shared-base/src/leak.ts\n';
			}
			return '';
		};

		await assert.rejects(
			async () =>
				reconcileTasks({
					runId: fixture.runId,
					taskPlan,
					authorization: { allowedPackages: ['services/billing', 'docs'], allowedPathPrefixes: ['services/billing', 'docs'] },
					runtimeStore: fixture.store,
					gitCli: mockGitCli,
					taskPlanFrozen: true,
				}),
			(err) => err.code === 'PATH_CONTAINMENT_VIOLATION',
		);
	} finally {
		fixture.close();
	}
});

test('resetIntegrationWorktree throws before git worktree add when the plan is unfrozen', () => {
	const gitCalls = [];
	assert.throws(
		() =>
			resetIntegrationWorktree({
				runId: '2026-09-10-reset-unfrozen',
				baseCommitSha: 'a'.repeat(40),
				taskPlanFrozen: false,
				gitCli: (cmd, args) => {
					gitCalls.push({ cmd, args });
					return '';
				},
			}),
		(error) => error.code === 'POLICY_VIOLATION',
	);
	assert.equal(gitCalls.length, 0);
});

test('resetIntegrationWorktree cleans and recreates checkout without git reset --hard', () => {
	const runId = '2026-09-04-reset-wt-test';
	const baseCommitSha = 'a'.repeat(40);
	const gitCalls = [];

	const mockGitCli = (cmd, args) => {
		gitCalls.push({ cmd, args });
		if (args[0] === 'rev-parse') return baseCommitSha + '\n';
		if (args[0] === 'worktree' && args[1] === 'add') {
			fs.mkdirSync(args[3], { recursive: true });
			return '';
		}
		return '';
	};

	const result = resetIntegrationWorktree({
		runId,
		baseCommitSha,
		gitCli: mockGitCli,
		taskPlanFrozen: true,
	});

	assert.ok(result.worktreeDir.endsWith(path.join('worktrees', 'integration')));
	// Assert git reset --hard was never called
	const resetCall = gitCalls.find((c) => c.args.includes('reset') && c.args.includes('--hard'));
	assert.equal(resetCall, undefined);
});
