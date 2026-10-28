import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../cli/cli.ts';
import { createApprovalInterrupt } from '../cli/hitl.ts';
import { REPOSITORY_ROOT, resolveRunPaths } from '../persistence/run-paths.ts';
import { RuntimeStore } from '../persistence/runtime-store.ts';
import { validateAuthorizationEnvelope } from '../policy/authorization.ts';
import { canonicalJson, RUNTIME_SCHEMA_VERSION } from '../policy/contracts.ts';
import {
	checkpointState,
	cleanupRun,
	createSeedRun,
	slug,
	writeResponse,
} from '../testing/continuation-fixtures.mjs';
import { FakeModelGovernor } from '../testing/fake-model-governor.mjs';
import { completeProposal, grammaticalAcceptance } from '../testing/test-support.mjs';
import { createApprovalBinding } from './specification.ts';
import { createDetachedWorktree } from './worktrees.ts';

test('@ac AC-01 @ac AC-14 headless approve binds hash and yields exit 2 authorize without envelope', async () => {
	const governor = new FakeModelGovernor([completeProposal()]);
	const testSlug = slug('approve-no-envelope');
	let runId;
	try {
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Approve a specification without an envelope'],
			{ rootDir: REPOSITORY_ROOT, governor },
		);
		assert.equal(started.exitCode, 2, JSON.stringify(started.result.error ?? started.result.state));
		assert.equal(started.result.state, 'WAITING_FOR_ANSWERS');
		runId = started.result.runId;
		const pending = started.result.pendingInterrupt;
		const answerFile = writeResponse(runId, 'answer', {
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			interruptId: pending.interruptId,
			stateHash: pending.request.stateHash,
			answers: [
				{ questionId: 'acceptance', value: grammaticalAcceptance('Approved spec exists') },
				{ questionId: 'failure', value: 'Stale responses fail' },
				{ questionId: 'verification', value: 'Targeted tests pass' },
			],
		});
		const answered = await runCli(
			['answer', '--run', runId, '--interrupt', pending.interruptId, '--response-file', answerFile, '--json'],
			{ rootDir: REPOSITORY_ROOT, governor },
		);
		assert.equal(answered.exitCode, 2, JSON.stringify(answered.result.error ?? answered.result.state));
		assert.equal(answered.result.state, 'WAITING_FOR_APPROVAL');
		const draftHash = answered.result.pendingInterrupt.request.draftHash;
		const paths = resolveRunPaths(runId, REPOSITORY_ROOT);
		const store = new RuntimeStore(paths.databasePath);
		try {
			const missingHash = await runCli(['approve', '--run', runId, '--json'], {
				rootDir: REPOSITORY_ROOT,
				governor,
			});
			assert.equal(missingHash.exitCode, 64);
			assert.equal(missingHash.result.ok, false);
			assert.equal(missingHash.result.error.code, 'INVALID_INPUT');
			assert.equal(store.getRun(runId).state, 'WAITING_FOR_APPROVAL');

			const staleResult = await runCli(
				['approve', '--run', runId, '--spec-hash', '0'.repeat(64), '--json'],
				{ rootDir: REPOSITORY_ROOT, governor },
			);
			assert.equal(staleResult.exitCode, 64);
			assert.equal(staleResult.result.ok, false);
			assert.equal(staleResult.result.error.code, 'STALE_RESPONSE');
			assert.equal(store.getRun(runId).state, 'WAITING_FOR_APPROVAL');
			assert.equal(store.getPendingInterrupt(runId).status, 'PENDING');
			assert.equal(
				store.listEvents(runId).some((event) => event.eventType === 'SPEC_APPROVED'),
				false,
			);

			const approvedResult = await runCli(
				['approve', '--run', runId, '--spec-hash', draftHash, '--json'],
				{ rootDir: REPOSITORY_ROOT, governor },
			);
			assert.equal(
				approvedResult.exitCode,
				2,
				JSON.stringify(approvedResult.result.error ?? approvedResult.result.continuation),
			);
			assert.equal(approvedResult.result.state, 'SPEC_APPROVED');
			assert.equal(approvedResult.result.approvedSpecHash, draftHash);
			assert.equal(approvedResult.result.pendingInterrupt, null);
			assert.deepEqual(approvedResult.result.continuation, {
				action: 'authorize',
				reason: 'AUTHORIZATION_REQUIRED',
			});
			assert.match(approvedResult.human, /authorize/);

			const statusResult = await runCli(['status', '--run', runId, '--json'], {
				rootDir: REPOSITORY_ROOT,
				governor,
			});
			assert.equal(statusResult.exitCode, 2);
			assert.equal(statusResult.result.state, 'SPEC_APPROVED');
			assert.equal(statusResult.result.approvedSpecHash, draftHash);
			assert.equal(statusResult.result.pendingInterrupt, null);
			assert.deepEqual(statusResult.result.continuation, {
				action: 'authorize',
				reason: 'AUTHORIZATION_REQUIRED',
			});

			const wrongState = await runCli(
				['approve', '--run', runId, '--spec-hash', draftHash, '--json'],
				{ rootDir: REPOSITORY_ROOT, governor },
			);
			assert.equal(wrongState.exitCode, 64);
			assert.equal(wrongState.result.error.code, 'INVALID_INPUT');
			assert.equal(store.getRun(runId).state, 'SPEC_APPROVED');
		} finally {
			store.close();
		}
	} finally {
		if (runId) cleanupRun(runId);
	}
});

test('@ac AC-10 @ac AC-14 HEAD drift maintains envelope baseCommitSha for detached worktree', async () => {
	const fixture = await createSeedRun({ label: 'head-drift', stateName: 'SPEC_APPROVED' });
	try {
		const baseCommitSha = '1'.repeat(40);
		const currentHeadSha = '9'.repeat(40);

		const envelope = {
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			runId: fixture.runId,
			approvedSpecHash: fixture.draftHash,
			approvedPlanPolicyHash: 'b'.repeat(64),
			repositoryId: 'fitness-app',
			baseCommitSha,
			allowedPackages: ['packages/ddd-base'],
			allowedPathPrefixes: ['packages/ddd-base/'],
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
		};

		// Validation succeeds against envelope baseCommitSha even when live HEAD is different
		const validated = validateAuthorizationEnvelope(envelope, {
			currentRunId: fixture.runId,
			currentSpecHash: fixture.draftHash,
		});
		assert.equal(validated.baseCommitSha, baseCommitSha);

		const worktreeDir = path.join(fixture.paths.runtimeDir, 'worktree');
		const gitCalls = [];
		const created = createDetachedWorktree({
			runId: fixture.runId,
			baseCommitSha,
			worktreeDir,
			rootDir: REPOSITORY_ROOT,
			gitCli: (cmd, args, options = {}) => {
				gitCalls.push(args);
				if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
					return options.cwd === worktreeDir ? `${baseCommitSha}\n` : `${currentHeadSha}\n`;
				}
				return '';
			},
		});
		assert.equal(created.baseCommitSha, baseCommitSha);
		assert.equal(created.commitSha, baseCommitSha);
		const addCall = gitCalls.find((args) => args[0] === 'worktree' && args[1] === 'add');
		assert.ok(addCall);
		assert.equal(addCall.at(-1), baseCommitSha);
	} finally {
		fixture.store.close();
		cleanupRun(fixture.runId);
	}
});

test('@ac AC-01 @ac AC-10 approval pause replays one host card from the command, status, and status.json', async () => {
	const fixture = await createSeedRun({
		label: 'approval-card',
		stateName: 'REVIEWING_SPEC',
	});
	try {
		const current = fixture.store.getRun(fixture.runId);
		const approval = createApprovalBinding({
			runId: fixture.runId,
			draftHash: fixture.draftHash,
			runtimeRevision: current.runtimeRevision + 1,
			workflowHash: current.workflowHash,
			roleHash: current.roleHash,
			promptPolicyHash: current.promptPolicyHash,
			completenessResultHash: current.completenessHash,
			timestamp: new Date().toISOString(),
		});
		const interrupt = createApprovalInterrupt({
			runId: fixture.runId,
			runtimeRevision: current.runtimeRevision + 1,
			draftHash: fixture.draftHash,
			approval,
		});
		const requestArtifact = fixture.artifacts.writeJson('approval-interrupt', interrupt.payload);
		fixture.runtime.transition(current, {
			to: 'WAITING_FOR_APPROVAL',
			eventType: 'APPROVAL_REQUESTED',
			causalId: interrupt.interruptId,
			updates: { pendingInterruptId: interrupt.interruptId },
			payload: { interruptId: interrupt.interruptId, requestArtifact },
			effects: {
				createInterrupt: {
					interruptId: interrupt.interruptId,
					runId: fixture.runId,
					kind: 'approval',
					stateHash: interrupt.stateHash,
					requestArtifact,
					createdAt: new Date().toISOString(),
				},
			},
		});
		await checkpointState(fixture.runtime, fixture.store.getRun(fixture.runId));
		const status = await runCli(['status', '--run', fixture.runId, '--json'], {
			rootDir: REPOSITORY_ROOT,
		});
		assert.equal(status.exitCode, 2, JSON.stringify(status.result.error ?? status.result.state));
		assert.equal(status.result.ok, true);
		assert.deepEqual(status.result.continuation, {
			action: 'answer',
			reason: 'HUMAN_RESPONSE_REQUIRED',
		});
		assert.equal(status.result.hostInvocation.packetConsumed, true);
		assert.equal(status.result.hostInvocation.executable, true);
		assert.deepEqual(status.result.hostInvocation.argv, [
			'pnpm',
			'run',
			'agent:sdlc',
			'--',
			'resume',
			'--run',
			fixture.runId,
			'--response-file',
			'{response-file}',
			'--json',
		]);
		const statusPath = path.join(REPOSITORY_ROOT, 'docs/specs/runs', fixture.runId, 'status.json');
		const published = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
		assert.equal(status.result.runtimeRevision, published.orchestration.runtimeRevision);
		assert.equal(canonicalJson(published.continuation), canonicalJson(status.result.continuation));
		assert.equal(canonicalJson(published.hostInvocation), canonicalJson(status.result.hostInvocation));
		const replay = await runCli(['status', '--run', fixture.runId, '--json'], {
			rootDir: REPOSITORY_ROOT,
		});
		assert.equal(replay.exitCode, 2);
		assert.equal(canonicalJson(replay.result.continuation), canonicalJson(status.result.continuation));
		assert.equal(
			canonicalJson(replay.result.hostInvocation),
			canonicalJson(status.result.hostInvocation),
		);
	} finally {
		fixture.store.close();
		cleanupRun(fixture.runId);
	}
});

test('@ac AC-01 @ac AC-10 SPEC_APPROVED without an envelope exits 2 on a consumed authorize card', async () => {
	const fixture = await createSeedRun({
		label: 'authorize-card',
		stateName: 'SPEC_APPROVED',
	});
	try {
		const status = await runCli(['status', '--run', fixture.runId, '--json'], {
			rootDir: REPOSITORY_ROOT,
		});
		assert.equal(status.exitCode, 2, JSON.stringify(status.result.error ?? status.result.state));
		assert.equal(status.result.ok, true);
		assert.deepEqual(status.result.continuation, {
			action: 'authorize',
			reason: 'AUTHORIZATION_REQUIRED',
		});
		assert.equal(status.result.hostInvocation.executable, true);
		assert.equal(status.result.hostInvocation.packetConsumed, true);
		assert.equal(status.result.hostInvocation.exitCode, 2);
		assert.deepEqual(status.result.hostInvocation.argv, [
			'pnpm',
			'run',
			'agent:sdlc',
			'--',
			'authorize',
			'--run',
			fixture.runId,
			'--json',
		]);
		const published = JSON.parse(
			fs.readFileSync(path.join(REPOSITORY_ROOT, 'docs/specs/runs', fixture.runId, 'status.json'), 'utf8'),
		);
		assert.equal(canonicalJson(published.continuation), canonicalJson(status.result.continuation));
		assert.equal(canonicalJson(published.hostInvocation), canonicalJson(status.result.hostInvocation));
	} finally {
		fixture.store.close();
		cleanupRun(fixture.runId);
	}
});
