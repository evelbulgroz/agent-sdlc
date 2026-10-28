import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
	SdlcError,
} from '../policy/errors.ts';
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
import {
	POST_IMPLEMENT_RUNTIME,
	PRODUCT_IMPLEMENTER_ORIGINAL,
	PRODUCT_IMPLEMENTER_PATH,
	failingVerificationExec,
	runProductImplementer,
} from '../testing/task-executor-fixtures.mjs';

test('TaskExecutor completes an empty delta when post-hoc verification passed', async () => {
	const fixture = makeFixture('empty-delta-task-exec', []);
	const baseCommitSha = 'a'.repeat(40);
	const baseTreeSha = 'b'.repeat(40);

	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Empty implementer delta must fail',
		});

		const governor = new FakeModelGovernor([
			{
				action: {
					kind: 'complete',
					summary: 'Nothing to change',
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
			if (args[0] === 'diff-index') return '\n';
			if (args[0] === 'write-tree') return baseTreeSha + '\n';
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
					title: 'Implement conditioning',
					targetPackage: 'apps/services/conditioning',
					pathPrefixes: ['apps/services/conditioning'],
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
					lean: true,
					verificationCommand: ['pnpm', 'run', 'agent:test-sdlc'],
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
			execCli: () => '',
			runTaskTests: false,
			requireWriteToComplete: false,
		});

		const result = await executor.executeTaskPlan({
			taskPlan,
			authorization: {
				allowedPackages: ['apps/services/conditioning'],
				allowedPathPrefixes: ['apps/services/conditioning'],
			},
			snapshot: { taskPlanFrozen: true },
			specSummary: 'Test goal',
			acceptanceCriteria: ['AC1'],
		});

		assert.equal(result.status, 'COMPLETED');
		const storedTask = fixture.store.getTask(fixture.runId, 'task-0');
		assert.equal(storedTask.status, 'completed');
		assert.equal(storedTask.targetTreeSha, baseTreeSha);
	} finally {
		fixture.close();
	}
});

test('governor budget denial fails the attempt and does not start a repairer', async () => {
	const fixture = makeFixture('task_gov_blocked', []);
	const baseCommitSha = 'a'.repeat(40);
	const baseTreeSha = 'b'.repeat(40);

	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Test governor blocked metadata',
		});

		const taskPlan = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			planPolicyHash: '0'.repeat(64),
			baseCommitSha,
			isParallel: false,
			tasks: [
				{
					taskId: 'task-blocked',
					title: 'Blocked Task',
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
					verificationCommand: ['pnpm', 'run', 'agent:test-sdlc'],
				},
			],
			integrationOrder: ['task-blocked'],
			createdAt: new Date().toISOString(),
		};

		fixture.store.saveTaskPlan(taskPlan);

		const governor = {
			synthetic: true,
			async assertCanReserve() {},
			execute: async () => {
				throw new SdlcError('GOVERNOR_BUDGET_DENIED', 'Budget exceeded', {
					dimension: 'totalTokens',
					limit: 50000,
					requested: 55000,
					remaining: 1000,
					taskId: 'task-blocked',
					operationId: 'op-blocked-1',
				});
			},
		};

		const executor = new TaskExecutor({
			governor,
			runtimeStore: fixture.store,
			artifactStore: fixture.artifacts,
			roleRegistry: fixture.registry,
			execCli: () => '',
			gitCli: (cmd, args) => {
				if (args?.[0] === 'rev-parse' && args?.[1] === 'HEAD') return baseCommitSha + '\n';
				if (args?.[0] === 'rev-parse') return baseTreeSha + '\n';
				if (args?.[0] === 'worktree' && args?.[1] === 'add') {
					fs.mkdirSync(args[3], { recursive: true });
					return '';
				}
				return '';
			},
		});

		await assert.rejects(
			async () =>
				executor.executeTaskPlan({
					taskPlan,
					authorization: {
						allowedPackages: ['apps/services/conditioning'],
						allowedPathPrefixes: ['apps/services/conditioning'],
						allowedOperations: { createDetachedWorktree: true },
					},
					snapshot: { taskPlanFrozen: true },
				}),
			(err) => {
				assert.equal(err.code, 'TASK_EXECUTION_FAILED');
				assert.equal(err.metadata.failureReason, 'GOVERNOR_BUDGET_DENIED');
				assert.equal(err.metadata.taskId, 'task-blocked');
				return true;
			},
		);

		const storedTask = fixture.store.getTask(fixture.runId, 'task-blocked');
		assert.equal(storedTask.status, 'failed');
		assert.equal(storedTask.repairCount, 0);
	} finally {
		fixture.close();
	}
});

test('@ac AC-04 @case AC-04.1 a failing verification raises TASK_EXECUTION_FAILED and does not call a repairer', async () => {
	const fixture = makeFixture('task_repair_loop', []);
	const baseCommitSha = 'a'.repeat(40);
	const baseTreeSha = 'b'.repeat(40);
	const targetTreeSha = 'c'.repeat(40);

	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Test task repair loop',
		});

		const taskPlan = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			planPolicyHash: '0'.repeat(64),
			baseCommitSha,
			isParallel: false,
			tasks: [
				{
					taskId: 'task-test-fail',
					title: 'Task with test failure',
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
			integrationOrder: ['task-test-fail'],
			createdAt: new Date().toISOString(),
		};

		fixture.store.saveTaskPlan(taskPlan);

		let governorCalls = 0;
		const governor = {
			synthetic: true,
			calls: [],
			async assertCanReserve() {},
			execute: async (req) => {
				governorCalls += 1;
				governor.calls.push(req);
				const output = governorCalls === 1
					? leanWriteAction('apps/services/conditioning/src/code.ts', 'export const x = 1;')
					: { action: { kind: 'complete', summary: 'Implemented code' } };
				return {
					schemaVersion: '1.0.0',
					status: 'succeeded',
					synthetic: true,
					operationId: req.operationId,
					usageRecordIds: [],
					output,
				};
			},
		};

		let testRuns = 0;
		const executor = new TaskExecutor({
			governor,
			runtimeStore: fixture.store,
			artifactStore: fixture.artifacts,
			roleRegistry: fixture.registry,
			runTaskTests: true,
			gitCli: (cmd, args) => {
				if (args?.[0] === 'rev-parse' && args?.[1] === 'HEAD') return baseCommitSha + '\n';
				if (args?.[0] === 'rev-parse') return baseTreeSha + '\n';
				if (args?.[0] === 'worktree' && args?.[1] === 'add') {
					fs.mkdirSync(args[3], { recursive: true });
					const pkgDir = path.join(args[3], 'apps/services/conditioning');
					fs.mkdirSync(pkgDir, { recursive: true });
					fs.writeFileSync(
						path.join(pkgDir, 'package.json'),
						JSON.stringify({
							name: '@example/conditioning-service',
							scripts: { test: 'node --test' },
						}),
					);
					return '';
				}
				if (args?.[0] === 'diff') return 'diff --git a/apps/services/conditioning/src/code.ts';
				if (args?.[0] === 'diff-index') return 'apps/services/conditioning/src/code.ts\n';
				if (args?.[0] === 'diff-tree') return 'diff --git a/code.ts\n';
				if (args?.[0] === 'write-tree') return targetTreeSha + '\n';
				return '';
			},
			execCli: (cmd, args) => {
				if (args?.[0] === '--filter' && args?.[2] === 'test') {
					testRuns += 1;
					const err = new Error('AssertionError: expected 2 got 1');
					err.status = 1;
					err.stdout = 'Test suite failed';
					err.stderr = 'AssertionError: expected 2 got 1';
					throw err;
				}
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
						allowedOperations: { createDetachedWorktree: true },
						maxSemanticRepairs: 2,
					},
					snapshot: { taskPlanFrozen: true },
				}),
			(err) =>
				err.code === 'TASK_EXECUTION_FAILED' &&
				/verification-failed/.test(err.message) &&
				err.metadata?.failureReason === 'verification-failed',
		);

		assert.equal(testRuns, 3);
		assert.equal(governorCalls, 4);
		assert.equal(
			governor.calls.some((call) => call.attribution?.roleId === 'repairer'),
			false,
		);
		const storedTask = fixture.store.getTask(fixture.runId, 'task-test-fail');
		assert.equal(storedTask.status, 'failed');
		assert.equal(storedTask.repairCount, 0);
	} finally {
		fixture.close();
	}
});

test('@ac AC-01 @case AC-01.2 the product implementer tool_call replace_snapshot_range leaves the file unchanged', async () => {
	const { governor, error, content, task } = await runProductImplementer({
		label: 'product-ac-01-snapshot',
		sameTree: true,
		verificationCommand: ['pnpm', 'run', 'agent:test-sdlc'],
		script: [
			{
				action: {
					kind: 'tool_call',
					toolName: 'replace_snapshot_range',
					parameters: {
						path: PRODUCT_IMPLEMENTER_PATH,
						start_line: 1,
						end_line: 2,
						new_string: 'export const value = "changed";\n',
					},
				},
			},
			{ action: { kind: 'complete', summary: 'Snapshot must not apply' } },
		],
	});
	assert.equal(error, null);
	assert.equal(task?.status, 'completed');
	assert.equal(content, PRODUCT_IMPLEMENTER_ORIGINAL);
	const schemaText = JSON.stringify(governor.calls[0].structuredOutputSchema);
	assert.equal(schemaText.includes('programmer_turn'), false);
	assert.equal(schemaText.includes('tool_call'), true);
	assert.equal(schemaText.includes('replace_snapshot_range'), true);
});

test('@ac AC-01 an omitted executor completes an empty delta when verification passed', async () => {
	const { error, task, content } = await runProductImplementer({
		label: 'omitted-empty-delta',
		sameTree: true,
		verificationCommand: ['pnpm', 'run', 'agent:test-sdlc'],
		script: [
			{
				action: {
					kind: 'tool_call',
					toolName: 'replace_snapshot_range',
					parameters: {
						path: PRODUCT_IMPLEMENTER_PATH,
						start_line: 1,
						end_line: 2,
						new_string: 'export const value = "changed";\n',
					},
				},
			},
			{ action: { kind: 'complete', summary: 'No file change' } },
		],
	});
	assert.equal(error, null);
	assert.equal(task?.status, 'completed');
	assert.equal(content, PRODUCT_IMPLEMENTER_ORIGINAL);
});

test('@ac AC-02 @case AC-02.1 a minimal executor verification failure is not repaired', async () => {
	const { governor, error, task } = await runProductImplementer({
		label: 'minimal-verification-failure',
		executor: 'minimal',
		runtime: POST_IMPLEMENT_RUNTIME,
		verificationCommand: ['pnpm', 'run', 'agent:test-sdlc'],
		execCli: failingVerificationExec(),
		script: [
			{ action: { kind: 'complete', summary: 'done' } },
			{ action: { kind: 'complete', summary: 'done' } },
			{ action: { kind: 'complete', summary: 'done' } },
		],
	});
	assert.equal(governor.calls.length, 3);
	assert.equal(error?.code, 'TASK_EXECUTION_FAILED');
	assert.match(error.message, /verification-failed/);
	assert.doesNotMatch(error.message, /after repair/);
	assert.doesNotMatch(error.message, /post-implement ran/);
	assert.notEqual(task?.status, 'completed');
});

test('@ac AC-09 @case AC-09.1 zero edits and a passing verification complete the minimal task', async () => {
	const { error, task } = await runProductImplementer({
		label: 'minimal-empty-pass',
		executor: 'minimal',
		sameTree: true,
		runtime: POST_IMPLEMENT_RUNTIME,
		verificationCommand: ['pnpm', 'run', 'agent:test-sdlc'],
		script: [{ action: { kind: 'complete', summary: 'done' } }],
	});
	assert.equal(error, null);
	assert.equal(task?.status, 'completed');
});

test('@ac AC-09 @case AC-09.2 a diff outside the authored paths is not completed', async () => {
	const { error, task } = await runProductImplementer({
		label: 'minimal-outside-diff',
		executor: 'minimal',
		runtime: POST_IMPLEMENT_RUNTIME,
		verificationCommand: ['pnpm', 'run', 'agent:test-sdlc'],
		authoredPaths: ['apps/services/conditioning/src/locked.ts'],
		diffFile: 'outside.txt',
		script: [{ action: { kind: 'complete', summary: 'done' } }],
	});
	assert.equal(error?.code, 'PATH_CONTAINMENT_VIOLATION');
	assert.notEqual(task?.status, 'completed');
});

test('@ac AC-09 @case AC-09.3 an empty verification sequence does not complete the task', async () => {
	const { governor, error, task } = await runProductImplementer({
		label: 'minimal-verification-missing',
		executor: 'minimal',
		runtime: POST_IMPLEMENT_RUNTIME,
		script: [{ action: { kind: 'complete', summary: 'done' } }],
	});
	assert.equal(governor.calls.length, 0);
	assert.match(error?.message ?? '', /verification-missing/);
	assert.notEqual(task?.status, 'completed');
});

test('@ac AC-04 @case AC-04.2 task executor tests do not freeze the minimal executor line count', () => {
	const source = fs.readFileSync(new URL(import.meta.url), 'utf8');
	assert.equal(source.includes('minimal-executor.mjs ' + 'is'), false);
	assert.equal(source.includes('controlled-executor.mjs is ' + 'untouched'), false);
	assert.equal(source.includes('lines ' + '<= 600'), false);
});

