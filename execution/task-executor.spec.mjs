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
	REPOSITORY_ROOT,
} from '../persistence/run-paths.ts';
import {
	currentCanaryBindings,
	evaluateCanaryFreshness,
} from '../policy/reliability.ts';
import {
	POST_IMPLEMENT_RUNTIME,
	PRODUCT_IMPLEMENTER_PATH,
	runProductImplementer,
} from '../testing/task-executor-fixtures.mjs';
import {
	DEFAULT_EXECUTOR_STEP_CEILING,
	TaskExecutor,
	calculateTaskStepCapacity,
	resolveRunMaxPhysicalCalls,
} from './task-executor.ts';
test('@ac AC-04 TaskExecutor.executeMinimalTask wires targetedVerificationCommand and auditGate', async () => {
	const { governor, error, task } = await runProductImplementer({
		label: 'minimal-audit',
		executor: 'minimal',
		sameTree: true,
		sliceId: 'slice-1',
		runtime: POST_IMPLEMENT_RUNTIME,
		verificationCommand: ['pnpm', '--filter', 'apps/services/conditioning', 'test'],
		authoredPaths: [PRODUCT_IMPLEMENTER_PATH],
		execCli: () => '',
		script: [
			{ action: { kind: 'complete', summary: 'first complete triggers audit' } },
			{ action: { kind: 'complete', summary: 'second complete confirms audit' } },
		],
	});
	assert.equal(error, null);
	assert.equal(task?.status, 'completed');
	assert.equal(governor.calls.length, 2);
	assert.match(governor.calls[0].prompt, /Allowlisted commands:/);
	assert.match(governor.calls[0].prompt, /pnpm --filter apps\/services\/conditioning test/);
	assert.match(governor.calls[0].prompt, /### Working set/);
	assert.match(governor.calls[1].prompt, /AUDIT_REQUIRED/);
});


test('TaskExecutor executes 1-task plan and captures delta', async () => {
	const fixture = makeFixture('task-exec-1', []);
	const baseCommitSha = 'a'.repeat(40);
	const baseTreeSha = 'b'.repeat(40);
	const newTreeSha = 'c'.repeat(40);

	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Test task executor 1-task',
		});
		const governor = new FakeModelGovernor([
			leanWriteAction(
				'apps/services/conditioning/src/task.ts',
				'export const val = 42;',
			),
			{
				action: {
					kind: 'complete',
					summary: 'Done conditioning task',
				},
			},
		]);

		const gitCalls = [];
		const mockGitCli = (cmd, args, opts) => {
			gitCalls.push({ cmd, args, cwd: opts?.cwd });
			if (args[0] === 'rev-parse' && args[1] === 'HEAD') return baseCommitSha + '\n';
			if (args[0] === 'rev-parse' && args[1]?.includes('^{tree}')) return baseTreeSha + '\n';
			if (args[0] === 'worktree' && args[1] === 'add') {
				fs.mkdirSync(args[3], { recursive: true });
				return '';
			}
			if (args[0] === 'diff-index') {
				return 'apps/services/conditioning/src/task.ts\n';
			}
			if (args[0] === 'write-tree') return newTreeSha + '\n';
			if (args[0] === 'diff-tree') return 'diff --git a/task.ts ...\n';
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
					verificationCommand: [
						'pnpm',
						'--filter',
						'@example/conditioning-service',
						'test',
					],
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
			runTaskTests: false, // mock tests in unit test
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
		assert.equal(result.tasks.length, 1);
		assert.equal(result.tasks[0].status, 'completed');
		assert.equal(result.tasks[0].targetTreeSha, newTreeSha);
		assert.ok(result.tasks[0].patchHash);

		// Verify task persisted in SQLite
		const storedTask = fixture.store.getTask(fixture.runId, 'task-0');
		assert.equal(storedTask.status, 'completed');
		assert.equal(storedTask.targetTreeSha, newTreeSha);
	} finally {
		fixture.close();
	}
});

test('TaskExecutor fails closed when implementer reaches its step limit', async () => {
	const fixture = makeFixture('step-limit-task-exec', []);
	const baseCommitSha = 'a'.repeat(40);
	const baseTreeSha = 'b'.repeat(40);
	let diffInspected = false;

	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Incomplete implementer result must fail',
		});

		const governor = new FakeModelGovernor([
			leanWriteAction(
				'apps/services/conditioning/src/incomplete.ts',
				'export const incomplete = true;\n',
			),
		]);

		const mockGitCli = (cmd, args, opts) => {
			if (args[0] === 'rev-parse' && args[1] === 'HEAD') return baseCommitSha + '\n';
			if (args[0] === 'rev-parse' && args[1]?.includes('^{tree}')) return baseTreeSha + '\n';
			if (args[0] === 'worktree' && args[1] === 'add') {
				fs.mkdirSync(args[3], { recursive: true });
				return '';
			}
			if (args[0] === 'diff-index') {
				diffInspected = true;
				return 'apps/services/conditioning/src/incomplete.ts\n';
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
			runMaxPhysicalCalls: 1,
			runTaskTests: false,
		});

		await assert.rejects(
			() =>
				executor.executeTaskPlan({
					taskPlan,
					authorization: {
						allowedPackages: ['apps/services/conditioning'],
						allowedPathPrefixes: ['apps/services/conditioning'],
					},
					snapshot: { taskPlanFrozen: true },
					specSummary: 'Test goal',
					acceptanceCriteria: ['AC1'],
				}),
			(err) =>
				err.code === 'TASK_EXECUTION_FAILED' &&
				err.metadata?.failureReason === 'GOVERNOR_ROUTES_EXHAUSTED' &&
				err.metadata?.taskId === 'task-0',
		);

		assert.equal(diffInspected, false);
		assert.equal(fixture.store.getTask(fixture.runId, 'task-0').status, 'failed');
	} finally {
		fixture.close();
	}
});

test('TaskExecutor enforces model run budget limit', async () => {
	const fixture = makeFixture('task_exec_budget', []);
	const baseCommitSha = 'a'.repeat(40);

	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Test budget exhaustion',
		});

		const taskPlan = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			planPolicyHash: '3'.repeat(64),
			baseCommitSha,
			isParallel: false,
			tasks: [
				{
					taskId: 'task-0',
					title: 'Test budget task',
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
				},
			],
			integrationOrder: ['task-0'],
			createdAt: new Date().toISOString(),
		};

		fixture.store.saveTaskPlan(taskPlan);

		// Set runMaxPhysicalCalls to 0 so budget is immediately exhausted
		const executor = new TaskExecutor({
			governor: new FakeModelGovernor([]),
			runtimeStore: fixture.store,
			artifactStore: fixture.artifacts,
			roleRegistry: fixture.registry,
			runMaxPhysicalCalls: 0,
			gitCli: () => baseCommitSha + '\n',
		});

		await assert.rejects(
			async () =>
				executor.executeTaskPlan({
					taskPlan,
					authorization: {
						allowedPackages: ['apps/services/conditioning'],
						allowedPathPrefixes: ['apps/services/conditioning'],
					},
					snapshot: { taskPlanFrozen: true },
				}),
			(err) => err.code === 'BUDGET_EXHAUSTED',
		);

		const task = fixture.store.getTask(fixture.runId, 'task-0');
		assert.equal(task.status, 'failed');
	} finally {
		fixture.close();
	}
});

test('AC-01 & AC-02: TaskExecutor rejects task exceeding 100 steps with CAPACITY_LIMIT_EXCEEDED before worktree creation', async () => {
	const fixture = makeFixture('task_capacity_exceeded', []);
	const baseCommitSha = 'a'.repeat(40);

	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Test capacity exceeded',
		});

		// 50 path prefixes -> 50 * 2 + 4 = 104 > 100
		const pathPrefixes = Array.from({ length: 50 }, (_, i) => `apps/services/conditioning/src/file-${i}.ts`);
		const taskPlan = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			planPolicyHash: '0'.repeat(64),
			baseCommitSha,
			isParallel: false,
			tasks: [
				{
					taskId: 'task-oversized',
					title: 'Oversized Task',
					targetPackage: 'apps/services/conditioning',
					pathPrefixes,
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
			integrationOrder: ['task-oversized'],
			createdAt: new Date().toISOString(),
		};

		fixture.store.saveTaskPlan(taskPlan);

		let worktreeCreated = false;
		const executor = new TaskExecutor({
			governor: new FakeModelGovernor([]),
			runtimeStore: fixture.store,
			artifactStore: fixture.artifacts,
			roleRegistry: fixture.registry,
			gitCli: (cmd, args) => {
				if (args?.[0] === 'worktree') worktreeCreated = true;
				return '';
			},
		});

		await assert.rejects(
			async () =>
				executor.executeTaskPlan({
					taskPlan,
					authorization: {
						allowedPackages: ['apps/services/conditioning'],
						allowedPathPrefixes: pathPrefixes,
						allowedOperations: { createDetachedWorktree: true },
					},
					snapshot: { taskPlanFrozen: true },
				}),
			(err) => {
				assert.equal(err.code, 'CAPACITY_LIMIT_EXCEEDED');
				assert.equal(err.metadata.requiredSteps, 104);
				assert.equal(err.metadata.allowedSteps, 100);
				return true;
			},
		);

		assert.equal(worktreeCreated, false, 'Worktree must not be created before capacity check');
	} finally {
		fixture.close();
	}
});

test('resolveRunMaxPhysicalCalls resolves limit from policy and defaults TaskExecutor to policy limit', () => {
	const resolved = resolveRunMaxPhysicalCalls();
	assert.equal(resolved, 1250);

	const custom = resolveRunMaxPhysicalCalls({
		readFile: () => JSON.stringify({
			profiles: {
				'agent-sdlc-default': {
					limits: { runMaxPhysicalCalls: 180 },
				},
			},
		}),
	});
	assert.equal(custom, 180);

	const fallback = resolveRunMaxPhysicalCalls({
		readFile: () => { throw new Error('File not found'); },
	});
	assert.equal(fallback, 250);

	const executor = new TaskExecutor({
		governor: new FakeModelGovernor([]),
		runtimeStore: {},
		artifactStore: {},
		roleRegistry: {},
	});
	assert.equal(executor.runMaxPhysicalCalls, 1250);
});

test('@ac AC-06 a pre-change bounded-planning hash reports CANARY_STALE', () => {
	const qualificationPath = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/canary-qualification.json',
	);
	const before = fs.existsSync(qualificationPath) ? fs.readFileSync(qualificationPath) : null;
	const current = currentCanaryBindings(REPOSITORY_ROOT);
	const priorHash = '0'.repeat(64);
	assert.notEqual(current.boundedPlanningHash, priorHash);
	const freshness = evaluateCanaryFreshness(
		{
			status: 'PASSED',
			repositoryId: current.repositoryId,
			workflowHash: current.workflowHash,
			boundedPlanningHash: priorHash,
			implementerRoleHash: current.implementerRoleHash,
			modelPolicyHash: current.modelPolicyHash,
		},
		current,
	);
	assert.equal(freshness.status, 'CANARY_STALE');
	assert.equal(freshness.reason, 'boundedPlanningHash-changed');
	const after = fs.existsSync(qualificationPath) ? fs.readFileSync(qualificationPath) : null;
	assert.deepEqual(after, before);
});

test('calculateTaskStepCapacity covers an authorized task and rejects an infeasible path count', () => {
	assert.equal(DEFAULT_EXECUTOR_STEP_CEILING, 80);
	assert.equal(calculateTaskStepCapacity(0), 80);

	const detailed = calculateTaskStepCapacity(28, { detailed: true });
	assert.equal(detailed.requiredSteps, 60);
	assert.ok(detailed.stepCeiling >= 60 && detailed.stepCeiling <= 100);
	assert.equal(detailed.allowedSteps, 100);
	assert.equal(calculateTaskStepCapacity(28), detailed.stepCeiling);

	const paths = Array.from({ length: 28 }, (_, index) => `src/file-${index}.ts`);
	assert.equal(calculateTaskStepCapacity(paths), calculateTaskStepCapacity(28));

	assert.throws(
		() => calculateTaskStepCapacity(50),
		(err) => {
			assert.ok(err instanceof SdlcError);
			assert.equal(err.code, 'CAPACITY_LIMIT_EXCEEDED');
			assert.equal(err.metadata.requiredSteps, 104);
			assert.equal(err.metadata.allowedSteps, 100);
			assert.equal(err.metadata.pathCount, 50);
			assert.match(err.message, /exceeds the absolute step ceiling of 100/);
			return true;
		},
	);
});
