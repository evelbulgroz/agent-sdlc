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
	startSpecApproved,
	waitForBoundary,
} from '../testing/recovery-fixtures.mjs';
import {
	createMockExecCli,
	createMockGitCli,
	createSlice2SmartGovernor,
	seedCitingSpecs,
} from '../testing/test-support.mjs';

test('Slice 2 execution and repair crash boundaries resume without duplicate effects', async (t) => {
	await t.test('authorization-transition-recorded', async () => {
		const { runId } = await startSpecApproved('auth-transition');
		try {
			const child = fork(
				path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/testing/crash-fixture-runner.mjs'),
				[
					'--root',
					REPOSITORY_ROOT,
					'--mode',
					'authorize',
					'--run',
					runId,
					'--interactive',
					'--mock-system',
					'--boundary',
					'authorization-transition-recorded',
				],
				{ cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
			);
			const marker = await waitForBoundary(child);
			assert.equal(marker.name, 'authorization-transition-recorded');
			child.kill('SIGTERM');
			await new Promise((resolve) => child.once('exit', resolve));

			const resumed = await runCli(['resume', '--run', runId], {
				rootDir: REPOSITORY_ROOT,
				governor: createSlice2SmartGovernor(),
				gitCli: createMockGitCli({ onWorktreeAdd: seedCitingSpecs }),
				execCli: createMockExecCli(),
			});
			assert.equal(
				resumed.result.state,
				'READY_FOR_GIT_APPROVAL',
				JSON.stringify(resumed.result.lastError ?? resumed.result.error),
			);

			const store = new RuntimeStore(
				path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
			);
			try {
				assert.ok(store.getAuthorization(runId));
				const events = store.listEvents(runId);
				assert.equal(new Set(events.map((e) => e.eventId)).size, events.length);
			} finally {
				store.close();
			}
		} finally {
			cleanupRun(runId);
		}
	});

	await t.test('worktree-prepared-transition-recorded', async () => {
		const { runId } = await startSpecApproved('worktree-prep');
		try {
			const child = fork(
				path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/testing/crash-fixture-runner.mjs'),
				[
					'--root',
					REPOSITORY_ROOT,
					'--mode',
					'authorize',
					'--run',
					runId,
					'--interactive',
					'--mock-system',
					'--boundary',
					'worktree-prepared-transition-recorded',
				],
				{ cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
			);
			const marker = await waitForBoundary(child);
			assert.equal(marker.name, 'worktree-prepared-transition-recorded');
			child.kill('SIGTERM');
			await new Promise((resolve) => child.once('exit', resolve));

			const resumed = await runCli(['resume', '--run', runId], {
				rootDir: REPOSITORY_ROOT,
				governor: createSlice2SmartGovernor(),
				gitCli: createMockGitCli({ onWorktreeAdd: seedCitingSpecs }),
				execCli: createMockExecCli(),
			});
			assert.equal(
				resumed.result.state,
				'READY_FOR_GIT_APPROVAL',
				JSON.stringify(resumed.result.lastError ?? resumed.result.error),
			);

			const store = new RuntimeStore(
				path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
			);
			try {
				const events = store.listEvents(runId);
				assert.equal(
					events.filter((event) => event.eventType === 'WORKTREE_PREPARED').length,
					1,
				);
				assert.equal(
					events.filter((event) => event.eventType === 'RUN_READY_FOR_GIT_APPROVAL').length,
					1,
				);
			} finally {
				store.close();
			}
		} finally {
			cleanupRun(runId);
		}
	});

	await t.test('worktree-hydrated-transition-recorded', async () => {
		const { runId } = await startSpecApproved('worktree-hydrated');
		try {
			const child = fork(
				path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/testing/crash-fixture-runner.mjs'),
				[
					'--root',
					REPOSITORY_ROOT,
					'--mode',
					'authorize',
					'--run',
					runId,
					'--interactive',
					'--mock-system',
					'--boundary',
					'worktree-hydrated-transition-recorded',
				],
				{ cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
			);
			const marker = await waitForBoundary(child);
			assert.equal(marker.name, 'worktree-hydrated-transition-recorded');
			child.kill('SIGTERM');
			await new Promise((resolve) => child.once('exit', resolve));

			const resumed = await runCli(['resume', '--run', runId], {
				rootDir: REPOSITORY_ROOT,
				governor: createSlice2SmartGovernor(),
				gitCli: createMockGitCli({ onWorktreeAdd: seedCitingSpecs }),
				execCli: createMockExecCli(),
			});
			assert.equal(
				resumed.result.state,
				'READY_FOR_GIT_APPROVAL',
				JSON.stringify(resumed.result.lastError ?? resumed.result.error),
			);

			const store = new RuntimeStore(
				path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
			);
			try {
				const events = store.listEvents(runId);
				assert.equal(
					events.filter((event) => event.eventType === 'WORKTREE_HYDRATED').length,
					1,
				);
			} finally {
				store.close();
			}
		} finally {
			cleanupRun(runId);
		}
	});

	await t.test('task_completed_transition_recorded', async () => {
		const { runId } = await startSpecApproved('tool-result');
		try {
			const child = fork(
				path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/testing/crash-fixture-runner.mjs'),
				[
					'--root',
					REPOSITORY_ROOT,
					'--mode',
					'authorize',
					'--run',
					runId,
					'--interactive',
					'--mock-system',
					'--boundary',
					'task_completed_transition_recorded',
				],
				{ cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
			);
			const marker = await waitForBoundary(child);
			assert.equal(marker.name, 'task_completed_transition_recorded');
			child.kill('SIGTERM');
			await new Promise((resolve) => child.once('exit', resolve));

			const storePath = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite');
			const beforeStore = new RuntimeStore(storePath);
			let implementerOperationsBefore = 0;
			try {
				implementerOperationsBefore = beforeStore.database
					.prepare(
						`SELECT operation_id FROM model_operations
						 WHERE run_id = ? AND operation_id LIKE 'minimal:%'`,
					)
					.all(runId).length;
			} finally {
				beforeStore.close();
			}
			assert.ok(implementerOperationsBefore >= 1);

			const resumed = await runCli(['resume', '--run', runId], {
				rootDir: REPOSITORY_ROOT,
				governor: createSlice2SmartGovernor(),
				gitCli: createMockGitCli({ onWorktreeAdd: seedCitingSpecs }),
				execCli: createMockExecCli(),
			});
			assert.equal(
				resumed.result.state,
				'READY_FOR_GIT_APPROVAL',
				JSON.stringify(resumed.result.lastError ?? resumed.result.error),
			);
			assert.equal(
				fs.readFileSync(path.join(resumed.result.worktreePath, 'tools/example.mjs'), 'utf8'),
				'export const feature = true;\n',
			);

			const store = new RuntimeStore(storePath);
			try {
				const implementerOperationsAfter = store.database
					.prepare(
						`SELECT operation_id FROM model_operations
						 WHERE run_id = ? AND operation_id LIKE 'minimal:%'`,
					)
					.all(runId).length;
				assert.equal(implementerOperationsAfter, implementerOperationsBefore);
			} finally {
				store.close();
			}
		} finally {
			cleanupRun(runId);
		}
	});

	await t.test('generation-materialized-transition-recorded', async () => {
		const { runId } = await startSpecApproved('gen-materialized');
		try {
			const child = fork(
				path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/testing/crash-fixture-runner.mjs'),
				[
					'--root',
					REPOSITORY_ROOT,
					'--mode',
					'authorize',
					'--run',
					runId,
					'--interactive',
					'--mock-system',
					'--boundary',
					'generation-materialized-transition-recorded',
				],
				{ cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
			);
			const marker = await waitForBoundary(child);
			assert.equal(marker.name, 'generation-materialized-transition-recorded');
			child.kill('SIGTERM');
			await new Promise((resolve) => child.once('exit', resolve));

			const resumed = await runCli(['resume', '--run', runId], {
				rootDir: REPOSITORY_ROOT,
				governor: createSlice2SmartGovernor(),
				gitCli: createMockGitCli({ onWorktreeAdd: seedCitingSpecs }),
				execCli: createMockExecCli(),
			});
			assert.equal(resumed.result.state, 'READY_FOR_GIT_APPROVAL');

			const store = new RuntimeStore(
				path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
			);
			try {
				const gen0 = store.getGeneration(runId, 0);
				assert.ok(gen0);
				assert.equal(gen0.generation, 0);
				assert.equal(gen0.targetTreeSha, 'b'.repeat(40));
				const events = store.listEvents(runId);
				assert.equal(
					events.filter((event) => event.eventType === 'GENERATION_MATERIALIZED').length,
					1,
				);
			} finally {
				store.close();
			}
		} finally {
			cleanupRun(runId);
		}
	});

	await t.test('review-evaluated-transition-recorded', async () => {
		const { runId } = await startSpecApproved('review-eval');
		try {
			const child = fork(
				path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/testing/crash-fixture-runner.mjs'),
				[
					'--root',
					REPOSITORY_ROOT,
					'--mode',
					'authorize',
					'--run',
					runId,
					'--interactive',
					'--mock-system',
					'--boundary',
					'review-evaluated-transition-recorded',
				],
				{ cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
			);
			const marker = await waitForBoundary(child);
			assert.equal(marker.name, 'review-evaluated-transition-recorded');
			child.kill('SIGTERM');
			await new Promise((resolve) => child.once('exit', resolve));

			const resumed = await runCli(['resume', '--run', runId], {
				rootDir: REPOSITORY_ROOT,
				governor: createSlice2SmartGovernor(),
				gitCli: createMockGitCli({ onWorktreeAdd: seedCitingSpecs }),
				execCli: createMockExecCli(),
			});
			assert.equal(resumed.result.state, 'READY_FOR_GIT_APPROVAL');

			const store = new RuntimeStore(
				path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
			);
			try {
				const events = store.listEvents(runId);
				assert.equal(
					events.filter((event) => event.eventType === 'REVIEW_EVALUATED').length,
					1,
				);
			} finally {
				store.close();
			}
		} finally {
			cleanupRun(runId);
		}
	});

	await t.test('ready-git-approval-transition-recorded', async () => {
		const { runId } = await startSpecApproved('ready-git');
		try {
			const child = fork(
				path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/testing/crash-fixture-runner.mjs'),
				[
					'--root',
					REPOSITORY_ROOT,
					'--mode',
					'authorize',
					'--run',
					runId,
					'--interactive',
					'--mock-system',
					'--boundary',
					'ready-git-approval-transition-recorded',
				],
				{ cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
			);
			const marker = await waitForBoundary(child);
			assert.equal(marker.name, 'ready-git-approval-transition-recorded');
			child.kill('SIGTERM');
			await new Promise((resolve) => child.once('exit', resolve));

			const resumed = await runCli(['resume', '--run', runId], {
				rootDir: REPOSITORY_ROOT,
				governor: createSlice2SmartGovernor(),
				gitCli: createMockGitCli({ onWorktreeAdd: seedCitingSpecs }),
				execCli: createMockExecCli(),
			});
			assert.equal(resumed.result.state, 'READY_FOR_GIT_APPROVAL');

			const store = new RuntimeStore(
				path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
			);
			try {
				const run = store.getRun(runId);
				assert.equal(run.state, 'READY_FOR_GIT_APPROVAL');
				assert.ok(run.preflightBindingArtifact);
				const events = store.listEvents(runId);
				assert.equal(
					events.filter((event) => event.eventType === 'RUN_READY_FOR_GIT_APPROVAL').length,
					1,
				);
			} finally {
				store.close();
			}
		} finally {
			cleanupRun(runId);
		}
	});

});
