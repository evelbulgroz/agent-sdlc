import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import { runCli } from '../cli.ts';

function withTempRoot(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-host-check-test-'));
	return Promise.resolve()
		.then(() => fn(dir))
		.finally(() => {
			fs.rmSync(dir, { recursive: true, force: true });
		});
}

test('@ac AC-07 @case AC-07.1 host check --json prints profileId default-host and adapter default and exits 0', async () => {
	const outcome = await runCli(['host', 'check', '--json'], {
		rootDir: REPOSITORY_ROOT,
	});
	assert.equal(outcome.exitCode, 0);
	assert.equal(outcome.result.ok, true);
	assert.equal(outcome.result.profileId, 'default-host');
	assert.equal(outcome.result.adapter, 'default');
	assert.deepEqual(JSON.parse(outcome.human), {
		profileId: 'default-host',
		adapter: 'default',
	});
});

test('@ac AC-07 @case AC-07.2 host check --root <dir> against a directory with no .agents/sdlc-host.json exits non-zero with HOST_PROFILE_INVALID', async () => {
	await withTempRoot(async (emptyDir) => {
		const outcome = await runCli(['host', 'check', '--root', emptyDir, '--json'], {
			rootDir: REPOSITORY_ROOT,
		});
		assert.notEqual(outcome.exitCode, 0);
		assert.equal(outcome.result.ok, false);
		assert.equal(outcome.result.error.code, 'INVALID_INPUT');
		assert.match(outcome.result.error.message, /^HOST_PROFILE_INVALID/);
	});
});

test('@ac AC-07 @case AC-07.3 start against a directory with an invalid .agents/sdlc-host.json exits non-zero with HOST_PROFILE_INVALID before creating a run directory or SQLite row', async () => {
	await withTempRoot(async (invalidRoot) => {
		fs.mkdirSync(path.join(invalidRoot, '.agents'), { recursive: true });
		fs.writeFileSync(
			path.join(invalidRoot, '.agents/sdlc-host.json'),
			JSON.stringify({ schemaVersion: '2.0.0' }),
		);

		const outcome = await runCli(
			['start', '--slug', 'invalid-host-start', '--goal', 'Should not start'],
			{ rootDir: invalidRoot },
		);

		assert.notEqual(outcome.exitCode, 0);
		assert.equal(outcome.result.ok, false);
		assert.equal(outcome.result.error.code, 'INVALID_INPUT');
		assert.match(outcome.result.error.message, /^HOST_PROFILE_INVALID/);
		assert.equal(
			fs.existsSync(path.join(invalidRoot, 'docs/specs/runs')),
			false,
		);
		assert.equal(
			fs.existsSync(path.join(invalidRoot, 'tools/.agent-sdlc')),
			false,
		);
	});
});
