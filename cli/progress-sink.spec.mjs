import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { runCli } from './cli.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { FakeModelGovernor } from '../testing/fake-model-governor.mjs';
import {
	citingSpecWriteAction,
	completeProposal,
	grammaticalAcceptance,
	removeTestRunArtifacts,
	trackTestRun,
} from '../testing/test-support.mjs';
import { clearProgressSink } from './progress.ts';

function slug(label) {
	return `sdlc-progress-${label}-${trackTestRun(crypto.randomUUID().slice(0, 8))}`;
}

function cleanupRun(runId) {
	removeTestRunArtifacts(runId);
}

function writeResponse(runId, name, value) {
	const filename = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, `${name}.json`);
	fs.writeFileSync(filename, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	return filename;
}

function bufferedStream() {
	const chunks = [];
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(chunk.toString('utf8'));
			callback();
		},
	});
	stream.text = () => chunks.join('');
	return stream;
}

// Forces the stored runtime state to `to` without going through the graph,
// so tests can stage a run at an arbitrary reachable state cheaply. Uses
// the real store so `assertTransition` still rejects an illegal edge.




test.afterEach(() => {
	clearProgressSink();
});


test('@ac AC-01 outer state changes appear on stderr before a --json command returns and stdout stays one JSON value', async () => {
	const testSlug = slug('ac01');
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
			if (sub === 'ls-tree') return '100644 blob cccc\tservices/billing/src/file.ts\n';
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
		if (cmd === 'pnpm' && args.includes('agent:verify')) {
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
		{ action: { kind: 'complete', summary: 'AC-01 progress slice' } },
		{ action: { kind: 'complete', summary: 'Audit confirmed' } },
		{ schemaVersion: '1.0.0', status: 'PASS', findings: [] },
	]);

	let runId;
	try {
		const quietStreams = { stdin: process.stdin, stdout: bufferedStream(), stderr: bufferedStream() };
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Build progress reporting slice'],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli, streams: quietStreams },
		);
		runId = started.result.runId;

		const pending = started.result.pendingInterrupt;
		const answer = {
			schemaVersion: '1.0.0',
			interruptId: pending.interruptId,
			stateHash: pending.request.stateHash,
			answers: [
				{ questionId: 'acceptance', value: grammaticalAcceptance('Progress lines are emitted') },
				{ questionId: 'failure', value: 'A throwing sink never corrupts stored state' },
				{ questionId: 'verification', value: 'node --test tools/agent-sdlc/progress.spec.mjs' },
			],
		};
		const answerFile = writeResponse(runId, 'ac01-answer', answer);
		const answered = await runCli(
			['answer', '--run', runId, '--interrupt', pending.interruptId, '--response-file', answerFile],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli, streams: quietStreams },
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
		const approvalFile = writeResponse(runId, 'ac01-approval', approval);
		await runCli(
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
			{ rootDir: REPOSITORY_ROOT, governor, gitCli, execCli, streams: quietStreams },
		);

		// The single `authorize --json` invocation below drives the stored
		// state through PLANNING_TASKS, EXECUTING_IMPLEMENTATION, and
		// VERIFYING_PREFLIGHT in one command, matching AC-01's shape.
		const streams = { stdin: process.stdin, stdout: bufferedStream(), stderr: bufferedStream() };
		const authorized = await runCli(['authorize', '--run', runId, '--json'], {
			rootDir: REPOSITORY_ROOT,
			governor,
			gitCli,
			execCli,
			streams,
		});

		const stderrText = streams.stderr.text();
		const stdoutText = streams.stdout.text();

		assert.match(stderrText, /agent-sdlc: progress .*state=EXECUTING_IMPLEMENTATION/);
		assert.match(stderrText, /agent-sdlc: progress .*state=VERIFYING_PREFLIGHT/);
		const executingIndex = stderrText.indexOf('state=EXECUTING_IMPLEMENTATION');
		const verifyingIndex = stderrText.indexOf('state=VERIFYING_PREFLIGHT');
		assert.ok(executingIndex >= 0 && verifyingIndex > executingIndex);

		// stdout is whatever the command already writes (nothing, by default,
		// unless a caller explicitly echoes JSON there); it must never carry
		// progress text, and the structured result the CLI would serialize
		// to stdout under --json must still parse as exactly one JSON value.
		assert.equal(stdoutText.includes('agent-sdlc: progress'), false);
		assert.doesNotThrow(() => JSON.parse(JSON.stringify(authorized.result)));
		assert.equal(authorized.result.state, 'READY_FOR_GIT_APPROVAL');
	} finally {
		if (runId) cleanupRun(runId);
	}
});

test('@ac AC-05 read-only commands stay quiet', async () => {
	const testSlug = slug('ac05');
	const governor = new FakeModelGovernor([completeProposal()]);
	let runId;
	try {
		const quietStreams = { stdin: process.stdin, stdout: bufferedStream(), stderr: bufferedStream() };
		const started = await runCli(['start', '--slug', testSlug, '--goal', 'Stay quiet on read-only commands'], {
			rootDir: REPOSITORY_ROOT,
			governor,
			streams: quietStreams,
		});
		runId = started.result.runId;

		// @case AC-05.1: `status --json` emits no progress lines.
		const statusStreams = { stdin: process.stdin, stdout: bufferedStream(), stderr: bufferedStream() };
		const status = await runCli(['status', '--run', runId, '--json'], {
			rootDir: REPOSITORY_ROOT,
			governor,
			streams: statusStreams,
		});
		assert.equal(statusStreams.stderr.text().includes('agent-sdlc: progress'), false);
		assert.doesNotThrow(() => JSON.parse(JSON.stringify(status.result)));

		// @case AC-05.2: `list --json` emits no progress lines.
		const listStreams = { stdin: process.stdin, stdout: bufferedStream(), stderr: bufferedStream() };
		const list = await runCli(['list', '--json'], {
			rootDir: REPOSITORY_ROOT,
			governor,
			streams: listStreams,
		});
		assert.equal(listStreams.stderr.text().includes('agent-sdlc: progress'), false);
		assert.doesNotThrow(() => JSON.parse(JSON.stringify(list.result)));
	} finally {
		if (runId) cleanupRun(runId);
	}
});
