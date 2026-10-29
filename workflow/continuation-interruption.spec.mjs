import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../cli/cli.ts';
import { createReconciliationConflictInterrupt } from '../cli/hitl.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { createEvent, RUNTIME_SCHEMA_VERSION } from '../policy/contracts.ts';
import {
	advanceSeed,
	checkpointState,
	cleanupRun,
	createSeedRun,
} from '../testing/continuation-fixtures.mjs';

test('@ac AC-04 @ac AC-14 proven provider interruption continues task from checkpoint leaving sibling completed', async () => {
	const fixture = await createSeedRun({
		label: 'quota-recovery',
		stateName: 'BLOCKED',
		blockedReason: 'GOVERNOR_UNAVAILABLE',
		lastError: {
			code: 'GOVERNOR_UNAVAILABLE',
			message: 'Rate limit exceeded',
			executionProvenFalse: true,
			metadata: {
				executionProvenFalse: true,
				dimension: 'maxPhysicalAttempts',
			},
		},
		semanticRepairsCount: 1,
	});
	try {
		const baseCommitSha = '1'.repeat(40);
		fixture.store.saveAuthorization({
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			runId: fixture.runId,
			approvedSpecHash: fixture.draftHash,
			approvedPlanPolicyHash: 'c'.repeat(64),
			repositoryId: 'agent-sdlc',
			baseCommitSha,
			allowedPackages: ['packages/shared-base'],
			allowedPathPrefixes: ['packages/shared-base/'],
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

		fixture.store.saveTaskPlan({
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			runId: fixture.runId,
			createdAt: new Date().toISOString(),
			planPolicyHash: 'a'.repeat(64),
			baseCommitSha,
			integrationOrder: ['task-a', 'task-b'],
			isParallel: false,
			tasks: [
				{
					taskId: 'task-a',
					title: 'Task A',
					targetPackage: 'packages/shared-base',
					pathPrefixes: ['packages/shared-base/'],
					dependsOn: [],
					status: 'completed',
					integrationOrder: 0,
					worktreeSubdir: 'worktrees/task-a',
					baseCommitSha,
				},
				{
					taskId: 'task-b',
					title: 'Task B',
					targetPackage: 'packages/shared-base',
					pathPrefixes: ['packages/shared-base/'],
					dependsOn: ['task-a'],
					status: 'blocked',
					integrationOrder: 1,
					worktreeSubdir: 'worktrees/task-b',
					baseCommitSha,
				},
			],
		});

		// Status reflects infrastructure retry
		const status = await runCli(['status', '--run', fixture.runId, '--json'], {
			rootDir: REPOSITORY_ROOT,
		});
		assert.equal(status.exitCode, 3);
		assert.deepEqual(status.result.continuation, {
			action: 'resume',
			reason: 'INFRASTRUCTURE_RETRY',
		});
		assert.equal(status.result.tasks.find((t) => t.id === 'task-a').status, 'completed');
		assert.equal(status.result.semanticRepairsCount, 1);
	} finally {
		fixture.store.close();
		cleanupRun(fixture.runId);
	}
});

test('@ac AC-04 route exhaustion continues once without proven non-execution', async () => {
	const fixture = await createSeedRun({
		label: 'route-exhaustion-recovery',
		stateName: 'BLOCKED',
		blockedReason: 'GOVERNOR_ROUTES_EXHAUSTED',
		lastError: {
			code: 'GOVERNOR_ROUTES_EXHAUSTED',
			message: 'All allowed model routes exhausted',
			executionProvenFalse: false,
		},
		semanticRepairsCount: 1,
	});
	try {
		const status = await runCli(['status', '--run', fixture.runId, '--json'], {
			rootDir: REPOSITORY_ROOT,
		});
		assert.equal(status.exitCode, 3);
		assert.deepEqual(status.result.continuation, {
			action: 'resume',
			reason: 'INFRASTRUCTURE_RETRY',
		});
		assert.equal(status.result.semanticRepairsCount, 1);
	} finally {
		fixture.store.close();
		cleanupRun(fixture.runId);
	}
});

test('@ac AC-05 @ac AC-06 @ac AC-07 @ac AC-14 exhausted repair halts on resume and only resets on resume --retry', async () => {
	const fixture = await createSeedRun({
		label: 'exhausted-repair',
		stateName: 'FAILED',
		semanticRepairsCount: 2,
		blockedReason: 'REPAIR_BUDGET_EXHAUSTED',
	});
	try {
		const baseCommitSha = '1'.repeat(40);
		fixture.store.saveAuthorization({
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			runId: fixture.runId,
			approvedSpecHash: fixture.draftHash,
			approvedPlanPolicyHash: 'c'.repeat(64),
			repositoryId: 'agent-sdlc',
			baseCommitSha,
			allowedPackages: ['packages/shared-base'],
			allowedPathPrefixes: ['packages/shared-base/'],
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

		fixture.store.saveTaskPlan({
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			runId: fixture.runId,
			createdAt: new Date().toISOString(),
			planPolicyHash: 'a'.repeat(64),
			baseCommitSha,
			integrationOrder: ['task-a'],
			isParallel: false,
			tasks: [
				{
					taskId: 'task-a',
					title: 'Task A',
					targetPackage: 'packages/shared-base',
					pathPrefixes: ['packages/shared-base/'],
					dependsOn: [],
					status: 'failed',
					integrationOrder: 0,
					worktreeSubdir: 'worktrees/task-a',
					repairCount: 2,
					baseCommitSha,
				},
			],
		});

		// AC-05: resume without --retry exits 3, leaves repair counters unchanged, sets stop / HALTED
		const plainResume = await runCli(['resume', '--run', fixture.runId, '--json'], {
			rootDir: REPOSITORY_ROOT,
		});
		assert.equal(plainResume.exitCode, 3);
		assert.equal(plainResume.result.semanticRepairsCount, 2);
		assert.deepEqual(plainResume.result.continuation, {
			action: 'stop',
			reason: 'HALTED',
		});
		assert.equal(fixture.store.getTaskPlan(fixture.runId).tasks[0].repairCount, 2);

		// AC-07: resume --retry is rejected on SPEC_APPROVED
		const specAppRun = await createSeedRun({ label: 'spec-app-retry', stateName: 'SPEC_APPROVED' });
		try {
			const rejectedRetry = await runCli(
				['resume', '--run', specAppRun.runId, '--retry', '--json'],
				{ rootDir: REPOSITORY_ROOT },
			);
			assert.equal(rejectedRetry.exitCode, 64);
			assert.equal(rejectedRetry.result.error.code, 'INVALID_INPUT');
		} finally {
			specAppRun.store.close();
			cleanupRun(specAppRun.runId);
		}

		// AC-06: resume --retry on exhausted repair clears counters and resets tasks to pending
		const worktreeDir = path.join(fixture.paths.runtimeDir, 'worktree');
		fs.mkdirSync(worktreeDir, { recursive: true });
		await advanceSeed(fixture, {
			to: 'FAILED',
			eventType: 'RUN_FAILED',
			updates: {
				worktreePath: worktreeDir,
				blockedReason: 'REPAIR_BUDGET_EXHAUSTED',
				semanticRepairsCount: 2,
			},
			payload: { reason: 'REPAIR_BUDGET_EXHAUSTED' },
		});
		fixture.store.saveGeneration({
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			runId: fixture.runId,
			generation: 0,
			baseCommitSha,
			targetTreeSha: '2'.repeat(40),
			scopeFingerprints: { 'packages/shared-base': 'd'.repeat(64) },
			taskOwnedPaths: ['packages/shared-base/**'],
			materializedAt: new Date().toISOString(),
		});

		const retryResume = await runCli(
			['resume', '--run', fixture.runId, '--retry', '--json'],
			{
				rootDir: REPOSITORY_ROOT,
				gitCli: (cmd, args) => {
					if (args[0] === 'rev-parse' && args[1] === 'HEAD') return `${'1'.repeat(40)}\n`;
					if (args[0] === 'write-tree') return `${'2'.repeat(40)}\n`;
					if (args[0] === 'branch') return 'detached\n';
					return '';
				},
			},
		);

		const updatedPlan = fixture.store.getTaskPlan(fixture.runId);
		assert.equal(
			updatedPlan.tasks[0].status,
			'pending',
			JSON.stringify(retryResume.result.error ?? retryResume.result.state),
		);
		assert.equal(updatedPlan.tasks[0].repairCount, 0);
		assert.equal(fixture.store.getRun(fixture.runId).semanticRepairsCount, 0);
	} finally {
		fixture.store.close();
		cleanupRun(fixture.runId);
	}
});

test('@ac AC-11 reconciliation conflict interrupt exits 2 with answer and HUMAN_RESPONSE_REQUIRED', async () => {
	const fixture = await createSeedRun({ label: 'recon-conflict', stateName: 'RECONCILING_INTEGRATION' });
	try {
		const interrupt = createReconciliationConflictInterrupt({
			runId: fixture.runId,
			runtimeRevision: fixture.currentState.runtimeRevision,
			failingTaskId: 'task-b',
			conflictDetails: { error: 'Merge conflict in src/index.ts', conflictingTaskId: 'task-b' },
		});
		const requestArtifact = fixture.artifacts.writeJson('reconciliation-conflict', interrupt.payload);
		fixture.store.createInterrupt({
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			interruptId: interrupt.interruptId,
			runId: fixture.runId,
			kind: 'reconciliation_conflict',
			stateHash: interrupt.stateHash,
			requestArtifact,
			status: 'PENDING',
			responseArtifact: null,
			resolvedAt: null,
			createdAt: new Date().toISOString(),
		});

		const waitingState = {
			...fixture.currentState,
			pendingInterruptId: interrupt.interruptId,
			runtimeRevision: fixture.currentState.runtimeRevision + 1,
		};
		fixture.store.saveTransition(
			fixture.currentState.runtimeRevision,
			waitingState,
			createEvent({
				eventType: 'RECONCILIATION_CONFLICT_DETECTED',
				runId: fixture.runId,
				runtimeRevision: waitingState.runtimeRevision,
				state: waitingState,
				input: fixture.currentState,
				output: { interruptId: interrupt.interruptId },
				causalId: interrupt.interruptId,
				payload: { interruptId: interrupt.interruptId },
			}),
		);
		await checkpointState(fixture.runtime, fixture.store.getRun(fixture.runId));

		const status = await runCli(['status', '--run', fixture.runId, '--json'], {
			rootDir: REPOSITORY_ROOT,
		});
		assert.equal(status.exitCode, 2, JSON.stringify(status.result.error ?? status.result.state));
		assert.deepEqual(status.result.continuation, {
			action: 'answer',
			reason: 'HUMAN_RESPONSE_REQUIRED',
		});
	} finally {
		fixture.store.close();
		cleanupRun(fixture.runId);
	}
});

test('@ac AC-12 READY_FOR_GIT_APPROVAL exits 0 with stop and GIT_APPROVAL', async () => {
	const fixture = await createSeedRun({ label: 'git-approval', stateName: 'READY_FOR_GIT_APPROVAL' });
	try {
		const baseCommitSha = '1'.repeat(40);
		fixture.store.saveAuthorization({
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			runId: fixture.runId,
			approvedSpecHash: fixture.draftHash,
			approvedPlanPolicyHash: 'c'.repeat(64),
			repositoryId: 'agent-sdlc',
			baseCommitSha,
			allowedPackages: ['packages/shared-base'],
			allowedPathPrefixes: ['packages/shared-base/'],
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

		const hostHead = execFileSync('git', ['rev-parse', 'HEAD'], {
			cwd: REPOSITORY_ROOT,
			encoding: 'utf8',
		}).trim();
		const status = await runCli(['status', '--run', fixture.runId, '--json'], {
			rootDir: REPOSITORY_ROOT,
		});
		assert.equal(status.exitCode, 0);
		assert.deepEqual(status.result.continuation, {
			action: 'stop',
			reason: 'GIT_APPROVAL',
		});
		assert.equal(
			execFileSync('git', ['rev-parse', 'HEAD'], {
				cwd: REPOSITORY_ROOT,
				encoding: 'utf8',
			}).trim(),
			hostHead,
		);
	} finally {
		fixture.store.close();
		cleanupRun(fixture.runId);
	}
});
