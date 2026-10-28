import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../cli.ts';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import { FakeModelGovernor } from '../../testing/fake-model-governor.mjs';
import { citingSpecWriteAction, completeProposal, createMockExecCli, createMockGitCli, grammaticalAcceptance } from '../../testing/test-support.mjs';
import { slug, cleanupRun, writeResponse } from '../../testing/cli-test-support.mjs';

test('CLI authorize command, status projection of worktree, and READY_FOR_GIT_APPROVAL presentation', async () => {
	const testSlug = slug('authorize-lifecycle');
	const baseCommitSha = '1'.repeat(40);
	const targetTreeSha = '2'.repeat(40);

	const gitCli = (cmd, args = [], opts = {}) => {
		if (cmd === 'git') {
			const sub = args[0];
			if (sub === 'rev-parse' && args[1] === 'HEAD') return `${baseCommitSha}\n`;
			if (sub === 'worktree' && args[1] === 'add') {
				const targetDir = args[3] || args[2];
				fs.mkdirSync(targetDir, { recursive: true });
				return '';
			}
			if (sub === 'write-tree') return `${targetTreeSha}\n`;
			if (sub === 'ls-tree') return '100644 blob cccc\tapps/services/conditioning/src/file.ts\n';
			if (sub === 'diff' && args.includes('--name-only')) {
				const names = [];
				const cwd = opts.cwd;
				if (cwd && fs.existsSync(cwd)) {
					const stack = [cwd];
					while (stack.length > 0) {
						const current = stack.pop();
						let entries = [];
						try {
							entries = fs.readdirSync(current, { withFileTypes: true });
						} catch {
							continue;
						}
						for (const entry of entries) {
							if (entry.name === 'node_modules' || entry.name === '.git') continue;
							const full = path.join(current, entry.name);
							if (entry.isDirectory()) stack.push(full);
							else if (/\.(spec|test|e2e-spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
								names.push(path.relative(cwd, full).split(path.sep).join('/'));
							}
						}
					}
				}
				return names.length > 0 ? `${names.join('\n')}\n` : '';
			}
			if (sub === 'diff') return '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n+implemented\n';
		}
		return '';
	};

	const execCli = (cmd, args = [], opts = {}) => {
		if (cmd === 'pnpm' && args.includes('agent:preflight')) {
			const preflightDir = path.join(opts.cwd || REPOSITORY_ROOT, 'tools');
			fs.mkdirSync(preflightDir, { recursive: true });
			fs.writeFileSync(
				path.join(preflightDir, '.agent-preflight-last.json'),
				JSON.stringify({
					status: 'OK',
					canonical: true,
					base: baseCommitSha,
					gitHeadSha: baseCommitSha,
					changeClass: 'A',
					exitCode: 0,
				}),
			);
			return `agent-preflight: RESULT status=OK class=A sha=${baseCommitSha} exitCode=0 canonical=true\n`;
		}
		return 'OK\n';
	};

	const governor = new FakeModelGovernor([
		completeProposal({ touchedSurfaces: ['tools'] }),
		citingSpecWriteAction('tools/example.spec.mjs'),
		{
			action: {
				kind: 'complete',
				summary: 'Implemented slice 2',
			},
		},
		{ action: { kind: 'complete', summary: 'Audit confirmed' } },
		// reviewer role findings:
		{ schemaVersion: '1.0.0', status: 'PASS', findings: [] },
	]);

	let runId;
	try {
		// 1. Start run
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Build authorized SDLC slice 2'],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli },
		);
		assert.equal(started.exitCode, 2);
		runId = started.result.runId;

		// 2. Authorize before approval fails with exit code 64 (INVALID_TRANSITION)
		const prematureAuth = await runCli(
			['authorize', '--run', runId, '--interactive'],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli },
		);
		assert.equal(prematureAuth.exitCode, 64);
		assert.equal(prematureAuth.result.error.code, 'INVALID_TRANSITION');

		// 3. Answer questions to reach approval
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
		const answerFile = writeResponse(runId, 'auth-test-answer', answer);
		const answered = await runCli(
			['answer', '--run', runId, '--interrupt', pending.interruptId, '--response-file', answerFile],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli },
		);
		assert.equal(answered.exitCode, 2);
		assert.equal(answered.result.state, 'WAITING_FOR_APPROVAL');

		// 4. Approve draft
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
		const approvalFile = writeResponse(runId, 'auth-test-approval', approval);
		const approved = await runCli(
			[
				'answer',
				'--run',
				runId,
				'--interrupt',
				approvalPending.interruptId,
				'--response-file',
				approvalFile,
				'--json',
			],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli },
		);
		assert.equal(approved.exitCode, 2);
		assert.equal(approved.result.state, 'SPEC_APPROVED');

		// 5. Authorize run (interactive flag is optional; defaults halt at READY_FOR_GIT_APPROVAL)
		const authorized = await runCli(
			['authorize', '--run', runId, '--interactive', '--json'],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli },
		);
		assert.equal(authorized.exitCode, 0);
		assert.equal(authorized.result.state, 'READY_FOR_GIT_APPROVAL');
		assert.equal(authorized.result.baseCommitSha, baseCommitSha);
		assert.equal(authorized.result.targetTreeSha, targetTreeSha);
		assert.equal(authorized.result.activeGeneration, 0);
		assert.equal(authorized.result.semanticRepairsCount, 0);

		// 6. Check human status output for READY_FOR_GIT_APPROVAL
		const statusHuman = await runCli(['status', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor,
			gitCli,
			execCli,
		});
		assert.equal(statusHuman.exitCode, 0);
		assert.match(statusHuman.human, /READY_FOR_GIT_APPROVAL/);
		assert.match(statusHuman.human, /Outcome:\s+Preflight PASSED/);
		assert.match(statusHuman.human, /Action Required: Local Git operations are not authorized/);
		assert.match(statusHuman.human, /git diff origin\/main/);

		// 7. Authorizing again on terminal READY_FOR_GIT_APPROVAL fails with exit code 64
		const reAuth = await runCli(
			['authorize', '--run', runId, '--interactive'],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli },
		);
		assert.equal(reAuth.exitCode, 64);
		assert.equal(reAuth.result.error.code, 'INVALID_TRANSITION');
	} finally {
		if (runId) cleanupRun(runId);
	}
});

test('CLI authorize with local commit flags reaches DONE', async () => {
	const testSlug = slug('authorize-done');
	const baseCommitSha = '1'.repeat(40);
	const targetTreeSha = '2'.repeat(40);
	const commitSha = '3'.repeat(40);
	const gitCli = createMockGitCli({
		baseCommitSha,
		targetTreeSha,
		commitSha,
		stagedPath: 'tools/example.mjs',
	});
	const execCli = createMockExecCli({ baseCommitSha, commitSha });
	const governor = new FakeModelGovernor([
		completeProposal({ touchedSurfaces: ['tools'] }),
		citingSpecWriteAction('tools/example.spec.mjs'),
		{ action: { kind: 'complete', summary: 'Implemented slice 3' } },
		{ action: { kind: 'complete', summary: 'Audit confirmed' } },
		{ schemaVersion: '1.0.0', status: 'PASS', findings: [] },
	]);

	let runId;
	try {
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Build authorized SDLC slice 3 commits'],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli },
		);
		assert.equal(started.exitCode, 2);
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
		const answerFile = writeResponse(runId, 'done-answer', answer);
		const answered = await runCli(
			['answer', '--run', runId, '--interrupt', pending.interruptId, '--response-file', answerFile],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli },
		);
		assert.equal(answered.result.state, 'WAITING_FOR_APPROVAL');

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
		const approvalFile = writeResponse(runId, 'done-approval', approval);
		const approved = await runCli(
			[
				'answer',
				'--run',
				runId,
				'--interrupt',
				approvalPending.interruptId,
				'--response-file',
				approvalFile,
				'--json',
			],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli },
		);
		assert.equal(approved.result.state, 'SPEC_APPROVED');

		const authorized = await runCli(
			[
				'authorize',
				'--run',
				runId,
				'--create-branch',
				'--create-local-commits',
				'--json',
			],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli },
		);
		assert.equal(
			authorized.exitCode,
			0,
			authorized.result.error
				? `${authorized.result.error.code}: ${authorized.result.error.message}`
				: JSON.stringify(authorized.result),
		);
		assert.equal(authorized.result.state, 'DONE');
		assert.equal(authorized.result.commitSha, commitSha);

		const statusHuman = await runCli(['status', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor,
			gitCli,
			execCli,
		});
		assert.equal(statusHuman.exitCode, 0);
		assert.match(statusHuman.human, /DONE/);
		assert.match(statusHuman.human, /committed tree/);
	} finally {
		if (runId) cleanupRun(runId);
	}
});

test('CLI authorize with --push and --open-pr reaches DONE, pushes branch, and opens draft PR', async () => {
	const testSlug = slug('authorize-pr');
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
	const ghCliCalls = [];
	const ghCli = (cmd, args = [], opts = {}) => {
		ghCliCalls.push({ cmd, args, opts });
		if (cmd === 'gh' && args.includes('pr') && args.includes('create')) {
			return 'https://github.com/evelbulgroz/fitness-app/pull/99\n';
		}
		throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
	};
	const governor = new FakeModelGovernor([
		completeProposal({ touchedSurfaces: ['tools'] }),
		citingSpecWriteAction('tools/example.spec.mjs'),
		{ action: { kind: 'complete', summary: 'Implemented slice 5A feature' } },
		{ action: { kind: 'complete', summary: 'Audit confirmed' } },
		{ schemaVersion: '1.0.0', status: 'PASS', findings: [] },
	]);

	let runId;
	try {
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Build authorized SDLC with PR'],
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
			['answer', '--run', runId, '--interrupt', pending.interruptId, '--response-file', writeResponse(runId, 'ans-pr', answer)],
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
			['answer', '--run', runId, '--interrupt', approvalPending.interruptId, '--response-file', writeResponse(runId, 'appr-pr', approval), '--json'],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli, ghCli },
		);
		assert.equal(approved.result.state, 'SPEC_APPROVED');

		const authorized = await runCli(
			[
				'authorize',
				'--run',
				runId,
				'--create-branch',
				'--create-local-commits',
				'--push',
				'--open-pr',
				'--json',
			],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli, ghCli },
		);
		assert.equal(authorized.exitCode, 0, JSON.stringify(authorized.result));
		assert.equal(authorized.result.state, 'DONE');
		assert.equal(authorized.result.commitSha, commitSha);
		assert.equal(pushedRefs.length, 1);
		assert.equal(pushedRefs[0].remote, 'origin');
		assert.equal(pushedRefs[0].branch, authorized.result.branch);
		assert.ok(authorized.result.pullRequest);
		assert.equal(authorized.result.pullRequest.url, 'https://github.com/evelbulgroz/fitness-app/pull/99');
		assert.equal(authorized.result.pullRequest.number, 99);
		assert.equal(authorized.result.pullRequest.draft, true);

		// Verify pr-body.md exists in artifacts
		const prBodyPath = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'artifacts/pr-body.md');
		assert.ok(fs.existsSync(prBodyPath));
		const prBodyContent = fs.readFileSync(prBodyPath, 'utf8');
		assert.match(prBodyContent, /## Canonical local done bar/);
		assert.match(prBodyContent, /agent-preflight: RESULT status=OK/);

		// Verify human status output formatting
		const statusHuman = await runCli(['status', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor,
			gitCli,
			execCli,
			ghCli,
		});
		assert.equal(statusHuman.exitCode, 0);
		assert.match(statusHuman.human, /DONE/);
		assert.match(statusHuman.human, /Pull Request:\s+https:\/\/github\.com\/evelbulgroz\/fitness-app\/pull\/99 \(#99\) \[draft\]/);
	} finally {
		if (runId) cleanupRun(runId);
	}
});
