import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import {
	sha256,
} from '../policy/contracts.ts';
import {
	captureTaskDelta,
	deriveParentTreeSha,
} from './task-tree-delta.ts';

test('@ac AC-04 deriveParentTreeSha uses the completed predecessor tree', () => {
	const baseCommitSha = 'a'.repeat(40);
	const baseTreeSha = 'b'.repeat(40);
	const parent1TreeSha = 'c'.repeat(40);

	const mockGitCli = (cmd, args) => {
		if (args[0] === 'rev-parse') return baseTreeSha + '\n';
		return '';
	};

	// 1. Root task (dependsOn: [])
	const rootTask = {
		taskId: 'root-task',
		baseCommitSha,
		dependsOn: [],
	};
	const taskPlan = {
		baseCommitSha,
		tasks: [rootTask],
		integrationOrder: ['root-task'],
	};

	const resolvedBase = deriveParentTreeSha({
		task: rootTask,
		taskPlan,
		gitCli: mockGitCli,
	});
	assert.equal(resolvedBase, baseTreeSha);

	// 2. Dependent task (dependsOn: ['root-task'])
	rootTask.targetTreeSha = parent1TreeSha;
	const depTask = {
		taskId: 'dep-task',
		baseCommitSha,
		dependsOn: ['root-task'],
	};
	taskPlan.tasks.push(depTask);
	taskPlan.integrationOrder.push('dep-task');

	const resolvedDep = deriveParentTreeSha({
		task: depTask,
		taskPlan,
		gitCli: mockGitCli,
	});
	assert.equal(resolvedDep, parent1TreeSha);

	// 3. Dependent task whose parent has not completed throws TASK_EXECUTION_FAILED
	const unreadyParent = {
		taskId: 'parent-x',
		baseCommitSha,
		dependsOn: [],
		targetTreeSha: null,
	};
	const blockedTask = {
		taskId: 'blocked-task',
		baseCommitSha,
		dependsOn: ['parent-x'],
	};
	assert.throws(
		() =>
			deriveParentTreeSha({
				task: blockedTask,
				taskPlan: {
					baseCommitSha,
					tasks: [unreadyParent, blockedTask],
					integrationOrder: ['parent-x', 'blocked-task'],
				},
				gitCli: mockGitCli,
			}),
		(err) => err.code === 'TASK_EXECUTION_FAILED',
	);
});

test('deriveParentTreeSha applies the complete ancestor closure for diamond tasks and throws RECONCILIATION_CONFLICT on collision', () => {
	const baseCommitSha = 'a'.repeat(40);
	const ancestorTree = '1'.repeat(40);
	const parent1Tree = '2'.repeat(40);
	const parent2Tree = '3'.repeat(40);
	const synthesizedTree = '4'.repeat(40);

	const ancestor = {
		taskId: 'ancestor',
		baseCommitSha,
		dependsOn: [],
		parentTreeSha: baseCommitSha,
		targetTreeSha: ancestorTree,
	};
	const p1 = {
		taskId: 'p1',
		baseCommitSha,
		dependsOn: ['ancestor'],
		parentTreeSha: ancestorTree,
		targetTreeSha: parent1Tree,
	};
	const p2 = {
		taskId: 'p2',
		baseCommitSha,
		dependsOn: ['ancestor'],
		parentTreeSha: ancestorTree,
		targetTreeSha: parent2Tree,
	};
	const multiTask = {
		taskId: 'multi-child',
		baseCommitSha,
		dependsOn: ['p1', 'p2'],
	};
	const taskPlan = {
		runId: '2026-09-07-test-multi-parent',
		baseCommitSha,
		tasks: [ancestor, p1, p2, multiTask],
		integrationOrder: ['ancestor', 'p1', 'p2', 'multi-child'],
	};

	// 1. Clean merge across two parents
	const gitCalls = [];
	const cleanGitCli = (cmd, args, opts) => {
		gitCalls.push({ cmd, args, opts });
		if (args[0] === 'rev-parse') return baseCommitSha + '\n';
		if (args[0] === 'worktree' && args[1] === 'add') {
			fs.mkdirSync(args[3], { recursive: true });
			return '';
		}
		if (args[0] === 'diff-tree') {
			return 'diff --git a/file.txt b/file.txt\n+patched\n';
		}
		if (args[0] === 'apply') return '';
		if (args[0] === 'read-tree') return '';
		if (args[0] === 'add') return '';
		if (args[0] === 'write-tree') return synthesizedTree + '\n';
		if (args[0] === 'worktree' && args[1] === 'remove') return '';
		return '';
	};

	const result = deriveParentTreeSha({
		task: multiTask,
		taskPlan,
		rootDir: REPOSITORY_ROOT,
		gitCli: cleanGitCli,
		taskPlanFrozen: true,
	});
	assert.equal(result, synthesizedTree);
	assert.deepEqual(
		gitCalls
			.filter((call) => call.args[0] === 'diff-tree')
			.map((call) => call.args.slice(-2)),
		[
			[baseCommitSha, ancestorTree],
			[ancestorTree, parent1Tree],
			[ancestorTree, parent2Tree],
		],
	);

	// 2. Conflicting upstream patch throws RECONCILIATION_CONFLICT
	const conflictGitCli = (cmd, args, opts) => {
		if (args[0] === 'rev-parse') return baseCommitSha + '\n';
		if (args[0] === 'worktree' && args[1] === 'add') {
			fs.mkdirSync(args[3], { recursive: true });
			return '';
		}
		if (args[0] === 'diff-tree') {
			return 'diff --git a/conflict.txt b/conflict.txt\n+collision\n';
		}
		if (args[0] === 'apply') {
			throw new Error('patch does not apply');
		}
		if (args[0] === 'worktree' && args[1] === 'remove') return '';
		return '';
	};

	assert.throws(
		() =>
			deriveParentTreeSha({
				task: multiTask,
				taskPlan,
				rootDir: REPOSITORY_ROOT,
				gitCli: conflictGitCli,
				taskPlanFrozen: true,
			}),
		(err) => {
			assert.equal(err.code, 'RECONCILIATION_CONFLICT');
			assert.equal(err.metadata?.conflictingTaskId, 'ancestor');
			return true;
		},
	);
});

test('captureTaskDelta materializes target tree and throws on path containment escape', () => {
	const tmpDir = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures', `delta-${crypto.randomUUID()}`);
	const dotGit = path.join(tmpDir, '.git');
	fs.mkdirSync(dotGit, { recursive: true });

	const parentTreeSha = '1'.repeat(40);
	const newTreeSha = '2'.repeat(40);
	const binaryDiff = 'diff --git a/test.ts b/test.ts\n+hello';

	const calls = [];
	let stagedFiles = ['services/billing/src/file.ts'];

	const mockGitCli = (cmd, args, opts) => {
		calls.push({ args, env: opts?.env });
		if (args[0] === 'diff-index') {
			return stagedFiles.join('\n') + '\n';
		}
		if (args[0] === 'write-tree') {
			return newTreeSha + '\n';
		}
		if (args[0] === 'diff-tree') {
			return binaryDiff + '\n';
		}
		return '';
	};

	try {
		const task = {
			taskId: 'task-1',
			parentTreeSha,
			pathPrefixes: ['services/billing'],
		};

		// 1. Success case: modified files within pathPrefixes
		const delta = captureTaskDelta({
			task,
			worktreeDir: tmpDir,
			gitCli: mockGitCli,
		});

		assert.equal(delta.targetTreeSha, newTreeSha);
		assert.equal(delta.patch.trim(), binaryDiff);
		assert.equal(delta.patchHash, sha256(delta.patch));
		assert.deepEqual(delta.changedFiles, ['services/billing/src/file.ts']);

		// 2. Escape case: file modified outside pathPrefixes
		stagedFiles = ['packages/shared-base/src/leak.ts'];
		assert.throws(
			() =>
				captureTaskDelta({
					task,
					worktreeDir: tmpDir,
					gitCli: mockGitCli,
				}),
			(err) => err.code === 'PATH_CONTAINMENT_VIOLATION',
		);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('@ac AC-11 captureTaskDelta permits declared generated outputs and rejects other generator deltas', () => {
	const tmpDir = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures', `generated-delta-${crypto.randomUUID()}`);
	fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
	let stagedFiles = ['tools/agent-sdlc/generated/schema.json'];
	const gitCli = (_command, args) => {
		if (args[0] === 'diff-index') return `${stagedFiles.join('\n')}\n`;
		if (args[0] === 'write-tree') return `${'2'.repeat(40)}\n`;
		if (args[0] === 'diff-tree') return 'generated patch\n';
		return '';
	};
	const task = {
		taskId: 'generated-task',
		parentTreeSha: '1'.repeat(40),
		pathPrefixes: ['tools/agent-sdlc'],
		authoredPaths: ['tools/agent-sdlc/execution/tools.mjs'],
		generatedOutputs: ['tools/agent-sdlc/generated'],
	};
	try {
		assert.deepEqual(captureTaskDelta({ task, worktreeDir: tmpDir, gitCli }).changedFiles, [
			'tools/agent-sdlc/generated/schema.json',
		]);
		stagedFiles = ['tools/agent-sdlc/undeclared/schema.json'];
		assert.throws(
			() => captureTaskDelta({ task, worktreeDir: tmpDir, gitCli }),
			(error) => error.code === 'PATH_CONTAINMENT_VIOLATION' && error.message.includes('authored/generated paths'),
		);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});
