import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { parseArguments, requiredValue } from './arguments.ts';
import { runCli } from './cli.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { FakeModelGovernor } from '../testing/fake-model-governor.mjs';
import { completeProposal } from '../testing/test-support.mjs';
import { slug, throwingGovernor } from '../testing/cli-test-support.mjs';

test('@ac AC-01: Removed interactive CLI surfaces fail closed and name the shell replacement', async () => {
	const governor = new FakeModelGovernor([completeProposal()]);
	const streams = {
		stdin: Readable.from(['']),
		stdout: new Writable({ write(_c, _e, cb) { cb(); } }),
		stderr: new Writable({ write(_c, _e, cb) { cb(); } }),
	};

	// @case AC-01.1: start --hitl-tty is rejected before any run is created
	const testSlug = slug('removed-hitl-tty');
	const outcomeStart = await runCli(
		['start', '--slug', testSlug, '--goal', 'Test goal', '--hitl-tty'],
		{ rootDir: REPOSITORY_ROOT, governor, streams },
	);
	assert.equal(outcomeStart.exitCode, 64);
	assert.equal(outcomeStart.result.error.code, 'INVALID_INPUT');
	assert.match(outcomeStart.result.error.message, /shell/);
	assert.doesNotMatch(outcomeStart.human, /\?/);
	assert.equal(
		fs.existsSync(
			path.join(REPOSITORY_ROOT, 'docs/specs/runs', `${new Date().toISOString().slice(0, 10)}-${testSlug}`),
		),
		false,
	);

	// @case AC-01.2: resume --hitl-tty is rejected without touching the run
	const outcomeResume = await runCli(['resume', '--run', '2026-09-18-dummy-run', '--hitl-tty'], {
		rootDir: REPOSITORY_ROOT,
		governor,
		streams,
	});
	assert.equal(outcomeResume.exitCode, 64);
	assert.equal(outcomeResume.result.error.code, 'INVALID_INPUT');
	assert.match(outcomeResume.result.error.message, /shell/);

	// @case AC-01.3: the interview command is rejected outright
	const outcomeInterview = await runCli(['interview', '--run', '2026-09-18-dummy-run'], {
		rootDir: REPOSITORY_ROOT,
		governor,
		streams,
	});
	assert.equal(outcomeInterview.exitCode, 64);
	assert.equal(outcomeInterview.result.error.code, 'INVALID_INPUT');
	assert.match(outcomeInterview.result.error.message, /shell/);
});

test('parseArguments rejects an empty argv and an unknown command', () => {
	assert.throws(
		() => parseArguments([]),
		(error) => error.code === 'INVALID_INPUT' && /Usage:/.test(error.message),
	);
	assert.throws(
		() => parseArguments(null),
		(error) => error.code === 'INVALID_INPUT',
	);
	assert.throws(
		() => parseArguments(['nope']),
		(error) => error.code === 'INVALID_INPUT' && error.message === "Unknown command 'nope'",
	);
	assert.throws(
		() => requiredValue({ values: new Map() }, '--run'),
		(error) => error.code === 'INVALID_INPUT',
	);
});

test('@ac AC-09 help lists check-spec and --goal-file', async () => {
	const outcome = await runCli(['help'], { rootDir: REPOSITORY_ROOT, governor: throwingGovernor() });
	assert.equal(outcome.exitCode, 0);
	assert.match(outcome.human, /check-spec/);
	assert.match(outcome.human, /--goal-file/);
});
