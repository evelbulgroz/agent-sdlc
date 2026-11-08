import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acceptanceConfig } from '../../acceptance/config.mjs';
import { buildCommandRegistrations } from '../../acceptance/command-evidence.mjs';
import { loadHostProfile } from '../../host/host-profile.ts';
import { runCli } from '../cli.ts';

function hostDir(t) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-scaffold-')));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.mkdirSync(path.join(dir, 'app'));
	return dir;
}

test('@ac AC-01 @case AC-01.3 scaffold drafts a profile the engine loads and turns into a command registration', async (t) => {
	const dir = hostDir(t);
	const outcome = await runCli(['host', 'scaffold', '--package', 'app', '--root', dir, '--profile-id', 'drafted', '--json'], { rootDir: dir });
	assert.equal(outcome.exitCode, 0);
	assert.equal(outcome.result.written, true);
	assert.deepEqual(outcome.result.files.length, 3);
	const profile = loadHostProfile(dir);
	assert.equal(profile.profileId, 'drafted');
	const config = acceptanceConfig(profile, dir);
	fs.writeFileSync(path.join(dir, 'app/cases.test.mjs'), '');
	const [registration] = await buildCommandRegistrations(dir, config);
	assert.equal(registration.kind, 'command');
	assert.equal(registration.reportFormat, 'junit');
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, config.caseManifest), 'utf8')).cases, []);
});

test('@ac AC-01 @case AC-01.4 scaffold refuses to overwrite, honours --dry-run and rejects an unsafe package', async (t) => {
	const dir = hostDir(t);
	const run = (...args) => runCli(['host', 'scaffold', '--root', dir, '--json', ...args], { rootDir: dir });
	const dry = await run('--package', 'app', '--dry-run');
	assert.equal(dry.result.written, false);
	assert.equal(fs.existsSync(path.join(dir, '.agents/sdlc-host.json')), false);
	await run('--package', 'app');
	const before = fs.readFileSync(path.join(dir, '.agents/sdlc-host.json'), 'utf8');
	const again = await run('--package', 'app');
	assert.notEqual(again.exitCode, 0);
	assert.equal(fs.readFileSync(path.join(dir, '.agents/sdlc-host.json'), 'utf8'), before);
	assert.equal((await run('--package', 'app', '--overwrite')).exitCode, 0);
	for (const bad of ['../x', '/etc', 'missing']) assert.notEqual((await run('--package', bad)).exitCode, 0);
	assert.notEqual((await run('--package', 'app', '--profile-id', 'Bad Id', '--overwrite')).exitCode, 0);
	assert.notEqual((await run()).exitCode, 0);
});
