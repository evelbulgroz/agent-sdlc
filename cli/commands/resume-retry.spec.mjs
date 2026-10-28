import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../cli.ts';
import { REPOSITORY_ROOT, createRuntimeDirectory, resolveRunPaths } from '../../persistence/run-paths.ts';
import { RuntimeStore } from '../../persistence/runtime-store.ts';
import { RoleRegistry } from '../../roles/role-registry.ts';
import { ArtifactStore } from '../../persistence/artifacts.ts';
import { SdlcWorkflowRuntime } from '../../workflow/graph.ts';
import { createEvent } from '../../policy/contracts.ts';
import { FakeModelGovernor } from '../../testing/fake-model-governor.mjs';
import { slug, cleanupRun, checkpointState } from '../../testing/cli-test-support.mjs';

test('@ac AC-15 CLI retry resets only the failed task and its unfinished descendants', async () => {
	const testSlug = slug('resume-failed-multitask');
	const runId = `${new Date().toISOString().slice(0, 10)}-${testSlug}`;
	fs.mkdirSync(path.join(REPOSITORY_ROOT, 'docs/specs/runs', runId), { recursive: true });
	createRuntimeDirectory(runId, REPOSITORY_ROOT);
	const paths = resolveRunPaths(runId, REPOSITORY_ROOT);
	const worktreeDir = path.join(paths.runtimeDir, 'worktree');
	const baseCommitSha = '1'.repeat(40);

	let store;
	try {
		fs.mkdirSync(paths.artifactsDir, { recursive: true });
		fs.mkdirSync(path.join(worktreeDir, 'apps/services/conditioning'), { recursive: true });

		store = new RuntimeStore(paths.databasePath);
		const registry = new RoleRegistry({ rootDir: REPOSITORY_ROOT });
		const loaded = registry.load();
		const artifacts = new ArtifactStore({
			artifactsDir: paths.artifactsDir,
			runtimeStore: store,
			maxArtifactBytes: loaded.workflow.limits.maxArtifactBytes,
		});
		const governor = new FakeModelGovernor([
			{ schemaVersion: '1.0.0', status: 'PASS', findings: [] },
		]);
		const runtime = new SdlcWorkflowRuntime({
			runtimeStore: store,
			artifactStore: artifacts,
			registry,
			governor,
		});
		const initial = runtime.initialize({ runId, goal: 'Test resume failed multi-task' });
		const failedState = {
			...initial,
			state: 'FAILED',
			taskPlanHash: 'a'.repeat(64),
			taskPlanFrozen: true,
			runtimeRevision: initial.runtimeRevision + 1,
			worktreePath: worktreeDir,
			blockedReason: 'TASK_EXECUTION_FAILED',
			lastError: {
				code: 'TASK_EXECUTION_FAILED',
				message: 'implementer exhausted its step budget',
				metadata: { taskId: 't-2', implementerStatus: 'step_limit_reached' },
			},
			updatedAt: new Date().toISOString(),
		};
		store.saveTransition(
			initial.runtimeRevision,
			failedState,
			createEvent({
				eventType: 'RUN_FAILED',
				runId,
				runtimeRevision: failedState.runtimeRevision,
				state: failedState,
				input: initial,
				output: { reason: 'TASK_EXECUTION_FAILED' },
				causalId: `${runId}:test-failed`,
				payload: { reason: 'TASK_EXECUTION_FAILED' },
			}),
		);
		await checkpointState(runtime, failedState);

		store.saveAuthorization({
			schemaVersion: '1.0.0',
			runId,
			approvedSpecHash: 'b'.repeat(64),
			approvedPlanPolicyHash: 'c'.repeat(64),
			repositoryId: 'fitness-app',
			baseCommitSha,
			allowedPackages: ['apps/services/conditioning'],
			allowedPathPrefixes: ['apps/services/conditioning/'],
			allowedOperations: {
				editIsolatedWorktree: true,
				runAllowlistedCommands: true,
				createDetachedWorktree: true,
				createBranch: false,
				createLocalCommits: false,
				push: false,
				openPullRequest: false,
			},
			maxSemanticRepairs: 2,
			modelUsageProfile: 'agent-sdlc-default',
			approvedAt: new Date().toISOString(),
			approvalMethod: 'cli_prompt',
			expiresAt: new Date(Date.now() + 86400000).toISOString(),
		});

		store.saveTaskPlan({
			schemaVersion: '1.0.0',
			runId,
			createdAt: new Date().toISOString(),
			planPolicyHash: 'a'.repeat(64),
			baseCommitSha,
			integrationOrder: ['t-1', 't-2', 't-4', 't-3'],
			isParallel: true,
			tasks: [
				{
					taskId: 't-1',
					title: 'Task 1',
					targetPackage: 'apps/services/conditioning',
					pathPrefixes: ['apps/services/conditioning/'],
					dependsOn: [],
					status: 'completed',
					targetTreeSha: '2'.repeat(40),
					integrationOrder: 0,
					worktreeSubdir: 'worktrees/t-1',
					baseCommitSha,
				},
				{
					taskId: 't-2',
					title: 'Task 2',
					targetPackage: 'apps/services/conditioning',
					pathPrefixes: ['apps/services/conditioning/'],
					authoredPaths: ['apps/services/conditioning/src/two.ts'],
					sliceId: 'behavior',
					dependsOn: ['t-1'],
					status: 'failed',
					integrationOrder: 1,
					worktreeSubdir: 'worktrees/t-2',
					baseCommitSha,
					repairCount: 2,
				},
				{
					taskId: 't-4',
					title: 'Task 2 descendant',
					targetPackage: 'apps/services/conditioning',
					pathPrefixes: ['apps/services/conditioning/descendant'],
					authoredPaths: ['apps/services/conditioning/descendant/four.ts'],
					sliceId: 'activation',
					dependsOn: ['t-2'],
					status: 'pending',
					integrationOrder: 2,
					worktreeSubdir: 'worktrees/t-4',
					baseCommitSha,
					repairCount: 1,
				},
				{
					taskId: 't-3',
					title: 'Independent task',
					targetPackage: 'apps/services/conditioning',
					pathPrefixes: ['apps/services/conditioning/independent'],
					dependsOn: [],
					status: 'pending',
					integrationOrder: 3,
					worktreeSubdir: 'worktrees/t-3',
					baseCommitSha,
					repairCount: 1,
				},
			],
		});
		store.close();
		store = null;

		const mockGit = (cmd, args, opts) => {
			if (args[0] === 'read-tree') return '';
			if (args[0] === 'add') return '';
			if (args[0] === 'write-tree') return baseCommitSha;
			if (args[0] === 'diff-tree') return '';
			if (args[0] === 'status') return '';
			return execFileSync(cmd, args, opts);
		};
		const mockExec = () => ({ status: 0, stdout: '', stderr: '' });

		const halted = await runCli(['resume', '--run', runId, '--json'], {
			rootDir: REPOSITORY_ROOT,
			governor,
			gitCli: mockGit,
			execCli: mockExec,
		});
		assert.equal(halted.exitCode, 3);
		assert.deepEqual(halted.result.continuation, { action: 'stop', reason: 'HALTED' });
		const haltedStore = new RuntimeStore(paths.databasePath);
		try {
			const haltedPlan = haltedStore.getTaskPlan(runId);
			assert.equal(haltedPlan.tasks.find((task) => task.taskId === 't-2').status, 'failed');
			assert.equal(haltedPlan.tasks.find((task) => task.taskId === 't-2').repairCount, 2);
		} finally {
			haltedStore.close();
		}

		await runCli(['resume', '--run', runId, '--retry', '--json'], {
			rootDir: REPOSITORY_ROOT,
			governor,
			gitCli: mockGit,
			execCli: mockExec,
		});

		const checkStore = new RuntimeStore(paths.databasePath);
		try {
			const run = checkStore.getRun(runId);
			assert.equal(run.activeGeneration, 1);
			const plan = checkStore.getTaskPlan(runId);
			const t1 = plan.tasks.find((t) => t.taskId === 't-1');
			const t2 = plan.tasks.find((t) => t.taskId === 't-2');
			const t3 = plan.tasks.find((t) => t.taskId === 't-3');
			const t4 = plan.tasks.find((t) => t.taskId === 't-4');
			assert.equal(t1.status, 'completed');
			assert.equal(t1.targetTreeSha, '2'.repeat(40));
			assert.equal(t2.status, 'pending');
			assert.equal(t2.repairCount, 0);
			assert.equal(t2.sliceId, 'behavior');
			assert.deepEqual(t2.authoredPaths, ['apps/services/conditioning/src/two.ts']);
			assert.equal(t4.status, 'pending');
			assert.equal(t4.repairCount, 0);
			assert.equal(t4.sliceId, 'activation');
			assert.deepEqual(t4.pathPrefixes, ['apps/services/conditioning/descendant']);
			assert.equal(t3.status, 'pending');
			assert.equal(t3.repairCount, 1);
		} finally {
			checkStore.close();
		}
	} finally {
		if (store) store.close();
		cleanupRun(runId);
	}
});
