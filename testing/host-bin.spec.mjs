import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../cli/cli.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';
import { FakeModelGovernor } from './fake-model-governor.mjs';
import { completeProposal } from './test-support.mjs';

const FIXTURE_HOST_DIR = path.join(
	REPOSITORY_ROOT,
	'packages/agent-sdlc/testing/fixture-host',
);

function withTempFixtureRepo(fn, profileOverrides = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-host-bin-'));
	fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
	const baseProfile = JSON.parse(
		fs.readFileSync(path.join(FIXTURE_HOST_DIR, 'profile.json'), 'utf8'),
	);
	fs.writeFileSync(
		path.join(dir, '.agents/sdlc-host.json'),
		`${JSON.stringify({ ...baseProfile, ...profileOverrides }, null, 2)}\n`,
		'utf8',
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

test('@ac AC-07 @case AC-07.1 node packages/agent-sdlc/cli/cli.ts and linked node_modules/.bin/agent-sdlc host check --root <dir> --json exit 0 and print fixture-host profile', async () => {
	await withTempFixtureRepo(async (dir) => {
		const cliEntry = path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/cli/cli.ts');
		const directRes = spawnSync(
			process.execPath,
			[cliEntry, 'host', 'check', '--root', dir, '--json'],
			{ cwd: REPOSITORY_ROOT, encoding: 'utf8', timeout: 30_000 },
		);
		assert.equal(directRes.status, 0, directRes.stderr);
		const directJson = JSON.parse(directRes.stdout.trim());
		assert.equal(directJson.profileId, 'fixture-host');
		assert.equal(directJson.adapter, 'script');

		const binDir = path.join(dir, 'node_modules/.bin');
		fs.mkdirSync(binDir, { recursive: true });
		const binLink = path.join(binDir, 'agent-sdlc');
		fs.symlinkSync(cliEntry, binLink);

		const binRes = spawnSync(
			binLink,
			['host', 'check', '--root', dir, '--json'],
			{ cwd: REPOSITORY_ROOT, encoding: 'utf8', timeout: 30_000 },
		);
		assert.equal(binRes.status, 0, binRes.stderr);
		const binJson = JSON.parse(binRes.stdout.trim());
		assert.equal(binJson.profileId, 'fixture-host');
		assert.equal(binJson.adapter, 'script');
	});
});

test('@ac AC-07 @case AC-07.2 @case AC-07.3 start against --root <dir> with custom stateDir var/.sdlc creates runtime.sqlite under var/.sdlc and resolves repositoryId fixture-host', async () => {
	await withTempFixtureRepo(
		async (dir, headSha) => {
			const governor = new FakeModelGovernor([completeProposal()]);
			const outcome = await runCli(
				[
					'start',
					'--root',
					dir,
					'--slug',
					'custom-state-proof',
					'--goal',
					'Verify custom stateDir in fixture host',
					'--json',
				],
				{
					rootDir: REPOSITORY_ROOT,
					governor,
				},
			);
			assert.equal(outcome.exitCode, 2, outcome.human);
			assert.equal(outcome.result.ok, true);
			const runId = outcome.result.runId;
			assert.equal(typeof runId, 'string');

			const customDbPath = path.join(dir, 'var/.sdlc', runId, 'runtime.sqlite');
			assert.equal(fs.existsSync(customDbPath), true, customDbPath);
			assert.equal(fs.existsSync(path.join(dir, 'tools/.agent-sdlc')), false);

			const envelope = createDefaultAuthorizationEnvelope({
				runId,
				approvedSpecHash: 'a'.repeat(64),
				baseCommitSha: headSha,
				allowedPackages: ['packages/agent-sdlc'],
				allowedPathPrefixes: ['packages/agent-sdlc'],
				rootDir: dir,
			});
			assert.equal(envelope.repositoryId, 'fixture-host');
		},
		{ stateDir: 'var/.sdlc' },
	);
});
