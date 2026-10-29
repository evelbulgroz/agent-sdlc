import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from '../cli.ts';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import { FakeModelGovernor } from '../../testing/fake-model-governor.mjs';
import { citingSpecWriteAction, completeProposal, createMockExecCli, createMockGitCli, grammaticalAcceptance } from '../../testing/test-support.mjs';
import { slug, cleanupRun, writeResponse } from '../../testing/cli-test-support.mjs';

test('CLI pr command prepares PR body on READY_FOR_GIT_APPROVAL', async () => {
	const testSlug = slug('pr-ready');
	const baseCommitSha = '1'.repeat(40);
	const targetTreeSha = '2'.repeat(40);
	const gitCli = createMockGitCli({
		baseCommitSha,
		targetTreeSha,
		commitSha: null,
		stagedPath: 'tools/example.mjs',
	});
	const execCli = createMockExecCli({ baseCommitSha });
	const governor = new FakeModelGovernor([
		completeProposal({ touchedSurfaces: ['tools'] }),
		citingSpecWriteAction('tools/example.spec.mjs'),
		{ action: { kind: 'complete', summary: 'Implemented feature without commits' } },
		{ action: { kind: 'complete', summary: 'Audit confirmed' } },
		{ schemaVersion: '1.0.0', status: 'PASS', findings: [] },
	]);

	let runId;
	try {
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Build SDLC stopping at ready for approval'],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli },
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
			['answer', '--run', runId, '--interrupt', pending.interruptId, '--response-file', writeResponse(runId, 'ans-rdy', answer)],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli },
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
			['answer', '--run', runId, '--interrupt', approvalPending.interruptId, '--response-file', writeResponse(runId, 'appr-rdy', approval), '--json'],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli },
		);
		assert.equal(approved.result.state, 'SPEC_APPROVED');

		// Authorize WITHOUT local commits -> stops at READY_FOR_GIT_APPROVAL
		const authorized = await runCli(
			['authorize', '--run', runId, '--json'],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli },
		);
		assert.equal(authorized.result.state, 'READY_FOR_GIT_APPROVAL');

		// Now invoke `pr --run <runId>`
		const prResult = await runCli(['pr', '--run', runId, '--json'], {
			rootDir: REPOSITORY_ROOT,
			governor,
			gitCli,
			execCli,
		});
		assert.equal(prResult.exitCode, 0, JSON.stringify(prResult.result));
		assert.equal(prResult.result.state, 'READY_FOR_GIT_APPROVAL');
		assert.ok(prResult.result.prBody);
		assert.match(prResult.result.prBody, /## Canonical local done bar/);
		assert.match(prResult.result.prBody, /verification: RESULT status=OK/);
		assert.equal(prResult.result.pullRequest, null);
		assert.equal(prResult.result.pushed, false);

		// Human formatting test
		const prHuman = await runCli(['pr', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor,
			gitCli,
			execCli,
		});
		assert.equal(prHuman.exitCode, 0);
		assert.match(prHuman.human, /PR body prepared at tools\/\.agent-sdlc/);
	} finally {
		if (runId) cleanupRun(runId);
	}
});

test('CLI pr command with --push and --open-pr pushes and opens draft PR on DONE run', async () => {
	const testSlug = slug('pr-done-open');
	const baseCommitSha = '1'.repeat(40);
	const targetTreeSha = '2'.repeat(40);
	const commitSha = '3'.repeat(40);
	const pushedRefs = [];
	const baseGitCli = createMockGitCli({
		baseCommitSha,
		targetTreeSha,
		commitSha,
		stagedPath: 'tools/example.mjs',
	});
	const gitCli = (cmd, args = [], opts = {}) => {
		if (cmd === 'git' && args[0] === 'push') {
			const remote = args.includes('-u') ? args[2] : args[1];
			const branch = args.includes('-u') ? args[3] : args[2];
			pushedRefs.push({ remote, branch });
			return '';
		}
		return baseGitCli(cmd, args, opts);
	};
	const execCli = createMockExecCli({ baseCommitSha, commitSha });
	const ghCli = (cmd, args = [], opts = {}) => {
		if (cmd === 'gh' && args.includes('pr') && args.includes('create')) {
			return 'https://github.com/evelbulgroz/agent-sdlc/pull/101\n';
		}
		throw new Error(`Unexpected command: ${cmd}`);
	};
	const governor = new FakeModelGovernor([
		completeProposal({ touchedSurfaces: ['tools'] }),
		citingSpecWriteAction('tools/example.spec.mjs'),
		{ action: { kind: 'complete', summary: 'Implemented feature' } },
		{ action: { kind: 'complete', summary: 'Audit confirmed' } },
		{ schemaVersion: '1.0.0', status: 'PASS', findings: [] },
	]);

	let runId;
	try {
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Build SDLC slice 5A'],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli, ghCli },
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
			['answer', '--run', runId, '--interrupt', pending.interruptId, '--response-file', writeResponse(runId, 'ans-pr-open', answer)],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli, ghCli },
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
			['answer', '--run', runId, '--interrupt', approvalPending.interruptId, '--response-file', writeResponse(runId, 'appr-pr-open', approval), '--json'],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli, ghCli },
		);
		assert.equal(approved.result.state, 'SPEC_APPROVED');

		// Authorize local commits only (no push yet)
		const authorized = await runCli(
			[
				'authorize',
				'--run',
				runId,
				'--create-branch',
				'--create-local-commits',
				'--json',
			],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli, ghCli },
		);
		assert.equal(authorized.result.state, 'DONE');
		assert.equal(pushedRefs.length, 0);

		// Now invoke `pr --run <runId> --push --open-pr`
		const prResult = await runCli(
			['pr', '--run', runId, '--push', '--open-pr', '--json'],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli, ghCli },
		);
		assert.equal(prResult.exitCode, 0, JSON.stringify(prResult.result));
		assert.equal(pushedRefs.length, 1);
		assert.equal(pushedRefs[0].remote, 'origin');
		assert.ok(prResult.result.pullRequest);
		assert.equal(prResult.result.pullRequest.url, 'https://github.com/evelbulgroz/agent-sdlc/pull/101');
		assert.equal(prResult.result.pullRequest.number, 101);

		// Human formatting check
		const prHuman = await runCli(
			['pr', '--run', runId],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli, ghCli },
		);
		assert.equal(prHuman.exitCode, 0);
		assert.match(prHuman.human, /Draft pull request opened: https:\/\/github\.com\/evelbulgroz\/agent-sdlc\/pull\/101 \(#101\)/);
	} finally {
		if (runId) cleanupRun(runId);
	}
});

test('CLI pr command rejects invalid run state and missing runs', async () => {
	const testSlug = slug('pr-reject');
	const baseCommitSha = 'a'.repeat(40);
	const gitCli = (cmd, args = [], opts = {}) => {
		if (cmd === 'git' && args[0] === 'rev-parse') return `${baseCommitSha}\n`;
		return '';
	};
	const governor = new FakeModelGovernor([completeProposal()]);

	// Non-existent run
	const missing = await runCli(['pr', '--run', '2026-09-08-missing-run', '--json'], {
		rootDir: REPOSITORY_ROOT,
		governor,
		gitCli,
	});
	assert.equal(missing.exitCode, 64);
	assert.equal(missing.result.error.code, 'RUN_NOT_FOUND');

	// Malformed run ID
	const malformed = await runCli(['pr', '--run', 'invalid-format', '--json'], {
		rootDir: REPOSITORY_ROOT,
		governor,
		gitCli,
	});
	assert.equal(malformed.exitCode, 64);
	assert.equal(malformed.result.error.code, 'INVALID_CONTRACT');

	let runId;
	try {
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Test pr rejection on active state'],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli },
		);
		runId = started.result.runId;

		// Run is in WAITING_FOR_ANSWERS
		const invalidState = await runCli(['pr', '--run', runId, '--json'], {
			rootDir: REPOSITORY_ROOT,
			governor,
			gitCli,
		});
		assert.equal(invalidState.exitCode, 64);
		assert.equal(invalidState.result.error.code, 'INVALID_TRANSITION');
	} finally {
		if (runId) cleanupRun(runId);
	}
});
