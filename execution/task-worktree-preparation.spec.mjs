import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRuntimeDirectory } from '../persistence/run-paths.ts';
import {
	FakeModelGovernor,
} from '../testing/fake-model-governor.ts';
import {
	makeFixture,
} from '../testing/test-support.mjs';
import { writePriorTaskHandoff } from '../workflow/prior-task-tree.ts';
import {
	TaskExecutor,
} from './task-executor.ts';
import { prepareTaskWorktree } from './task-worktree-preparation.ts';

test('TaskExecutor rejects execution when the task plan is not frozen', async () => {
	const fixture = makeFixture('task_unfrozen', []);
	const gitCalls = [];
	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Test unfrozen plan',
		});
		const taskPlan = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			planPolicyHash: '0'.repeat(64),
			baseCommitSha: 'a'.repeat(40),
			isParallel: false,
			tasks: [
				{
					taskId: 'task-0',
					title: 'Implement billing',
					targetPackage: 'services/billing',
					pathPrefixes: ['services/billing'],
					dependsOn: [],
					status: 'pending',
					integrationOrder: 0,
					worktreeSubdir: 'worktree',
					baseCommitSha: 'a'.repeat(40),
					parentTreeSha: null,
					targetTreeSha: null,
					patchHash: null,
					failurePacketArtifact: null,
					repairCount: 0,
				},
			],
			integrationOrder: ['task-0'],
			createdAt: new Date().toISOString(),
		};
		fixture.store.saveTaskPlan(taskPlan);
		const executor = new TaskExecutor({
			governor: new FakeModelGovernor([]),
			runtimeStore: fixture.store,
			artifactStore: fixture.artifacts,
			roleRegistry: fixture.registry,
			gitCli: (cmd, args) => {
				gitCalls.push({ cmd, args });
				return '';
			},
		});
		await assert.rejects(
			() =>
				executor.executeTaskPlan({
					taskPlan,
					authorization: {
						allowedPackages: ['services/billing'],
						allowedPathPrefixes: ['services/billing'],
						allowedOperations: {
							createDetachedWorktree: true,
							editIsolatedWorktree: true,
							runAllowlistedCommands: true,
						},
					},
					snapshot: { taskPlanFrozen: false },
				}),
			(error) => error.code === 'POLICY_VIOLATION',
		);
		assert.equal(
			gitCalls.some((call) => call.args[0] === 'worktree'),
			false,
		);
	} finally {
		fixture.close();
	}
});

test('TaskExecutor rejects execution when createDetachedWorktree is not permitted', async () => {
	const fixture = makeFixture('task_perm_denied', []);
	const baseCommitSha = 'a'.repeat(40);

	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Test perm denied',
		});

		const taskPlan = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			planPolicyHash: '0'.repeat(64),
			baseCommitSha,
			isParallel: false,
			tasks: [
				{
					taskId: 'task-0',
					title: 'Task 0',
					targetPackage: 'services/billing',
					pathPrefixes: ['services/billing'],
					dependsOn: [],
					status: 'pending',
					integrationOrder: 0,
					worktreeSubdir: 'worktree',
					baseCommitSha,
					parentTreeSha: null,
					parentCommitSha: null,
					targetTreeSha: null,
					patchHash: null,
					failurePacketArtifact: null,
					repairCount: 0,
				},
			],
			integrationOrder: ['task-0'],
			createdAt: new Date().toISOString(),
		};

		fixture.store.saveTaskPlan(taskPlan);

		const executor = new TaskExecutor({
			governor: new FakeModelGovernor([]),
			runtimeStore: fixture.store,
			artifactStore: fixture.artifacts,
			roleRegistry: fixture.registry,
			gitCli: () => '',
		});

		await assert.rejects(
			async () =>
				executor.executeTaskPlan({
					taskPlan,
					authorization: {
						allowedPackages: ['services/billing'],
						allowedPathPrefixes: ['services/billing'],
						allowedOperations: { createDetachedWorktree: false },
					},
					snapshot: { taskPlanFrozen: true },
				}),
			(err) => err.code === 'OPERATION_NOT_PERMITTED',
		);
	} finally {
		fixture.close();
	}
});

function git(cwd, args) {
	return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('an independent task worktree receives the recorded prior checkout', async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prior-worktree-'));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'prior-worktree-dir-'));
	t.after(() => {
		fs.rmSync(outside, { recursive: true, force: true });
		fs.rmSync(root, { recursive: true, force: true });
	});
	fs.mkdirSync(path.join(root, 'docs/specs/runs'), { recursive: true });
	git(root, ['init']);
	git(root, ['config', 'user.email', 'fixture@example.com']);
	git(root, ['config', 'user.name', 'Fixture Host']);
	fs.mkdirSync(path.join(root, 'src'));
	fs.writeFileSync(path.join(root, 'src/done.ts'), 'base-done\n');
	fs.writeFileSync(path.join(root, 'src/keep.ts'), 'keep\n');
	git(root, ['add', '.']);
	git(root, ['commit', '-m', 'base']);
	const baseCommit = git(root, ['rev-parse', 'HEAD']);
	const baseTree = git(root, ['rev-parse', 'HEAD^{tree}']);
	fs.writeFileSync(path.join(root, 'src/done.ts'), 'prior-done\n');
	git(root, ['add', 'src/done.ts']);
	const priorTree = git(root, ['write-tree']);
	git(root, ['reset', '--hard', 'HEAD']);
	const runId = '2026-11-24-prior-worktree';
	createRuntimeDirectory(runId, root);
	writePriorTaskHandoff(root, runId, {
		priorRunId: '2026-11-23-halted-prior',
		priorTaskId: 'done-task',
		targetTreeSha: priorTree,
		authoredPaths: ['src/done.ts'],
	});
	const runtimeStore = {
		listEvents() { return []; },
		appendEvent() {},
		updateTaskStatus() {},
	};
	const independentDir = path.join(outside, 'independent');
	await prepareTaskWorktree({
		task: {
			taskId: 'page-task', targetPackage: '.', baseCommitSha: baseCommit, dependsOn: [], pathPrefixes: ['src'],
		},
		taskPlan: { tasks: [] },
		snapshot: { taskPlanFrozen: true, runtimeRevision: 1 },
		runId,
		worktreeDir: independentDir,
		parentTreeSha: baseTree,
		rootDir: root,
		gitCli: execFileSync,
		execCli: () => '',
		runtimeStore,
	});
	assert.equal(git(independentDir, ['rev-parse', 'HEAD']), baseCommit);
	assert.equal(fs.readFileSync(path.join(independentDir, 'src/done.ts'), 'utf8'), 'prior-done\n');
	assert.equal(fs.readFileSync(path.join(independentDir, 'src/keep.ts'), 'utf8'), 'keep\n');

	const derivedDir = path.join(outside, 'derived');
	await prepareTaskWorktree({
		task: {
			taskId: 'quality-task', targetPackage: '.', baseCommitSha: baseCommit, dependsOn: [], pathPrefixes: ['src'],
		},
		taskPlan: { tasks: [] },
		snapshot: { taskPlanFrozen: true, runtimeRevision: 1 },
		runId,
		worktreeDir: derivedDir,
		parentTreeSha: baseTree,
		useDerivedParent: true,
		rootDir: root,
		gitCli: execFileSync,
		execCli: () => '',
		runtimeStore,
	});
	assert.equal(fs.readFileSync(path.join(derivedDir, 'src/done.ts'), 'utf8'), 'base-done\n');

	const dependentDir = path.join(outside, 'dependent');
	await prepareTaskWorktree({
		task: {
			taskId: 'next-task', targetPackage: '.', baseCommitSha: baseCommit, dependsOn: ['page-task'], pathPrefixes: ['src'],
		},
		taskPlan: { tasks: [] },
		snapshot: { taskPlanFrozen: true, runtimeRevision: 1 },
		runId,
		worktreeDir: dependentDir,
		parentTreeSha: baseTree,
		rootDir: root,
		gitCli: execFileSync,
		execCli: () => '',
		runtimeStore,
	});
	assert.equal(fs.readFileSync(path.join(dependentDir, 'src/done.ts'), 'utf8'), 'base-done\n');
});
