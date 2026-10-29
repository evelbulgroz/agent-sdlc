import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { maybePromptLearningDebt } from './skills.ts';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import { RuntimeStore } from '../../persistence/runtime-store.ts';
import { createEvent } from '../../policy/contracts.ts';

test('AC-14: maybePromptLearningDebt interactive TTY prompt handles answer y and default N', async () => {
	const tempRoot = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`tty-prompt-${crypto.randomUUID()}`,
	);
	fs.mkdirSync(path.join(tempRoot, '.agent-sdlc'), { recursive: true });
	try {
		for (let i = 1; i <= 3; i++) {
			const runId = `2026-09-0${i}-unreviewed-${i}`;
			const runDir = path.join(tempRoot, '.agent-sdlc', runId);
			fs.mkdirSync(runDir, { recursive: true });
			const store = new RuntimeStore(path.join(runDir, 'runtime.sqlite'));
			store.database.prepare(`
				INSERT INTO runs (run_id, thread_id, runtime_revision, state, state_hash, state_json, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`).run(runId, `thread-${i}`, 1, 'READY_FOR_GIT_APPROVAL', 'hash', '{}', new Date().toISOString(), new Date().toISOString());
			store.appendEvent(
				createEvent({
					eventType: 'PROMPT_FRICTION_DETECTED',
					runId,
					runtimeRevision: 1,
					causalId: `c-${i}`,
					payload: {},
				}),
			);
			store.close();
		}

		// Case A: User answers 'y' -> triggers runCliFn with skills --run
		let invokedArgs = null;
		const mockRunCli = async (args) => {
			invokedArgs = args;
			return { exitCode: 0, result: { ok: true } };
		};

		let stdoutOutput = '';
		const stdout = new Writable({
			write(chunk, _encoding, callback) {
				stdoutOutput += chunk.toString();
				callback();
			},
		});

		await maybePromptLearningDebt({
			command: 'start',
			result: { runId: '2026-09-03-unreviewed-3', state: 'READY_FOR_GIT_APPROVAL' },
			rootDir: tempRoot,
			streams: {
				stdin: { isTTY: true },
				stdout,
				stderr: stdout,
			},
			createReadline: () => ({
				async question(prompt) {
					stdoutOutput += prompt;
					return 'y';
				},
				close() {},
			}),
			runCliFn: mockRunCli,
		});

		assert.match(stdoutOutput, /⚠️  SDLC Learning Debt: 3 run\(s\) with unanalyzed friction\. Run trace attribution now\? \[y\/N\]:/);
		assert.deepEqual(invokedArgs, ['skills', '--run', '2026-09-03-unreviewed-3']);

		// Case B: User answers 'n' -> exits 0 without invoking runCliFn
		invokedArgs = null;
		await maybePromptLearningDebt({
			command: 'start',
			result: { runId: '2026-09-03-unreviewed-3', state: 'READY_FOR_GIT_APPROVAL' },
			rootDir: tempRoot,
			streams: {
				stdin: { isTTY: true },
				stdout,
				stderr: stdout,
			},
			createReadline: () => ({
				async question() {
					return 'n';
				},
				close() {},
			}),
			runCliFn: mockRunCli,
		});

		assert.equal(invokedArgs, null);

		// Case C: Excluded command 'skills' -> no prompt, no invoke
		let promptCalled = false;
		await maybePromptLearningDebt({
			command: 'skills',
			result: { runId: '2026-09-03-unreviewed-3', state: 'READY_FOR_GIT_APPROVAL' },
			rootDir: tempRoot,
			streams: {
				stdin: { isTTY: true },
				stdout,
				stderr: stdout,
			},
			createReadline: () => ({
				async question() {
					promptCalled = true;
					return 'y';
				},
				close() {},
			}),
			runCliFn: mockRunCli,
		});

		assert.equal(promptCalled, false);
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

test('@ac AC-02 @case AC-02.2 AC-15: maybePromptLearningDebt in non-TTY mode logs informational advisory and exits 0', async () => {
	const tempRoot = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`nontty-prompt-${crypto.randomUUID()}`,
	);
	fs.mkdirSync(path.join(tempRoot, '.agent-sdlc'), { recursive: true });
	try {
		for (let i = 1; i <= 3; i++) {
			const runId = `2026-09-0${i}-unreviewed-${i}`;
			const runDir = path.join(tempRoot, '.agent-sdlc', runId);
			fs.mkdirSync(runDir, { recursive: true });
			const store = new RuntimeStore(path.join(runDir, 'runtime.sqlite'));
			store.database.prepare(`
				INSERT INTO runs (run_id, thread_id, runtime_revision, state, state_hash, state_json, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`).run(runId, `thread-${i}`, 1, 'READY_FOR_GIT_APPROVAL', 'hash', '{}', new Date().toISOString(), new Date().toISOString());
			store.appendEvent(
				createEvent({
					eventType: 'PROMPT_FRICTION_DETECTED',
					runId,
					runtimeRevision: 1,
					causalId: `c-${i}`,
					payload: {},
				}),
			);
			store.close();
		}

		let stdoutOutput = '';
		const stdout = new Writable({
			write(chunk, _encoding, callback) {
				stdoutOutput += chunk.toString();
				callback();
			},
		});

		let readlineCalled = false;
		let learningDebtCalls = 0;
		const learningDebtRunCli = async () => {
			learningDebtCalls += 1;
		};
		await maybePromptLearningDebt({
			command: 'start',
			result: { runId: '2026-09-03-unreviewed-3', state: 'READY_FOR_GIT_APPROVAL' },
			rootDir: tempRoot,
			streams: {
				stdin: { isTTY: false },
				stdout,
				stderr: stdout,
			},
			createReadline: () => {
				readlineCalled = true;
				return { async question() { return ''; }, close() {} };
			},
			runCliFn: learningDebtRunCli,
		});

		assert.equal(readlineCalled, false);
		assert.equal(learningDebtCalls, 0);
		assert.match(stdoutOutput, /⚠️  SDLC Learning Debt: 3 run\(s\) with unanalyzed friction\. Run 'agent-sdlc skills' to analyze\./);
		assert.equal(stdoutOutput.includes('pnpm run agent:'), false);
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

test('@ac AC-03 @case AC-03.2 maybePromptLearningDebt without runCliFn rejects before a prompt', async () => {
	let prompted = false;
	const stdout = new Writable({
		write(_chunk, _encoding, callback) {
			prompted = true;
			callback();
		},
	});
	await assert.rejects(
		() => maybePromptLearningDebt({
			command: 'start',
			result: { state: 'DONE', runId: 'run-1' },
			rootDir: REPOSITORY_ROOT,
			streams: { stdin: { isTTY: true }, stdout, stderr: stdout },
			createReadline: () => {
				prompted = true;
				return { async question() { return 'y'; }, close() {} };
			},
		}),
		(error) => error.code === 'INVALID_INPUT' && error.message === 'runCliFn is required',
	);
	assert.equal(prompted, false);
});
