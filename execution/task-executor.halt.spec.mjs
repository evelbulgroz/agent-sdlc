import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
	FakeModelGovernor,
} from '../testing/fake-model-governor.mjs';
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
						path: 'apps/services/conditioning/src/completed.ts',
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
				return 'apps/services/conditioning/src/completed.ts\n';
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
					title: 'Implement conditioning',
					targetPackage: 'apps/services/conditioning',
					pathPrefixes: ['apps/services/conditioning'],
					verificationCommand: ['pnpm', '--filter', '@example/conditioning-service', 'test'],
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
				allowedPackages: ['apps/services/conditioning'],
				allowedPathPrefixes: ['apps/services/conditioning'],
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

test('@ac AC-08 Over-budget task halts with CAPACITY_LIMIT_EXCEEDED leaving root checkout clean', async () => {
	const fixture = makeFixture('over-budget-task-exec', []);
	const baseCommitSha = 'a'.repeat(40);
	const baseTreeSha = 'b'.repeat(40);

	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Step limit must fail with CAPACITY_LIMIT_EXCEEDED',
		});

		const governor = new FakeModelGovernor([
			{
				action: {
					kind: 'tool_call',
					toolName: 'write_file',
					summary: 'Write incomplete file',
					parameters: {
						path: 'apps/services/conditioning/src/incomplete.ts',
						content: 'export const incomplete = true;\n',
					},
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
					lean: true,
					verificationCommand: ['pnpm', 'run', 'test:unit'],
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

		const statusBefore = execSync('git status --porcelain', {
			cwd: REPOSITORY_ROOT,
			encoding: 'utf8',
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
				err.metadata?.failureReason === 'GOVERNOR_ROUTES_EXHAUSTED',
		);

		assert.equal(fixture.store.getTask(fixture.runId, 'task-0').status, 'failed');

		// Assert root repository checkout outside worktree remains clean
		const statusAfter = execSync('git status --porcelain', {
			cwd: REPOSITORY_ROOT,
			encoding: 'utf8',
		});
		assert.equal(statusAfter, statusBefore);
	} finally {
		fixture.close();
	}
});

test('@ac AC-08 Exhausted repair budget halts with REPAIR_BUDGET_EXCEEDED leaving root checkout clean', async () => {
	const fixture = makeFixture('exhausted-repair-task-exec', []);
	const baseCommitSha = 'a'.repeat(40);
	const baseTreeSha = 'b'.repeat(40);
	const targetTreeSha = 'c'.repeat(40);

	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Exhausted repairs halt with REPAIR_BUDGET_EXCEEDED',
		});

		const taskPlan = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			planPolicyHash: '0'.repeat(64),
			baseCommitSha,
			isParallel: false,
			tasks: [
				{
					taskId: 't-repair-exhausted',
					title: 'Task with exhausted repairs',
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
					lean: true,
				},
			],
			integrationOrder: ['t-repair-exhausted'],
			createdAt: new Date().toISOString(),
		};
		fixture.store.saveTaskPlan(taskPlan);

		let governorCalls = 0;
		const governor = {
			synthetic: true,
			async assertCanReserve() {},
			execute: async (req) => {
				governorCalls += 1;
				if (governorCalls === 1) {
					// Implementer writes file
					return {
						schemaVersion: '1.0.0',
						status: 'succeeded',
						synthetic: true,
						operationId: req.operationId,
						usageRecordIds: [],
						output: {
							action: {
								kind: 'tool_call',
								toolName: 'write_file',
								summary: 'Write initial code',
								parameters: {
									path: 'apps/services/conditioning/src/code.ts',
									content: 'export const x = 1;\n',
								},
							},
						},
					};
				}
				if (governorCalls === 2) {
					// Implementer completes
					return {
						schemaVersion: '1.0.0',
						status: 'succeeded',
						synthetic: true,
						operationId: req.operationId,
						usageRecordIds: [],
						output: {
							action: {
								kind: 'complete',
								summary: 'Implemented code',
							},
						},
					};
				}
				// Repairer attempts complete
				return {
					schemaVersion: '1.0.0',
					status: 'succeeded',
					synthetic: true,
					operationId: req.operationId,
					usageRecordIds: [],
					output: {
						action: {
							kind: 'complete',
							summary: 'Attempted repair',
						},
					},
				};
			},
		};

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
				// Verification test always fails to force repair exhaustion
				if (args?.[0] === '--filter' && args?.[2] === 'test') {
					const err = new Error('AssertionError: expected pass got fail');
					err.status = 1;
					err.stdout = 'Test suite failed';
					err.stderr = 'AssertionError: persistent defect';
					throw err;
				}
				return '';
			},
		});

		const statusBefore = execSync('git status --porcelain', {
			cwd: REPOSITORY_ROOT,
			encoding: 'utf8',
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
					specSummary: 'Test repair exhaustion',
					acceptanceCriteria: ['AC1'],
				}),
			(err) =>
				err.code === 'TASK_EXECUTION_FAILED' &&
				/verification-failed/.test(err.message),
		);

		assert.equal(fixture.store.getTask(fixture.runId, 't-repair-exhausted').status, 'failed');

		// Assert root repository checkout outside worktree remains clean
		const statusAfter = execSync('git status --porcelain', {
			cwd: REPOSITORY_ROOT,
			encoding: 'utf8',
		});
		assert.equal(statusAfter, statusBefore);
	} finally {
		fixture.close();
	}
});
