import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../cli/cli.ts';
import { loadHostProfile } from '../host/host-profile.ts';
import { hydrate, validateCommand } from '../host/script.ts';
import { runHostVerify } from '../host/verify-runner.ts';
import { discoverWorkspace } from '../host/workspace.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

const FIXTURE_HOST_DIR = path.join(
	REPOSITORY_ROOT,
	'packages/agent-sdlc/testing/fixture-host',
);

function withTempFixtureRepo(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-fixture-host-'));
	fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
	fs.copyFileSync(
		path.join(FIXTURE_HOST_DIR, 'profile.json'),
		path.join(dir, '.agents/sdlc-host.json'),
	);
	fs.copyFileSync(
		path.join(FIXTURE_HOST_DIR, 'verify.mjs'),
		path.join(dir, 'verify.mjs'),
	);
	execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
	execFileSync('git', ['config', 'user.email', 'fixture@example.com'], {
		cwd: dir,
		stdio: 'ignore',
	});
	execFileSync('git', ['config', 'user.name', 'Fixture Host'], {
		cwd: dir,
		stdio: 'ignore',
	});
	execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
	execFileSync('git', ['commit', '-m', 'init fixture host'], {
		cwd: dir,
		stdio: 'ignore',
	});
	const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
		cwd: dir,
		encoding: 'utf8',
	}).trim();
	return Promise.resolve()
		.then(() => fn(dir, headSha))
		.finally(() => {
			fs.rmSync(dir, { recursive: true, force: true });
		});
}

test('@ac AC-08 @case AC-08.1 host check --root <dir> --json reports profileId fixture-host and adapter script', async () => {
	await withTempFixtureRepo(async (dir) => {
		assert.equal(fs.existsSync(path.join(dir, 'pnpm-workspace.yaml')), false);
		assert.equal(fs.existsSync(path.join(dir, 'apps/services')), false);
		assert.equal(fs.existsSync(path.join(dir, 'security-config')), false);

		const outcome = await runCli(
			['host', 'check', '--root', dir, '--json'],
			{ rootDir: REPOSITORY_ROOT },
		);
		assert.equal(outcome.exitCode, 0);
		assert.equal(outcome.result.profileId, 'fixture-host');
		assert.equal(outcome.result.adapter, 'script');
	});
});

test('@ac AC-08 @case AC-08.2 discoverWorkspace, hydrate, and validateCommand(["node", "--test"]) succeed without calling pnpm', async () => {
	await withTempFixtureRepo(async (dir) => {
		const profile = loadHostProfile(dir);
		const discovery = discoverWorkspace(dir, profile);
		assert.deepEqual(discovery.directories, ['.']);

		const spawned = [];
		const hydrated = await hydrate({
			worktreeDir: dir,
			profile,
			runner: (cmd, args) => {
				spawned.push([cmd, ...args]);
				return '';
			},
		});
		assert.equal(hydrated.status, 'HYDRATED');
		assert.equal(spawned.length, 0);

		assert.doesNotThrow(() =>
			validateCommand('node', ['--test'], profile),
		);
	});
});

test('@ac AC-08 @case AC-08.3 runHostVerify runs node verify.mjs <headSha>, reads tools/.verify/last.json, and returns PASS', async () => {
	await withTempFixtureRepo(async (dir, headSha) => {
		const profile = loadHostProfile(dir);
		const outcome = await runHostVerify({
			worktreeDir: dir,
			profile,
			baseSha: headSha,
			expectedHead: headSha,
		});
		assert.equal(outcome.status, 'PASS');
		assert.equal(outcome.ok, true);
		assert.equal(outcome.result.head, headSha);
		assert.equal(
			fs.existsSync(path.join(dir, 'tools/.verify/last.json')),
			true,
		);
	});
});
