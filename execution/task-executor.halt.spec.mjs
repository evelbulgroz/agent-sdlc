import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import os from 'node:os';
import { computeContinuation } from '../cli/continuation.ts';
import { projectHostInvocation } from '../cli/host-invocation.ts';
import { projectTaskProgress, projectTasks } from '../cli/status-document.ts';
import { captureTaskDelta } from './task-tree-delta.ts';
import { omitCompletedAuthoredPaths } from '../workflow/prior-task-tree.ts';
import { SdlcError } from '../policy/errors.ts';
import {
	FakeModelGovernor,
} from '../testing/fake-model-governor.ts';
import {
	makeFixture,
} from '../testing/test-support.mjs';
import {
	REPOSITORY_ROOT,
} from '../persistence/run-paths.ts';
import {
	TaskExecutor,
} from './task-executor.ts';

test('@ac AC-07 Task completion is gated by deterministic verification in TaskExecutor', async () => {
	const fixture = makeFixture('gated-verification-task-exec', []);
	const baseCommitSha = 'a'.repeat(40);
	const baseTreeSha = 'b'.repeat(40);
	let verificationCommandRan = false;

	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Task completion verification gate',
		});

		const governor = new FakeModelGovernor([
			{
				action: {
					kind: 'tool_call',
					toolName: 'write_file',
					summary: 'Write completed file',
					parameters: {
						path: 'services/billing/src/completed.ts',
						content: 'export const completed = true;\n',
					},
				},
			},
			{
				action: {
					kind: 'complete',
					summary: 'Done with implementation',
				},
			},
		]);

		const mockGitCli = (cmd, args, opts) => {
			if (args[0] === 'rev-parse' && args[1] === 'HEAD') return baseCommitSha + '\n';
			if (args[0] === 'rev-parse' && args[1]?.includes('^{tree}')) return baseTreeSha + '\n';
			if (args[0] === 'worktree' && args[1] === 'add') {
				fs.mkdirSync(args[3], { recursive: true });
				return '';
			}
			if (args[0] === 'diff-index') {
				return 'services/billing/src/completed.ts\n';
			}
			if (args[0] === 'write-tree') {
				return 'c'.repeat(40) + '\n';
			}
			return '';
		};

		const taskPlan = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			planPolicyHash: '1'.repeat(64),
			baseCommitSha,
			isParallel: false,
			tasks: [
				{
					taskId: 'task-0',
					title: 'Implement billing',
					targetPackage: 'services/billing',
					pathPrefixes: ['services/billing'],
					verificationCommand: ['pnpm', '--filter', '@fixture/billing-service', 'test'],
					dependsOn: [],
					status: 'pending',
					integrationOrder: 0,
					worktreeSubdir: 'worktree',
					baseCommitSha,
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
			governor,
			runtimeStore: fixture.store,
			artifactStore: fixture.artifacts,
			roleRegistry: fixture.registry,
			gitCli: mockGitCli,
			execCli: (_cmd, args) => {
				if (args.includes('test')) {
					verificationCommandRan = true;
				}
				return 'pass';
			},
			runTaskTests: true,
		});

		await executor.executeTaskPlan({
			taskPlan,
			authorization: {
				allowedPackages: ['services/billing'],
				allowedPathPrefixes: ['services/billing'],
			},
			snapshot: { taskPlanFrozen: true },
			specSummary: 'Test goal',
			acceptanceCriteria: ['AC1'],
		});

		assert.equal(verificationCommandRan, true);
		assert.equal(fixture.store.getTask(fixture.runId, 'task-0').status, 'completed');
	} finally {
		fixture.close();
	}
});

const TREE = 'a'.repeat(40);
const OTHER = 'd'.repeat(40);

function haltedPlan() {
	return {
		slices: [{ sliceId: 'slice-a' }],
		tasks: [
			{
				taskId: 'done-task', title: 'Completed import', targetPackage: '.', sliceId: 'slice-a',
				pathPrefixes: ['src'], dependsOn: [], status: 'completed', targetTreeSha: TREE,
			},
			{
				taskId: 'open-task', title: 'Page still open', targetPackage: '.', sliceId: 'slice-a',
				pathPrefixes: ['src'], dependsOn: ['done-task'], status: 'pending', targetTreeSha: OTHER,
			},
			{
				taskId: 'untreed-task', title: 'Completed without a tree', targetPackage: '.', sliceId: 'slice-a',
				pathPrefixes: ['src'], dependsOn: [], status: 'completed', targetTreeSha: null,
			},
		],
	};
}

test('@ac AC-01: status names the completed tree after a halt', async (t) => {
	const plan = haltedPlan();
	const state = {
		runId: '2026-11-23-halted-run',
		state: 'BLOCKED',
		blockedReason: 'QUALITY_CONFIRMED',
		pendingInterruptId: null,
		lastError: null,
	};
	const progress = projectTaskProgress(plan, projectTasks(plan, state), state);
	const continuation = computeContinuation(state);
	const card = projectHostInvocation(state);

	await t.test('@case AC-01.1: completed task is listed', () => {
		assert.equal(continuation.reason, 'HALTED');
		assert.equal(card.retry.allowed, false);
		assert.deepEqual(progress.completedCheckpoints, [
			{ taskId: 'done-task', sliceId: 'slice-a', targetTreeSha: TREE },
		]);
	});

	await t.test('@case AC-01.2: a task that never completed has no tree to continue', () => {
		const ids = progress.completedCheckpoints.map((checkpoint) => checkpoint.taskId);
		assert.equal(ids.includes('open-task'), false);
		assert.equal(ids.includes('untreed-task'), false);
	});

	await t.test('a retryable infrastructure halt is not this continuation', () => {
		const retryable = {
			runId: '2026-11-23-retryable-run', state: 'BLOCKED', blockedReason: 'HYDRATION_FAILED', pendingInterruptId: null,
		};
		assert.equal(computeContinuation(retryable).reason, 'INFRASTRUCTURE_RETRY');
		assert.equal(projectHostInvocation(retryable).retry.allowed, true);
	});
});

function git(cwd, args) {
	return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halt-delta-'));
	git(root, ['init']);
	git(root, ['config', 'user.email', 'fixture@example.com']);
	git(root, ['config', 'user.name', 'Fixture Host']);
	fs.mkdirSync(path.join(root, 'src'));
	fs.writeFileSync(path.join(root, 'src/done.ts'), 'export const done = 1;\n');
	fs.writeFileSync(path.join(root, 'src/page.ts'), 'export const page = 1;\n');
	git(root, ['add', '.']);
	git(root, ['commit', '-m', 'base']);
	return { root, tree: git(root, ['rev-parse', 'HEAD^{tree}']) };
}

test('@ac AC-03: the implementer cannot rewrite the completed paths', async (t) => {
	const repo = makeRepo();
	t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }));
	const task = {
		taskId: 'page-task',
		parentTreeSha: repo.tree,
		pathPrefixes: ['src'],
		authoredPaths: ['src/page.ts'],
	};

	await t.test('@case AC-03.1: edit inside a completed path is rejected', () => {
		fs.writeFileSync(path.join(repo.root, 'src/done.ts'), 'export const done = 2;\n');
		assert.throws(
			() => captureTaskDelta({ task, worktreeDir: repo.root, rootDir: repo.root, gitCli: execFileSync }),
			(error) => error instanceof SdlcError && error.code === 'PATH_CONTAINMENT_VIOLATION',
		);
		git(repo.root, ['checkout', '--', 'src/done.ts']);
	});

	await t.test('@case AC-03.2: edit inside a new authored path is accepted', () => {
		fs.writeFileSync(path.join(repo.root, 'src/page.ts'), 'export const page = 2;\n');
		const delta = captureTaskDelta({ task, worktreeDir: repo.root, rootDir: repo.root, gitCli: execFileSync });
		assert.deepEqual(delta.changedFiles, ['src/page.ts']);
		assert.notEqual(delta.targetTreeSha, repo.tree);
		git(repo.root, ['checkout', '--', 'src/page.ts']);
	});

	await t.test('a parent authored prefix cannot authorize an edit of the completed file', () => {
		const omitted = omitCompletedAuthoredPaths({
			tasks: [{
				taskId: 'page-task', authoredPaths: ['src', 'src/page.ts'], pathPrefixes: ['src'], generatedOutputs: ['src'],
			}],
		}, ['src/done.ts']);
		assert.deepEqual(omitted.tasks[0].authoredPaths, ['src/page.ts']);
		assert.deepEqual(omitted.tasks[0].generatedOutputs, []);
		assert.deepEqual(omitted.tasks[0].pathPrefixes, ['src']);
		const narrowed = { ...omitted.tasks[0], parentTreeSha: repo.tree };
		fs.writeFileSync(path.join(repo.root, 'src/done.ts'), 'export const done = 2;\n');
		assert.throws(
			() => captureTaskDelta({ task: narrowed, worktreeDir: repo.root, rootDir: repo.root, gitCli: execFileSync }),
			(error) => error instanceof SdlcError && error.code === 'PATH_CONTAINMENT_VIOLATION',
		);
		git(repo.root, ['checkout', '--', 'src/done.ts']);
		fs.writeFileSync(path.join(repo.root, 'src/page.ts'), 'export const page = 2;\n');
		const delta = captureTaskDelta({ task: narrowed, worktreeDir: repo.root, rootDir: repo.root, gitCli: execFileSync });
		assert.deepEqual(delta.changedFiles, ['src/page.ts']);
		git(repo.root, ['checkout', '--', 'src/page.ts']);
	});

	await t.test('an unchanged worktree records no completed-path edit', () => {
		const delta = captureTaskDelta({ task, worktreeDir: repo.root, rootDir: repo.root, gitCli: execFileSync });
		assert.deepEqual(delta.changedFiles, []);
		assert.equal(delta.targetTreeSha, repo.tree);
	});

	await t.test('a failing git read surfaces instead of an empty delta', () => {
		const gitCli = () => {
			throw new Error('git unavailable');
		};
		assert.throws(
			() => captureTaskDelta({ task, worktreeDir: repo.root, rootDir: repo.root, gitCli }),
			/git unavailable/,
		);
	});
});
