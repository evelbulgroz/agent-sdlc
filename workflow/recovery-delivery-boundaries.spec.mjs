import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import test from 'node:test';
import { runCli } from '../cli/cli.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { RuntimeStore } from '../persistence/runtime-store.ts';
import {
	cleanupRun,
	seedSlice4CrashWorktree,
	startSpecApproved,
	waitForBoundary,
} from '../testing/recovery-fixtures.mjs';
import {
	createMockExecCli,
	createMockGitCli,
	createSlice2SmartGovernor,
	createSlice4SmartGovernor,
	multiPackageProposal,
	seedCitingSpecs,
} from '../testing/test-support.mjs';

test('Slice 3 git and commit crash boundaries resume without duplicate commits', async (t) => {
	const commitSha = 'c'.repeat(40);

	await t.test('branch-created-transition-recorded', async () => {
		const { runId } = await startSpecApproved('s3-branch');
		try {
			const child = fork(
				path.join(REPOSITORY_ROOT, 'testing/crash-fixture-runner.mjs'),
				[
					'--root',
					REPOSITORY_ROOT,
					'--mode',
					'authorize',
					'--run',
					runId,
					'--interactive',
					'--create-branch',
					'--create-local-commits',
					'--mock-system',
					'--boundary',
					'branch-created-transition-recorded',
				],
				{ cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
			);
			const marker = await waitForBoundary(child);
			assert.equal(marker.name, 'branch-created-transition-recorded');
			child.kill('SIGTERM');
			await new Promise((resolve) => child.once('exit', resolve));

			const resumed = await runCli(['resume', '--run', runId], {
				rootDir: REPOSITORY_ROOT,
				governor: createSlice2SmartGovernor(),
				gitCli: createMockGitCli({ commitSha, onWorktreeAdd: seedCitingSpecs }),
				execCli: createMockExecCli({ commitSha }),
			});
			assert.equal(
				resumed.result.state,
				'DONE',
				resumed.result.error
					? `${resumed.result.error.code}: ${resumed.result.error.message}`
					: JSON.stringify(resumed.result),
			);
			assert.equal(resumed.result.commitSha, commitSha);
		} finally {
			cleanupRun(runId);
		}
	});

	await t.test('committed-transition-recorded', async () => {
		const { runId } = await startSpecApproved('s3-commit');
		try {
			const child = fork(
				path.join(REPOSITORY_ROOT, 'testing/crash-fixture-runner.mjs'),
				[
					'--root',
					REPOSITORY_ROOT,
					'--mode',
					'authorize',
					'--run',
					runId,
					'--interactive',
					'--create-branch',
					'--create-local-commits',
					'--mock-system',
					'--boundary',
					'committed-transition-recorded',
				],
				{ cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
			);
			const marker = await waitForBoundary(child);
			assert.equal(marker.name, 'committed-transition-recorded');
			child.kill('SIGTERM');
			await new Promise((resolve) => child.once('exit', resolve));

			const resumed = await runCli(['resume', '--run', runId], {
				rootDir: REPOSITORY_ROOT,
				governor: createSlice2SmartGovernor(),
				gitCli: createMockGitCli({
					commitSha,
					initialHead: commitSha,
					initialBranch: `agent-sdlc/${runId}`,
				}),
				execCli: createMockExecCli({ commitSha, assumeCommitted: true }),
			});
			assert.equal(resumed.result.state, 'DONE');

			const store = new RuntimeStore(
				path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
			);
			try {
				const events = store.listEvents(runId);
				assert.equal(events.filter((event) => event.eventType === 'GIT_COMMITTED').length, 1);
				assert.equal(events.filter((event) => event.eventType === 'RUN_COMPLETED').length, 1);
			} finally {
				store.close();
			}
		} finally {
			cleanupRun(runId);
		}
	});

	await t.test('done-transition-recorded', async () => {
		const { runId } = await startSpecApproved('s3-done');
		try {
			const child = fork(
				path.join(REPOSITORY_ROOT, 'testing/crash-fixture-runner.mjs'),
				[
					'--root',
					REPOSITORY_ROOT,
					'--mode',
					'authorize',
					'--run',
					runId,
					'--interactive',
					'--create-branch',
					'--create-local-commits',
					'--mock-system',
					'--boundary',
					'done-transition-recorded',
				],
				{ cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
			);
			const marker = await waitForBoundary(child);
			assert.equal(marker.name, 'done-transition-recorded');
			child.kill('SIGTERM');
			await new Promise((resolve) => child.once('exit', resolve));

			const resumed = await runCli(['resume', '--run', runId], {
				rootDir: REPOSITORY_ROOT,
				governor: createSlice2SmartGovernor(),
				gitCli: createMockGitCli({
					commitSha,
					initialHead: commitSha,
					initialBranch: `agent-sdlc/${runId}`,
				}),
				execCli: createMockExecCli({ commitSha, assumeCommitted: true }),
			});
			assert.equal(resumed.result.state, 'DONE');
		} finally {
			cleanupRun(runId);
		}
	});
});

test('Slice 4 multi-task execution and reconciliation crash boundaries resume cleanly', async (t) => {
	const surfaces = ['packages/ddd-base', 'apps/services/conditioning'];

	await t.test('parent completed before child worktree add - child dir absent and resumes cleanly', async () => {
		const proposal = multiPackageProposal(surfaces);
		const { runId } = await startSpecApproved('s4-parent-done', proposal);
		try {
			const child = fork(
				path.join(REPOSITORY_ROOT, 'testing/crash-fixture-runner.mjs'),
				[
					'--root',
					REPOSITORY_ROOT,
					'--mode',
					'authorize',
					'--run',
					runId,
					'--interactive',
					'--slice4',
					'--boundary',
					'task_completed_transition_recorded',
					'--occurrence',
					'1',
				],
				{ cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
			);
			const marker = await waitForBoundary(child);
			assert.equal(marker.name, 'task_completed_transition_recorded');
			assert.equal(marker.taskId, 'ddd-base-task');

			// Child worktree dir must be absent before child worktree add
			const childWorktreeDir = path.join(
				REPOSITORY_ROOT,
				'tools/.agent-sdlc',
				runId,
				'worktrees/conditioning-task',
			);
			assert.equal(
				fs.existsSync(childWorktreeDir),
				false,
				'child worktree directory must not exist yet',
			);

			child.kill('SIGTERM');
			await new Promise((resolve) => child.once('exit', resolve));

			const resumed = await runCli(['resume', '--run', runId], {
				rootDir: REPOSITORY_ROOT,
				governor: createSlice4SmartGovernor({ surfaces }),
				gitCli: createMockGitCli({ onWorktreeAdd: seedSlice4CrashWorktree }),
				execCli: createMockExecCli(),
			});
			assert.equal(
				resumed.result.state,
				'READY_FOR_GIT_APPROVAL',
				resumed.result.error
					? `${resumed.result.error.code}: ${resumed.result.error.message}`
					: JSON.stringify(resumed.result),
			);

			const store = new RuntimeStore(
				path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
			);
			try {
				const plan = store.getTaskPlan(runId);
				assert.ok(plan);
				const task0 = plan.tasks.find((task) => task.taskId === 'ddd-base-task');
				const task1 = plan.tasks.find((task) => task.taskId === 'conditioning-task');
				assert.equal(task0.status, 'completed');
				assert.equal(task1.status, 'completed');
				assert.ok(task0.targetTreeSha);
				assert.ok(task1.targetTreeSha);
			} finally {
				store.close();
			}
		} finally {
			cleanupRun(runId);
		}
	});

	await t.test('child worktree add crash - resume reuses stored parent commit', async () => {
		const proposal = multiPackageProposal(surfaces);
		const { runId } = await startSpecApproved('s4-child-wt', proposal);
		try {
			const child = fork(
				path.join(REPOSITORY_ROOT, 'testing/crash-fixture-runner.mjs'),
				[
					'--root',
					REPOSITORY_ROOT,
					'--mode',
					'authorize',
					'--run',
					runId,
					'--interactive',
					'--slice4',
					'--boundary',
					'worktree-prepared-transition-recorded',
					'--task-id',
					'conditioning-task',
				],
				{ cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
			);
			const marker = await waitForBoundary(child);
			assert.equal(marker.name, 'worktree-prepared-transition-recorded');
			assert.equal(marker.taskId, 'conditioning-task');

			const childWorktreeDir = path.join(
				REPOSITORY_ROOT,
				'tools/.agent-sdlc',
				runId,
				'worktrees/conditioning-task',
			);
			assert.equal(
				fs.existsSync(childWorktreeDir),
				true,
				'child worktree directory must exist after child worktree add',
			);

			// Inspect stored parentCommitSha before resume
			let storedParentCommitSha;
			const preStore = new RuntimeStore(
				path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
			);
			try {
				const plan = preStore.getTaskPlan(runId);
				const task1 = plan.tasks.find((task) => task.taskId === 'conditioning-task');
				assert.ok(task1.parentCommitSha, 'parentCommitSha must be stored in dag_tasks');
				storedParentCommitSha = task1.parentCommitSha;
			} finally {
				preStore.close();
			}

			child.kill('SIGTERM');
			await new Promise((resolve) => child.once('exit', resolve));

			const resumed = await runCli(['resume', '--run', runId], {
				rootDir: REPOSITORY_ROOT,
				governor: createSlice4SmartGovernor({ surfaces }),
				gitCli: createMockGitCli({ onWorktreeAdd: seedSlice4CrashWorktree }),
				execCli: createMockExecCli(),
			});
			assert.equal(
				resumed.result.state,
				'READY_FOR_GIT_APPROVAL',
				resumed.result.error
					? `${resumed.result.error.code}: ${resumed.result.error.message}`
					: JSON.stringify(resumed.result),
			);

			const postStore = new RuntimeStore(
				path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
			);
			try {
				const plan = postStore.getTaskPlan(runId);
				const task1 = plan.tasks.find((task) => task.taskId === 'conditioning-task');
				assert.equal(task1.status, 'completed');
				assert.equal(
					task1.parentCommitSha,
					storedParentCommitSha,
					'resume must reuse stored parentCommitSha without minting a new commit',
				);
			} finally {
				postStore.close();
			}
		} finally {
			cleanupRun(runId);
		}
	});

	await t.test('reconciliation started crash - integration worktree recreated from baseCommitSha without git reset --hard', async () => {
		const proposal = multiPackageProposal(surfaces);
		const { runId } = await startSpecApproved('s4-recon-crash', proposal);
		try {
			const child = fork(
				path.join(REPOSITORY_ROOT, 'testing/crash-fixture-runner.mjs'),
				[
					'--root',
					REPOSITORY_ROOT,
					'--mode',
					'authorize',
					'--run',
					runId,
					'--interactive',
					'--slice4',
					'--boundary',
					'reconciliation-started-transition-recorded',
				],
				{ cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
			);
			const marker = await waitForBoundary(child);
			assert.equal(marker.name, 'reconciliation-started-transition-recorded');

			child.kill('SIGTERM');
			await new Promise((resolve) => child.once('exit', resolve));

			// Simulate leftover/corrupted state in integration worktree
			const integrationWorktreeDir = path.join(
				REPOSITORY_ROOT,
				'tools/.agent-sdlc',
				runId,
				'worktrees/integration',
			);
			fs.mkdirSync(integrationWorktreeDir, { recursive: true });
			fs.writeFileSync(path.join(integrationWorktreeDir, 'dirty-leftover.txt'), 'corrupt');

			const gitCommands = [];
			const baseGitCli = createMockGitCli({ onWorktreeAdd: seedSlice4CrashWorktree });
			const spyGitCli = (cmd, args, opts) => {
				gitCommands.push({ cmd, args, opts });
				return baseGitCli(cmd, args, opts);
			};

			const resumed = await runCli(['resume', '--run', runId], {
				rootDir: REPOSITORY_ROOT,
				governor: createSlice4SmartGovernor({ surfaces }),
				gitCli: spyGitCli,
				execCli: createMockExecCli(),
			});
			assert.equal(
				resumed.result.state,
				'READY_FOR_GIT_APPROVAL',
				resumed.result.error
					? `${resumed.result.error.code}: ${resumed.result.error.message}`
					: JSON.stringify(resumed.result),
			);

			// Assert that git reset was never called
			const hasGitReset = gitCommands.some(
				(call) => call.cmd === 'git' && call.args && call.args.includes('reset'),
			);
			assert.equal(hasGitReset, false, 'reconciliation resume must never call git reset');

			// Assert dirty leftover file was eliminated by fresh recreation
			assert.equal(
				fs.existsSync(path.join(integrationWorktreeDir, 'dirty-leftover.txt')),
				false,
				'leftover dirty files must be cleaned by resetIntegrationWorktree',
			);

			const store = new RuntimeStore(
				path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
			);
			try {
				const events = store.listEvents(runId);
				assert.ok(events.some((event) => event.eventType === 'RECONCILIATION_COMPLETED'));
			} finally {
				store.close();
			}
		} finally {
			cleanupRun(runId);
		}
	});
});
