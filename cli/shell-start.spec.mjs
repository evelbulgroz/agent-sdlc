import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runCli } from './cli.ts';
import { humanResult } from './human-result.ts';
import { exitCodeForResult } from './exit-codes.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { shellStart } from './shell-driver.ts';
import { makeTempDir, writeGoalFile, SILENT_STREAMS, throwingGovernor, spyOnRunCli } from '../testing/shell-driver-support.mjs';

test('@ac AC-03: An unready draft does not start a run', async () => {
	const dir = makeTempDir('ac03');
	const goalFile = writeGoalFile(dir, { owningContext: '' });
	const spy = spyOnRunCli();

	const result = await shellStart({
		goalFile,
		rootDir: REPOSITORY_ROOT,
		streams: SILENT_STREAMS,
		runCliFn: spy,
		engineOptions: { governor: throwingGovernor() },
	});

	assert.equal(result.ready, false);
	assert.ok(result.missingFields.includes('owningContext'));
	assert.equal(exitCodeForResult(result), 2);
	const human = humanResult('shell start', result);
	for (const field of result.missingFields) {
		assert.match(human, new RegExp(field));
	}
	assert.deepEqual(spy.calls, ['check-spec']);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('@ac AC-04: A ready draft is briefed, and a confirming response starts the engine once', async (t) => {
	await t.test('@case AC-04.1: no response file does not start a run', async () => {
		const dir = makeTempDir('ac04-1');
		const acceptanceCriteria = [
			'AC-01: An exact spec is approved. Given a complete grammatical draft and operator approval. Then approvedSpecHash equals the draft hash.',
			'AC-02: A second outcome holds. Given a second input. Then a second result follows.',
		];
		const goalFile = writeGoalFile(dir, { acceptanceCriteria });
		const spy = spyOnRunCli();

		const result = await shellStart({
			goalFile,
			rootDir: REPOSITORY_ROOT,
			streams: SILENT_STREAMS,
			runCliFn: spy,
			engineOptions: { governor: throwingGovernor() },
		});

		assert.equal(result.ready, true);
		assert.equal(result.owningContext, 'tools/agent-sdlc');
		assert.equal(result.acceptanceCriteria.length, 2);
		assert.equal(exitCodeForResult(result), 2);
		const human = humanResult('shell start', result);
		for (const criterion of result.acceptanceCriteria) {
			assert.ok(human.includes(criterion));
		}
		assert.ok(human.includes('tools/agent-sdlc'));
		assert.deepEqual(spy.calls, ['check-spec']);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	await t.test('@case AC-04.2: a confirming response file invokes start once', async () => {
		const dir = makeTempDir('ac04-2');
		const goalFile = writeGoalFile(dir);
		const briefSpy = spyOnRunCli();

		const brief = await shellStart({
			goalFile,
			rootDir: REPOSITORY_ROOT,
			streams: SILENT_STREAMS,
			runCliFn: briefSpy,
			engineOptions: { governor: throwingGovernor() },
		});
		assert.equal(brief.continuation.reason, 'BRIEF_CONFIRMATION_REQUIRED');

		const responseFile = path.join(dir, 'confirm.json');
		fs.writeFileSync(responseFile, JSON.stringify({ confirm: true, briefHash: brief.briefHash }));

		let startCallCount = 0;
		async function fakeRunCliFn(args) {
			if (args[0] === 'check-spec') {
				return realCheckSpec(args);
			}
			if (args[0] === 'start') {
				startCallCount += 1;
				return {
					exitCode: 2,
					result: {
						ok: true,
						command: 'start',
						runId: '2026-01-01-fake-run',
						state: 'WAITING_FOR_ANSWERS',
						continuation: { action: 'answer', reason: 'QUESTIONS_PENDING' },
					},
					human: 'start: WAITING_FOR_ANSWERS',
				};
			}
			throw new Error(`unexpected engine command in test stub: ${args[0]}`);
		}
		function realCheckSpec(args) {
			return runCli(args, { rootDir: REPOSITORY_ROOT });
		}

		const started = await shellStart({
			goalFile,
			slug: 'shell-driver-ac04',
			responseFile,
			rootDir: REPOSITORY_ROOT,
			streams: SILENT_STREAMS,
			runCliFn: fakeRunCliFn,
		});

		assert.equal(startCallCount, 1);
		assert.equal(started.runId, '2026-01-01-fake-run');
		assert.equal(started.state, 'WAITING_FOR_ANSWERS');
		assert.equal(started.ok, undefined, 'driver result must not re-wrap the ok/command envelope');
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

test('shell start rejects a goal file whose sibling task manifest was omitted', async () => {
	const dir = makeTempDir('sibling-manifest');
	const goalFile = writeGoalFile(dir);
	const sibling = goalFile.replace(/\.md$/, '.tasks.json');
	fs.writeFileSync(sibling, '{}\n');
	const spy = spyOnRunCli();

	await assert.rejects(
		() =>
			shellStart({
				goalFile,
				rootDir: REPOSITORY_ROOT,
				streams: SILENT_STREAMS,
				runCliFn: spy,
				engineOptions: { governor: throwingGovernor() },
			}),
		(error) => {
			assert.equal(error.code, 'INVALID_INPUT');
			assert.match(error.message, /--task-plan-file/);
			assert.match(error.message, /sibling task manifest exists/);
			assert.ok(error.message.includes(sibling));
			return true;
		},
	);
	assert.deepEqual(spy.calls, []);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('shell start passes an explicit task manifest through to check-spec', async () => {
	const dir = makeTempDir('sibling-explicit');
	const goalFile = writeGoalFile(dir);
	const sibling = goalFile.replace(/\.md$/, '.tasks.json');
	fs.writeFileSync(sibling, '{}\n');
	const calls = [];
	async function spy(args) {
		calls.push(args.slice());
		return {
			exitCode: 2,
			result: {
				ok: true,
				command: 'check-spec',
				ready: false,
				completeness: { missingFields: ['owningContext'], ambiguousFields: [] },
			},
			human: 'check-spec',
		};
	}

	const result = await shellStart({
		goalFile,
		taskPlanFile: sibling,
		rootDir: REPOSITORY_ROOT,
		streams: SILENT_STREAMS,
		runCliFn: spy,
		engineOptions: { governor: throwingGovernor() },
	});

	assert.equal(result.ready, false);
	assert.deepEqual(calls, [['check-spec', '--goal-file', goalFile, '--json', '--task-plan-file', sibling]]);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('shell start ignores a tasks file that is not the .md sibling', async () => {
	const dir = makeTempDir('sibling-non-md');
	const goalFile = path.join(dir, 'goal.txt');
	fs.writeFileSync(goalFile, fs.readFileSync(writeGoalFile(dir), 'utf8'));
	fs.writeFileSync(path.join(dir, 'goal.tasks.json'), '{}\n');
	const spy = spyOnRunCli();

	const result = await shellStart({
		goalFile,
		rootDir: REPOSITORY_ROOT,
		streams: SILENT_STREAMS,
		runCliFn: spy,
		engineOptions: { governor: throwingGovernor() },
	});

	assert.equal(result.ready, true);
	assert.deepEqual(spy.calls, ['check-spec']);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('shell start --executor minimal places the flag on the inner start argv', async () => {
	const dir = makeTempDir('executor-forward');
	const goalFile = writeGoalFile(dir);
	const brief = await shellStart({
		goalFile,
		rootDir: REPOSITORY_ROOT,
		streams: SILENT_STREAMS,
		runCliFn: spyOnRunCli(),
		engineOptions: { governor: throwingGovernor() },
	});
	const responseFile = path.join(dir, 'confirm.json');
	fs.writeFileSync(responseFile, JSON.stringify({ confirm: true, briefHash: brief.briefHash }));
	const seen = [];
	async function fakeRunCliFn(args) {
		if (args[0] === 'check-spec') return runCli(args, { rootDir: REPOSITORY_ROOT });
		seen.push(args.slice());
		return {
			exitCode: 2,
			result: {
				ok: true,
				command: 'start',
				runId: '2026-01-01-executor',
				state: 'WAITING_FOR_ANSWERS',
				continuation: { action: 'answer', reason: 'QUESTIONS_PENDING' },
			},
			human: 'start',
		};
	}
	await shellStart({
		goalFile,
		responseFile,
		executor: 'minimal',
		rootDir: REPOSITORY_ROOT,
		streams: SILENT_STREAMS,
		runCliFn: fakeRunCliFn,
	});
	assert.equal(seen.length, 1);
	const executorFlag = seen[0].indexOf('--executor');
	assert.ok(executorFlag > 0);
	assert.equal(seen[0][executorFlag + 1], 'minimal');
	assert.equal(seen[0].includes('AGENT_SDLC_EXECUTOR'), false);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('shell start --skip-canary places the flag on the inner start argv', async () => {
	const dir = makeTempDir('skip-canary-forward');
	const goalFile = writeGoalFile(dir);
	const brief = await shellStart({
		goalFile,
		rootDir: REPOSITORY_ROOT,
		streams: SILENT_STREAMS,
		runCliFn: spyOnRunCli(),
		engineOptions: { governor: throwingGovernor() },
	});
	const responseFile = path.join(dir, 'confirm.json');
	fs.writeFileSync(responseFile, JSON.stringify({ confirm: true, briefHash: brief.briefHash }));
	const seen = [];
	async function fakeRunCliFn(args) {
		if (args[0] === 'check-spec') return runCli(args, { rootDir: REPOSITORY_ROOT });
		seen.push(args.slice());
		return {
			exitCode: 2,
			result: {
				ok: true,
				command: 'start',
				runId: '2026-01-01-skip-canary',
				state: 'WAITING_FOR_ANSWERS',
				continuation: { action: 'answer', reason: 'QUESTIONS_PENDING' },
			},
			human: 'start',
		};
	}
	await shellStart({
		goalFile,
		responseFile,
		skipCanary: true,
		rootDir: REPOSITORY_ROOT,
		streams: SILENT_STREAMS,
		runCliFn: fakeRunCliFn,
	});
	assert.equal(seen.length, 1);
	assert.ok(seen[0].includes('--skip-canary'));
	fs.rmSync(dir, { recursive: true, force: true });
});
