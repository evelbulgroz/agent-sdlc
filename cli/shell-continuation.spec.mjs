import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { humanResult } from './human-result.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { SdlcError } from '../policy/errors.ts';
import { shellStatus, shellReply, shellWatch } from './shell-driver.ts';
import { makeTempDir, SILENT_STREAMS } from '../testing/shell-driver-support.mjs';

test('@ac AC-05: Mechanical continuation does not ask the operator', async () => {
	const statuses = [
		{
			ok: true,
			command: 'status',
			runId: 'r1',
			continuation: { action: 'resume', reason: 'INFRASTRUCTURE_CONTINUATION' },
			hostInvocation: {
				executable: true,
				argv: ['pnpm', 'run', 'agent:sdlc', '--', 'resume', '--run', 'r1', '--json'],
				retry: { allowed: false, maxAdditionalInvocations: 0 },
			},
		},
		{
			ok: true,
			command: 'status',
			runId: 'r1',
			continuation: { action: 'stop', reason: 'GIT_APPROVAL' },
			hostInvocation: { executable: false, argv: null, retry: { allowed: false, maxAdditionalInvocations: 0 } },
		},
	];
	let statusCallIndex = 0;
	const calls = [];
	async function fakeRunCliFn(args) {
		calls.push(args.slice());
		if (args[0] === 'status') {
			const result = statuses[Math.min(statusCallIndex, statuses.length - 1)];
			statusCallIndex += 1;
			return { exitCode: 0, result, human: '' };
		}
		if (args[0] === 'resume') {
			assert.ok(!args.includes('--retry'), 'shell watch must never append --retry');
			return {
				exitCode: 0,
				result: { ok: true, command: 'resume', runId: 'r1', state: 'EXECUTING_IMPLEMENTATION' },
				human: '',
			};
		}
		throw new Error(`unexpected engine command in test stub: ${args[0]}`);
	}

	const final = await shellWatch({
		runId: 'r1',
		rootDir: REPOSITORY_ROOT,
		streams: SILENT_STREAMS,
		runCliFn: fakeRunCliFn,
	});

	assert.equal(final.continuation.action, 'stop');
	assert.equal(final.continuation.reason, 'GIT_APPROVAL');
	// status, resume, status -- then stop, with no further engine call.
	assert.deepEqual(
		calls.map((c) => c[0]),
		['status', 'resume', 'status'],
	);
});

test('@ac AC-06: Elevation replies outside the published slots do not reach the engine', async (t) => {
	const card = {
		executable: true,
		argv: ['pnpm', 'run', 'agent:sdlc', '--', 'resume', '--run', 'r2', '--response-file', '{response-file}', '--json'],
		retry: { allowed: false, maxAdditionalInvocations: 0 },
		responseDocument: { schemaVersion: '1.0.0', interruptId: 'int-1', stateHash: 'abc', answers: null },
		responseSlots: [{ questionId: 'q-1', responseKind: 'text', options: [], required: true }],
	};

	await t.test('@case AC-06.1: a missing slot is rejected', async () => {
		const dir = makeTempDir('ac06-1');
		const responseFile = path.join(dir, 'reply.json');
		fs.writeFileSync(responseFile, JSON.stringify({ answers: [] }));
		let engineInvoked = false;
		async function fakeRunCliFn(args) {
			if (args[0] === 'status') {
				return {
					exitCode: 2,
					result: { ok: true, command: 'status', runId: 'r2', hostInvocation: card },
					human: '',
				};
			}
			engineInvoked = true;
			return { exitCode: 0, result: { ok: true, command: args[0] }, human: '' };
		}

		await assert.rejects(
			shellReply({
				runId: 'r2',
				responseFile,
				rootDir: REPOSITORY_ROOT,
				streams: SILENT_STREAMS,
				runCliFn: fakeRunCliFn,
			}),
			(error) => error instanceof SdlcError && error.code === 'INVALID_INPUT',
		);
		assert.equal(engineInvoked, false);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	await t.test('@case AC-06.2: a filled slot is submitted once', async () => {
		const dir = makeTempDir('ac06-2');
		const responseFile = path.join(dir, 'reply.json');
		fs.writeFileSync(responseFile, JSON.stringify({ answers: [{ questionId: 'q-1', value: 'yes' }] }));
		let resumeCallCount = 0;
		let submittedResponseFile = null;
		async function fakeRunCliFn(args) {
			if (args[0] === 'status') {
				return {
					exitCode: 2,
					result: { ok: true, command: 'status', runId: 'r2', hostInvocation: card },
					human: '',
				};
			}
			if (args[0] === 'resume') {
				resumeCallCount += 1;
				const idx = args.indexOf('--response-file');
				submittedResponseFile = args[idx + 1];
				return { exitCode: 0, result: { ok: true, command: 'resume', state: 'DONE' }, human: '' };
			}
			throw new Error(`unexpected engine command in test stub: ${args[0]}`);
		}

		const runId = `r2-${crypto.randomUUID().slice(0, 8)}`;
		await shellReply({
			runId,
			responseFile,
			rootDir: REPOSITORY_ROOT,
			streams: SILENT_STREAMS,
			runCliFn: fakeRunCliFn,
		});

		assert.equal(resumeCallCount, 1);
		assert.ok(submittedResponseFile && fs.existsSync(submittedResponseFile));
		const submitted = JSON.parse(fs.readFileSync(submittedResponseFile, 'utf8'));
		assert.deepEqual(submitted.answers, [{ questionId: 'q-1', value: 'yes' }]);
		fs.rmSync(path.dirname(path.dirname(submittedResponseFile)), { recursive: true, force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

test('@ac AC-07: Git approval stops in front of the operator', async () => {
	const worktreePath = '/tmp/fake-worktree-for-ac07';
	const statusResult = {
		ok: true,
		command: 'status',
		runId: 'r3',
		worktreePath,
		blockedReason: null,
		continuation: { action: 'stop', reason: 'GIT_APPROVAL' },
		hostInvocation: { executable: false, argv: null, retry: { allowed: false, maxAdditionalInvocations: 0 } },
	};
	async function fakeRunCliFn(args) {
		assert.equal(args[0], 'status', 'shell status/watch must not invoke anything but status for a stop card');
		return { exitCode: 0, result: statusResult, human: '' };
	}

	const status = await shellStatus({
		runId: 'r3',
		rootDir: REPOSITORY_ROOT,
		streams: SILENT_STREAMS,
		runCliFn: fakeRunCliFn,
	});
	const human = humanResult('shell status', status);
	assert.match(human, new RegExp(worktreePath.replace(/\//g, '\\/')));
	assert.match(human, /GIT_APPROVAL/);

	const watched = await shellWatch({
		runId: 'r3',
		rootDir: REPOSITORY_ROOT,
		streams: SILENT_STREAMS,
		runCliFn: fakeRunCliFn,
	});
	assert.equal(watched.continuation.reason, 'GIT_APPROVAL');
});

test('shell watch elevates HALTED to stderr with terminal bell', async () => {
	const statusResult = {
		ok: true,
		command: 'status',
		runId: 'r-halted',
		blockedReason: 'repeated-failed-reads',
		continuation: { action: 'stop', reason: 'HALTED' },
		hostInvocation: { executable: false, argv: null, retry: { allowed: true } },
	};
	async function fakeRunCliFn() {
		return { exitCode: 3, result: statusResult, human: '' };
	}

	let stderrOutput = '';
	const recordingStreams = {
		stdin: process.stdin,
		stdout: { write: () => {} },
		stderr: {
			write: (chunk) => {
				stderrOutput += chunk;
			},
		},
	};

	const watched = await shellWatch({
		runId: 'r-halted',
		rootDir: REPOSITORY_ROOT,
		streams: recordingStreams,
		runCliFn: fakeRunCliFn,
	});

	assert.equal(watched.continuation.reason, 'HALTED');
	assert.match(stderrOutput, /\x07⚠️  \[shell watch\] Run 'r-halted' HALTED: repeated-failed-reads/);
});
