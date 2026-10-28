import assert from 'node:assert/strict';
import test from 'node:test';
import { computeIsParallel, sortTasksTopologically } from './task-graph.ts';
import { BASE_COMMIT_SHA } from '../../testing/task-planner-fixtures.mjs';

test('sortTasksTopologically detects cycles and throws POLICY_VIOLATION', () => {
	const cyclicTasks = [
		{
			taskId: 'task-a',
			title: 'Task A',
			targetPackage: 'pkg-a',
			pathPrefixes: ['pkg-a/'],
			dependsOn: ['task-b'],
			status: 'pending',
			integrationOrder: 0,
			worktreeSubdir: 'worktrees/task-a',
			baseCommitSha: BASE_COMMIT_SHA,
			parentTreeSha: null,
			targetTreeSha: null,
			patchHash: null,
			failurePacketArtifact: null,
			repairCount: 0,
		},
		{
			taskId: 'task-b',
			title: 'Task B',
			targetPackage: 'pkg-b',
			pathPrefixes: ['pkg-b/'],
			dependsOn: ['task-a'],
			status: 'pending',
			integrationOrder: 1,
			worktreeSubdir: 'worktrees/task-b',
			baseCommitSha: BASE_COMMIT_SHA,
			parentTreeSha: null,
			targetTreeSha: null,
			patchHash: null,
			failurePacketArtifact: null,
			repairCount: 0,
		},
	];

	assert.throws(
		() => sortTasksTopologically(cyclicTasks),
		(err) => err.code === 'POLICY_VIOLATION' && /Cyclic task dependencies/.test(err.message),
	);
});

test('@ac AC-04 @case AC-04.4 computeIsParallel is false for a chain and true without a dependency', () => {
	assert.equal(
		computeIsParallel([
			{ taskId: 'a', dependsOn: [] },
			{ taskId: 'b', dependsOn: ['a'] },
		]),
		false,
	);
	assert.equal(
		computeIsParallel([
			{ taskId: 'a', dependsOn: [] },
			{ taskId: 'b', dependsOn: [] },
		]),
		true,
	);
});

test('computeIsParallel returns false for an empty task list and sort returns an empty order', () => {
	assert.equal(computeIsParallel([]), false);
	assert.deepEqual(sortTasksTopologically([]), []);
});
