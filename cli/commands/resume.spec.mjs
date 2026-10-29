import '../../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
import { SdlcError } from '../../policy/errors.ts';
import { FakeModelGovernor } from '../../testing/fake-model-governor.mjs';
import { completeProposal, createMockExecCli, createMockGitCli, grammaticalAcceptance } from '../../testing/test-support.mjs';
import { slug, cleanupRun, checkpointState, writeResponse } from '../../testing/cli-test-support.mjs';

test('CLI can resume a governor-blocked run when a route later becomes available', async () => {
	const testSlug = slug('blocked-resume');
	let runId;
	try {
		const blocked = await runCli(
			['start', '--slug', testSlug, '--goal', 'Resume after governor recovery'],
			{
				rootDir: REPOSITORY_ROOT,
				governor: new FakeModelGovernor([
					Object.assign(new Error('route unavailable'), {
						name: 'SdlcError',
						code: 'GOVERNOR_ROUTES_EXHAUSTED',
					}),
				]),
			},
		);
		runId = blocked.result.runId;
		assert.equal(blocked.result.state, 'BLOCKED');
		const resumed = await runCli(['resume', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor: new FakeModelGovernor([completeProposal()]),
		});
		assert.equal(resumed.exitCode, 2);
		assert.equal(resumed.result.state, 'WAITING_FOR_ANSWERS');
	} finally {
		if (runId) cleanupRun(runId);
	}
});

test('CLI resume on SPEC_APPROVED advances to WAITING_FOR_AUTHORIZATION with authorization interrupt', async () => {
	const testSlug = slug('resume-spec-approved');
	const baseCommitSha = 'a'.repeat(40);
	const gitCli = (cmd, args = [], opts = {}) => {
		if (cmd === 'git' && args[0] === 'rev-parse') return `${baseCommitSha}\n`;
		return '';
	};
	const governor = new FakeModelGovernor([completeProposal()]);

	let runId;
	try {
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Test resume from approved'],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli },
		);
		runId = started.result.runId;

		const pending = started.result.pendingInterrupt;
		const answer = {
			schemaVersion: '1.0.0',
			interruptId: pending.interruptId,
			stateHash: pending.request.stateHash,
			answers: [
				{ questionId: 'acceptance', value: grammaticalAcceptance('Approved spec exists') },
				{ questionId: 'failure', value: 'Stale responses fail' },
				{ questionId: 'verification', value: 'Targeted tests pass' },
			],
		};
		const answered = await runCli(
			['answer', '--run', runId, '--interrupt', pending.interruptId, '--response-file', writeResponse(runId, 'ans', answer)],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli },
		);

		const approvalPending = answered.result.pendingInterrupt;
		const approval = {
			schemaVersion: '1.0.0',
			interruptId: approvalPending.interruptId,
			stateHash: approvalPending.request.stateHash,
			action: 'approve',
			approvalHash: approvalPending.request.approval.approvalHash,
			draftHash: approvalPending.request.draftHash,
			changes: [],
		};
		const approved = await runCli(
			['answer', '--run', runId, '--interrupt', approvalPending.interruptId, '--response-file', writeResponse(runId, 'appr', approval)],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli },
		);
		assert.equal(approved.result.state, 'SPEC_APPROVED');
		assert.equal(approved.result.pendingInterrupt, null);

		// Resume on SPEC_APPROVED without --hitl-tty advances to WAITING_FOR_AUTHORIZATION
		const resumed = await runCli(['resume', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor,
			gitCli,
		});
		assert.equal(resumed.exitCode, 2);
		assert.equal(resumed.result.state, 'WAITING_FOR_AUTHORIZATION');
		assert.ok(resumed.result.pendingInterrupt);
		assert.equal(resumed.result.pendingInterrupt.kind, 'authorization');
	} finally {
		if (runId) cleanupRun(runId);
	}
});

test('CLI resume on ESCALATED run enforces containment, protects oracles, and records candidate learnings', async () => {
	const testSlug = slug('resume-escalated');
	const runId = `${new Date().toISOString().slice(0, 10)}-${testSlug}`;
	fs.mkdirSync(path.join(REPOSITORY_ROOT, 'docs/specs/runs', runId), { recursive: true });
	createRuntimeDirectory(runId, REPOSITORY_ROOT);
	const paths = resolveRunPaths(runId, REPOSITORY_ROOT);
	const worktreeDir = path.join(paths.runtimeDir, 'worktree');
	const baseCommitSha = '1'.repeat(40);
	const targetTreeSha = '2'.repeat(40);
	const oracleRelPath = 'services/billing/test.oracle.spec.ts';
	const oracleContent = '// oracle test spec\n';
	const oracleHash = crypto.createHash('sha256').update(oracleContent, 'utf8').digest('hex');

	const repoLearningsPath = path.join(REPOSITORY_ROOT, '.learnings.jsonl');
	const originalLearnings = fs.existsSync(repoLearningsPath)
		? fs.readFileSync(repoLearningsPath, 'utf8')
		: null;

	let store;
	try {
		fs.mkdirSync(paths.artifactsDir, { recursive: true });
		fs.mkdirSync(path.join(worktreeDir, 'services/billing'), { recursive: true });
		fs.writeFileSync(path.join(worktreeDir, oracleRelPath), oracleContent);

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
		const initial = runtime.initialize({ runId, goal: 'Test resume escalated' });
		const escalatedState = {
			...initial,
			state: 'ESCALATED',
			runtimeRevision: initial.runtimeRevision + 1,
			worktreePath: worktreeDir,
			semanticRepairsCount: 2,
			blockedReason: 'REPAIR_BUDGET_EXHAUSTED',
			updatedAt: new Date().toISOString(),
		};
		store.saveTransition(
			initial.runtimeRevision,
			escalatedState,
			createEvent({
				eventType: 'RUN_BLOCKED',
				runId,
				runtimeRevision: escalatedState.runtimeRevision,
				state: escalatedState,
				input: initial,
				output: { reason: 'TEST_ESCALATION' },
				causalId: `${runId}:test-escalate`,
				payload: { reason: 'TEST_ESCALATION' },
			}),
		);
		await checkpointState(runtime, escalatedState);

		store.saveAuthorization({
			schemaVersion: '1.0.0',
			runId,
			approvedSpecHash: 'b'.repeat(64),
			approvedPlanPolicyHash: 'c'.repeat(64),
			repositoryId: 'agent-sdlc',
			baseCommitSha,
			allowedPackages: ['services/billing'],
			allowedPathPrefixes: ['services/billing/'],
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

		store.saveGeneration({
			schemaVersion: '1.0.0',
			runId,
			generation: 0,
			baseCommitSha,
			targetTreeSha,
			scopeFingerprints: { 'services/billing/': 'd'.repeat(64) },
			taskOwnedPaths: ['services/billing/**'],
			materializedAt: new Date().toISOString(),
			oracleSnapshot: [{ path: oracleRelPath, sha256: oracleHash }],
		});
		store.close();
		store = null;

		const mockGit = createMockGitCli({
			baseCommitSha,
			targetTreeSha,
		});
		const mockExec = createMockExecCli({ baseCommitSha });

		const testGovernor = new FakeModelGovernor([
			{ schemaVersion: '1.0.0', status: 'PASS', findings: [] },
		]);

		// 1. Violation A: Containment Violation
		const leakDir = path.join(worktreeDir, 'packages/shared-base/src');
		fs.mkdirSync(leakDir, { recursive: true });
		fs.writeFileSync(path.join(leakDir, 'leak.ts'), '// uncontained file');

		const leakResult = await runCli(['resume', '--run', runId, '--retry', '--json'], {
			rootDir: REPOSITORY_ROOT,
			governor: testGovernor,
			gitCli: mockGit,
			execCli: mockExec,
		});
		assert.equal(leakResult.exitCode, 64, JSON.stringify(leakResult.result));
		assert.equal(leakResult.result.error.code, 'SDLC_CONTAINMENT_VIOLATION');

		fs.rmSync(path.join(worktreeDir, 'packages'), { recursive: true, force: true });

		// 2. Violation B: Oracle Invariant
		fs.writeFileSync(path.join(worktreeDir, oracleRelPath), '// altered oracle content');

		const oracleResult = await runCli(['resume', '--run', runId, '--retry', '--json'], {
			rootDir: REPOSITORY_ROOT,
			governor: testGovernor,
			gitCli: mockGit,
			execCli: mockExec,
		});
		assert.equal(oracleResult.exitCode, 64, JSON.stringify(oracleResult.result));
		assert.equal(oracleResult.result.error.code, 'ORACLE_PATH_MODIFICATION_PROHIBITED');

		fs.writeFileSync(path.join(worktreeDir, oracleRelPath), oracleContent);

		// Legitimate human edit
		fs.writeFileSync(
			path.join(worktreeDir, 'services/billing/fix.ts'),
			'export const fixed = true;',
		);

		// 3. Crash after the atomic SQLite transition, before generation materialization.
		const resumeArgs = [
			'resume',
			'--run',
			runId,
			'--retry',
			'--learning-insight',
			'Explicit queryRunner release prevents connection pool exhaustion in billing',
			'--learning-scope',
			'billing',
			'--json',
		];
		const interruptedResult = await runCli(
			resumeArgs,
			{
				rootDir: REPOSITORY_ROOT,
				governor: testGovernor,
				gitCli: mockGit,
				execCli: mockExec,
				onBoundary: async (name) => {
					if (name === 'resume-transition-recorded') {
						throw new Error('simulated crash after resume transition');
					}
				},
			},
		);
		assert.equal(interruptedResult.exitCode, 70);
		const interruptedStore = new RuntimeStore(paths.databasePath);
		try {
			assert.equal(interruptedStore.getRun(runId).state, 'SNAPSHOT_GENERATION');
			assert.equal(interruptedStore.getGeneration(runId, 1), null);
			assert.equal(interruptedStore.listCandidateLearnings(runId).length, 1);
		} finally {
			interruptedStore.close();
		}

		// 4. Retry re-enters snapshot_generation without duplicating the post-mortem.
		const successResult = await runCli(
			[
				'resume',
				'--run',
				runId,
				'--json',
			],
			{
				rootDir: REPOSITORY_ROOT,
				governor: testGovernor,
				gitCli: mockGit,
				execCli: mockExec,
			},
		);
		assert.equal(successResult.result.ok, true, JSON.stringify(successResult.result));

		const checkStore = new RuntimeStore(paths.databasePath);
		try {
			const gen0 = checkStore.getGeneration(runId, 0);
			assert.ok(gen0, 'generation 0 must be preserved');
			const latestGen = checkStore.getLatestGeneration(runId);
			assert.equal(latestGen.generation, 1, 'generation must be incremented to 1');

			const candidates = checkStore.listCandidateLearnings(runId);
			assert.equal(candidates.length, 1);
			assert.equal(candidates[0].sourceRole, 'operator');
			assert.equal(candidates[0].confidence, 9);
			assert.equal(candidates[0].generation, 1);
			assert.match(candidates[0].key, /^billing-/);

			const pendingOutbox = checkStore.listPendingLearningOutbox(runId);
			assert.equal(pendingOutbox.length, 0);

			const events = checkStore.listEvents(runId);
			const resumeEvt = events.find((e) => e.eventType === 'RESUME_FROM_ESCALATION');
			assert.ok(resumeEvt, 'RESUME_FROM_ESCALATION event must be recorded');
			assert.equal(resumeEvt.payload.previousGeneration, 0);
			assert.equal(resumeEvt.payload.resumedGeneration, 1);
			assert.equal(resumeEvt.payload.postMortemCaptured, true);
		} finally {
			checkStore.close();
		}
	} finally {
		if (store) store.close();
		cleanupRun(runId);
		if (originalLearnings !== null) {
			fs.writeFileSync(repoLearningsPath, originalLearnings, 'utf8');
		} else if (fs.existsSync(repoLearningsPath)) {
			fs.unlinkSync(repoLearningsPath);
		}
	}
});
