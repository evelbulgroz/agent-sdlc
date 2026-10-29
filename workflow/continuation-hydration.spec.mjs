import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../cli/cli.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { canonicalJson, RUNTIME_SCHEMA_VERSION } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import {
	advanceSeed,
	cleanupRun,
	createSeedRun,
} from '../testing/continuation-fixtures.mjs';
import {
	computeHydrationFingerprint,
	hydrateWorktree,
	isWorktreeHydrated,
	refreshLockfile,
} from './hydration.ts';

test('@ac AC-08 @ac AC-14 authorized manifest change refreshes lockfile via pnpm install before frozen install', async () => {
	const tempDir = fs.mkdtempSync(path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-ac08-'));
	try {
		const recordedCommands = [];
		const mockRunner = (cmd, args) => {
			recordedCommands.push([cmd, ...args].join(' '));
			return '';
		};

		await refreshLockfile({
			worktreeDir: tempDir,
			runner: mockRunner,
		});

		assert.equal(recordedCommands.length, 2);
		assert.equal(recordedCommands[0], 'pnpm install');
		assert.equal(recordedCommands[1], 'pnpm install --frozen-lockfile');

		const pkgDir = path.join(tempDir, 'packages', 'shared-base');
		fs.mkdirSync(pkgDir, { recursive: true });
		fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true });
		const manifestPath = path.join(pkgDir, 'package.json');
		fs.writeFileSync(manifestPath, '{"name":"@fixture/shared-base"}\n');
		fs.writeFileSync(path.join(tempDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
		const packages = ['packages/shared-base'];
		const markerPath = path.join(path.dirname(tempDir), `hydration-${path.basename(tempDir)}.json`);
		fs.writeFileSync(
			markerPath,
			JSON.stringify({ fingerprint: computeHydrationFingerprint(tempDir, packages) }),
		);
		assert.equal(isWorktreeHydrated(tempDir, packages), true);
		fs.writeFileSync(manifestPath, '{"name":"@fixture/shared-base","version":"0.0.1"}\n');
		assert.equal(isWorktreeHydrated(tempDir, packages), false);

		const hydrated = await hydrateWorktree({
			worktreeDir: tempDir,
			allowedPackages: packages,
			runner: () => '',
		});
		assert.notEqual(hydrated.status, 'CACHED');

		// Failure in pnpm install throws HYDRATION_FAILED with runner text
		const failingRunner = (cmd, args) => {
			const err = new Error('Command failed: pnpm install');
			err.stderr = 'ERR_PNPM_FETCH_404 Package not found in registry';
			throw err;
		};

		await assert.rejects(
			async () => {
				await refreshLockfile({
					worktreeDir: tempDir,
					runner: failingRunner,
				});
			},
			(err) => {
				assert.equal(err.code, 'HYDRATION_FAILED');
				assert.match(err.message, /ERR_PNPM_FETCH_404 Package not found in registry/);
				return true;
			},
		);
	} finally {
		fs.rmSync(path.join(path.dirname(tempDir), `hydration-${path.basename(tempDir)}.json`), {
			force: true,
		});
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-03 @ac AC-09 @ac AC-10 @ac AC-14 hydration failure continues once with resume and halts on repeated resume with stop', async () => {
	const fixture = await createSeedRun({
		label: 'hydration-retry',
		stateName: 'BLOCKED',
		blockedReason: 'HYDRATION_FAILED',
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

		const worktreePath = path.join(fixture.paths.runtimeDir, 'worktree');
		fs.mkdirSync(worktreePath, { recursive: true });
		await advanceSeed(fixture, {
			to: 'BLOCKED',
			eventType: 'RUN_BLOCKED',
			updates: {
				approvedSpecHash: fixture.draftHash,
				worktreePath,
				blockedReason: 'HYDRATION_FAILED',
				semanticRepairsCount: 1,
			},
			payload: { reason: 'HYDRATION_FAILED' },
		});

		const failingHydrate = () => {
			throw new SdlcError('HYDRATION_FAILED', 'Frozen lockfile mismatch in hydration');
		};

		// First resume without --retry re-enters hydration, records attempt, returns exit 3 with INFRASTRUCTURE_RETRY
		const resume1 = await runCli(['resume', '--run', fixture.runId, '--json'], {
			rootDir: REPOSITORY_ROOT,
			execCli: failingHydrate,
		});
		assert.equal(
			resume1.exitCode,
			3,
			JSON.stringify(resume1.result.error ?? resume1.result.continuation),
		);
		assert.equal(resume1.result.state, 'BLOCKED');
		assert.equal(resume1.result.semanticRepairsCount, 1);
		assert.deepEqual(resume1.result.continuation, {
			action: 'resume',
			reason: 'INFRASTRUCTURE_RETRY',
		});
		const taskPlanAfter1 = fixture.store.getTaskPlan(fixture.runId);
		assert.equal(taskPlanAfter1.tasks.find((t) => t.taskId === 'task-a').status, 'completed');
		const runtimeRevision = resume1.result.runtimeRevision;
		const statusPath = path.join(REPOSITORY_ROOT, 'docs/specs/runs', fixture.runId, 'status.json');
		const publishedResume = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
		const outboxBeforeStop = canonicalJson(
			fixture.store.getProjectionRecord(fixture.runId, runtimeRevision).status,
		);
		assert.deepEqual(resume1.result.hostInvocation.argv, [
			'pnpm',
			'run',
			'agent:sdlc',
			'--',
			'resume',
			'--run',
			fixture.runId,
			'--json',
		]);
		assert.equal(resume1.result.hostInvocation.retry.allowed, true);
		assert.equal(publishedResume.orchestration.runtimeRevision, runtimeRevision);

		// Second resume on unchanged run does not call graph, returns exit 3 with stop / HALTED
		let graphCalled = false;
		const guardExecCli = () => {
			graphCalled = true;
			return '';
		};
		const resume2 = await runCli(['resume', '--run', fixture.runId, '--json'], {
			rootDir: REPOSITORY_ROOT,
			execCli: guardExecCli,
		});
		assert.equal(resume2.exitCode, 3);
		assert.equal(resume2.result.state, 'BLOCKED');
		assert.equal(resume2.result.semanticRepairsCount, 1);
		assert.deepEqual(resume2.result.continuation, {
			action: 'stop',
			reason: 'HALTED',
		});
		assert.equal(graphCalled, false);
		assert.equal(resume2.result.ok, true);
		assert.equal(resume2.result.runtimeRevision, runtimeRevision);
		assert.equal(resume2.result.hostInvocation.executable, false);
		assert.equal(resume2.result.hostInvocation.argv, null);
		assert.equal(resume2.result.hostInvocation.packetConsumed, true);
		assert.equal(resume2.result.hostInvocation.exitCode, 3);
		const publishedStop = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
		assert.ok(publishedStop.revision > publishedResume.revision);
		assert.equal(publishedStop.orchestration.runtimeRevision, runtimeRevision);
		assert.equal(
			canonicalJson(fixture.store.getProjectionRecord(fixture.runId, runtimeRevision).status),
			outboxBeforeStop,
		);
		assert.equal(fixture.store.getContinuationAttempts(fixture.runId, 'HYDRATION_FAILED'), 2);
		assert.equal(canonicalJson(publishedStop.continuation), canonicalJson(resume2.result.continuation));
		assert.equal(
			canonicalJson(publishedStop.hostInvocation),
			canonicalJson(resume2.result.hostInvocation),
		);
		const replay = await runCli(['status', '--run', fixture.runId, '--json'], {
			rootDir: REPOSITORY_ROOT,
		});
		assert.equal(replay.exitCode, 3, JSON.stringify(replay.result.error ?? replay.result.continuation));
		assert.equal(replay.result.ok, true);
		assert.equal(canonicalJson(replay.result.continuation), canonicalJson(resume2.result.continuation));
		assert.equal(
			canonicalJson(replay.result.hostInvocation),
			canonicalJson(resume2.result.hostInvocation),
		);
		const replayedFile = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
		assert.equal(canonicalJson(replayedFile.continuation), canonicalJson(resume2.result.continuation));
		assert.equal(
			canonicalJson(replayedFile.hostInvocation),
			canonicalJson(resume2.result.hostInvocation),
		);
		const projectionEventsBeforeRecovery = fixture.store
			.listEvents(fixture.runId)
			.filter((event) => event.eventType === 'PROJECTION_WRITTEN').length;
		fs.unlinkSync(statusPath);
		const recovered = await runCli(['status', '--run', fixture.runId, '--json'], {
			rootDir: REPOSITORY_ROOT,
		});
		assert.equal(recovered.exitCode, 3, JSON.stringify(recovered.result.error ?? recovered.result.continuation));
		assert.equal(recovered.result.ok, true);
		assert.deepEqual(recovered.result.continuation, {
			action: 'stop',
			reason: 'HALTED',
		});
		assert.equal(recovered.result.hostInvocation.executable, false);
		assert.equal(recovered.result.hostInvocation.argv, null);
		assert.equal(recovered.result.hostInvocation.packetConsumed, true);
		const recoveredFile = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
		assert.equal(recoveredFile.revision, publishedStop.revision);
		assert.equal(recoveredFile.orchestration.runtimeRevision, runtimeRevision);
		assert.equal(canonicalJson(recoveredFile.continuation), canonicalJson(recovered.result.continuation));
		assert.equal(
			canonicalJson(recoveredFile.hostInvocation),
			canonicalJson(recovered.result.hostInvocation),
		);
		assert.equal(
			canonicalJson(fixture.store.getProjectionRecord(fixture.runId, runtimeRevision).status),
			outboxBeforeStop,
		);
		assert.equal(
			fixture.store.listEvents(fixture.runId).filter((event) => event.eventType === 'PROJECTION_WRITTEN')
				.length,
			projectionEventsBeforeRecovery,
		);

		const policyFile = path.join(fixture.paths.runtimeDir, 'local-policy.json');
		fs.writeFileSync(
			policyFile,
			`${JSON.stringify({
				fingerprintProbe: fixture.runId,
				routes: [{ id: 'xai-grok-quality', enabled: false }],
			})}\n`,
		);
		const policyOptions = { rootDir: REPOSITORY_ROOT, localPolicyPath: policyFile };
		const changedStatus = await runCli(['status', '--run', fixture.runId, '--json'], policyOptions);
		assert.equal(changedStatus.exitCode, 3, JSON.stringify(changedStatus.result.error ?? changedStatus.result.continuation));
		assert.deepEqual(changedStatus.result.continuation, {
			action: 'resume',
			reason: 'INFRASTRUCTURE_RETRY',
		});
		let policyGraphCalls = 0;
		const policyResume = await runCli(['resume', '--run', fixture.runId, '--json'], {
			...policyOptions,
			execCli: () => {
				policyGraphCalls += 1;
				throw new SdlcError('HYDRATION_FAILED', 'Frozen lockfile mismatch in hydration');
			},
		});
		assert.ok(policyGraphCalls > 0);
		assert.equal(policyResume.exitCode, 3, JSON.stringify(policyResume.result.error ?? policyResume.result.continuation));
		assert.equal(policyResume.result.state, 'BLOCKED');
		assert.equal(policyResume.result.semanticRepairsCount, 1);
		assert.deepEqual(policyResume.result.continuation, {
			action: 'resume',
			reason: 'INFRASTRUCTURE_RETRY',
		});
		assert.equal(fixture.store.getContinuationAttempts(fixture.runId, 'HYDRATION_FAILED'), 1);
		const taskPlanAfterPolicy = fixture.store.getTaskPlan(fixture.runId);
		assert.equal(taskPlanAfterPolicy.tasks.find((task) => task.taskId === 'task-a').status, 'completed');
		let haltedGraphCalls = 0;
		const policyHalt = await runCli(['resume', '--run', fixture.runId, '--json'], {
			...policyOptions,
			execCli: () => {
				haltedGraphCalls += 1;
				return '';
			},
		});
		assert.equal(haltedGraphCalls, 0);
		assert.equal(policyHalt.exitCode, 3, JSON.stringify(policyHalt.result.error ?? policyHalt.result.continuation));
		assert.equal(policyHalt.result.semanticRepairsCount, 1);
		assert.deepEqual(policyHalt.result.continuation, {
			action: 'stop',
			reason: 'HALTED',
		});
		assert.equal(fixture.store.getContinuationAttempts(fixture.runId, 'HYDRATION_FAILED'), 2);
	} finally {
		fixture.store.close();
		cleanupRun(fixture.runId);
	}
});
