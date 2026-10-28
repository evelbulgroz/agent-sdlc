import assert from 'node:assert/strict';
import test from 'node:test';
import {
	FakeModelGovernor,
} from '../testing/fake-model-governor.mjs';
import {
	makeFixture,
} from '../testing/test-support.mjs';
import {
	TaskExecutor,
} from './task-executor.ts';

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
					title: 'Implement conditioning',
					targetPackage: 'apps/services/conditioning',
					pathPrefixes: ['apps/services/conditioning'],
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
						allowedPackages: ['apps/services/conditioning'],
						allowedPathPrefixes: ['apps/services/conditioning'],
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
					targetPackage: 'apps/services/conditioning',
					pathPrefixes: ['apps/services/conditioning'],
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
						allowedPackages: ['apps/services/conditioning'],
						allowedPathPrefixes: ['apps/services/conditioning'],
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
