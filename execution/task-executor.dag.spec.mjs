import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {
	FakeModelGovernor,
} from '../testing/fake-model-governor.mjs';
import {
	leanWriteAction,
	makeFixture,
} from '../testing/test-support.mjs';
import {
	TaskExecutor,
} from './task-executor.ts';

test('TaskExecutor executes multi-task DAG with dependent tasks and synthetic commits', async () => {
	const fixture = makeFixture('task_exec_multi', []);
	const baseCommitSha = 'a'.repeat(40);
	const baseTreeSha = 'b'.repeat(40);
	const treeSha1 = '1'.repeat(40);
	const syntheticSha = 'e'.repeat(40);
	const treeSha2 = '2'.repeat(40);

	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Test multi-task DAG',
		});

		// Task 1 model governor responses, then Task 2 responses
		const governor = new FakeModelGovernor([
			leanWriteAction('packages/shared-base/src/entity.ts', 'export class BaseEntity {}'),
			{
				action: {
					kind: 'complete',
					summary: 'Done packages/shared-base',
				},
			},
			leanWriteAction(
				'services/billing/src/service.ts',
				'export class Service {}',
			),
			{
				action: {
					kind: 'complete',
					summary: 'Done billing',
				},
			},
		]);

		let currentTaskId = 'task-ddd';
		const checkedOutShas = new Map();
		const gitCalls = [];
		const mockGitCli = (cmd, args, opts) => {
			gitCalls.push({ cmd, args, cwd: opts?.cwd });
			if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
				return (checkedOutShas.get(opts?.cwd) || baseCommitSha) + '\n';
			}
			if (args[0] === 'rev-parse' && args[1]?.includes('^{tree}')) return baseTreeSha + '\n';
			if (args[0] === 'worktree' && args[1] === 'add') {
				fs.mkdirSync(args[3], { recursive: true });
				checkedOutShas.set(args[3], args[4]);
				return '';
			}
			if (args[0] === 'commit-tree') {
				return syntheticSha + '\n';
			}
			if (args[0] === 'diff-index') {
				if (args[3] === baseTreeSha) {
					return 'packages/shared-base/src/entity.ts\n';
				}
				return 'services/billing/src/service.ts\n';
			}
			if (args[0] === 'write-tree') {
				if (gitCalls.filter((c) => c.args[0] === 'write-tree').length === 1) {
					return treeSha1 + '\n';
				}
				return treeSha2 + '\n';
			}
			if (args[0] === 'diff-tree') return 'diff --binary ...\n';
			return '';
		};

		const taskPlan = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			planPolicyHash: '2'.repeat(64),
			baseCommitSha,
			isParallel: true,
			tasks: [
				{
					taskId: 'task-ddd',
					title: 'Update shared-base',
					targetPackage: 'packages/shared-base',
					pathPrefixes: ['packages/shared-base'],
					dependsOn: [],
					status: 'pending',
					integrationOrder: 0,
					worktreeSubdir: 'worktrees/task-ddd',
					baseCommitSha,
					parentTreeSha: null,
					targetTreeSha: null,
					patchHash: null,
					failurePacketArtifact: null,
					repairCount: 0,
					verificationCommand: ['pnpm', 'run', 'test:unit'],
				},
				{
					taskId: 'task-cond',
					title: 'Update billing service',
					targetPackage: 'services/billing',
					pathPrefixes: ['services/billing'],
					dependsOn: ['task-ddd'],
					status: 'pending',
					integrationOrder: 1,
					worktreeSubdir: 'worktrees/task-cond',
					baseCommitSha,
					parentTreeSha: null,
					targetTreeSha: null,
					patchHash: null,
					failurePacketArtifact: null,
					repairCount: 0,
					verificationCommand: ['pnpm', 'run', 'test:unit'],
				},
			],
			integrationOrder: ['task-ddd', 'task-cond'],
			createdAt: new Date().toISOString(),
		};

		fixture.store.saveTaskPlan(taskPlan);

		const executor = new TaskExecutor({
			governor,
			runtimeStore: fixture.store,
			artifactStore: fixture.artifacts,
			roleRegistry: fixture.registry,
			gitCli: mockGitCli,
			execCli: () => '',
			runTaskTests: false,
		});

		const result = await executor.executeTaskPlan({
			taskPlan,
			authorization: {
				allowedPackages: ['packages/shared-base', 'services/billing'],
				allowedPathPrefixes: ['packages/shared-base', 'services/billing'],
			},
			snapshot: { taskPlanFrozen: true },
			specSummary: 'Test multi-task DAG',
			acceptanceCriteria: ['AC1', 'AC2'],
		});

		assert.equal(result.status, 'COMPLETED');
		assert.equal(result.tasks.length, 2);
		assert.equal(result.tasks[0].taskId, 'task-ddd');
		assert.equal(result.tasks[0].status, 'completed');
		assert.equal(result.tasks[0].targetTreeSha, treeSha1);

		assert.equal(result.tasks[1].taskId, 'task-cond');
		assert.equal(result.tasks[1].status, 'completed');
		assert.equal(result.tasks[1].parentTreeSha, treeSha1);
		assert.equal(result.tasks[1].targetTreeSha, treeSha2);

		// Assert synthetic commit was created for dependent task
		const commitTreeCall = gitCalls.find((c) => c.args[0] === 'commit-tree');
		assert.ok(commitTreeCall);
		assert.deepEqual(commitTreeCall.args, [
			'commit-tree',
			treeSha1,
			'-p',
			baseCommitSha,
			'-m',
			'sdlc intermediate parent for task-cond',
		]);
	} finally {
		fixture.close();
	}
});
