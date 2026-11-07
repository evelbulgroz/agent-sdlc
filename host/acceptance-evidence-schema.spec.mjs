import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadHostProfile } from './host-profile.ts';
import { runCli } from '../cli/cli.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

const BLOCK = {
	canaryId: 'canary-v1',
	slug: 'healthy',
	evidenceDir: 'tools/.evidence',
	runtimeDir: 'tools/runtime',
	helpersDir: 'tools/helpers',
	nodeExecutable: '/usr/bin/node',
	caseManifest: 'tools/cases.json',
	runtimeSources: 'tools/runtime.sources.json',
	package: { root: 'apps/web', openApiPath: 'apps/api/openapi.json' },
	sandbox: { readOnlyBinds: ['src', 'package.json'] },
	runners: { unit: { argv: ['/usr/bin/node', 'tools/unit-adapter.mjs'], bundleFiles: ['unit.config.ts'] } },
};

function withProfile(overrides, fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-acceptance-profile-'));
	fs.mkdirSync(path.join(dir, '.agents'));
	fs.writeFileSync(
		path.join(dir, '.agents/sdlc-host.json'),
		JSON.stringify({ schemaVersion: '1.5.0', profileId: 'p', repositoryId: 'r', adapter: 'default', ...overrides }),
	);
	try {
		const result = fn(dir);
		return result?.finally ? result.finally(() => fs.rmSync(dir, { recursive: true, force: true })) : (fs.rmSync(dir, { recursive: true, force: true }), result);
	} catch (error) {
		fs.rmSync(dir, { recursive: true, force: true });
		throw error;
	}
}

const clone = () => structuredClone(BLOCK);
const rejects = (overrides, pattern) =>
	withProfile(overrides, (dir) => assert.throws(() => loadHostProfile(dir), pattern));

test('a 1.5.0 profile with a valid acceptanceEvidence block loads', () => {
	withProfile({ acceptanceEvidence: BLOCK }, (dir) => {
		assert.deepEqual(loadHostProfile(dir).acceptanceEvidence?.runners.unit.bundleFiles, ['unit.config.ts']);
	});
});

test('1.4.0 and 1.3.0 profiles still load and decode with acceptanceEvidence absent', () => {
	for (const schemaVersion of ['1.4.0', '1.3.0']) {
		withProfile({ schemaVersion }, (dir) => assert.equal(loadHostProfile(dir).acceptanceEvidence, undefined));
	}
});

test('acceptanceEvidence is rejected below 1.5.0', () => {
	rejects({ schemaVersion: '1.4.0', acceptanceEvidence: BLOCK }, /requires schemaVersion '1\.5\.0'/);
	rejects({ schemaVersion: '1.3.0', acceptanceEvidence: BLOCK }, /requires schemaVersion '1\.5\.0'/);
});

test('evidenceAdapters is still rejected below 1.4.0', () => {
	rejects({ schemaVersion: '1.3.0', evidenceAdapters: [] }, /requires schemaVersion '1\.4\.0'/);
});

test('the block is closed: unknown keys fail at every level', () => {
	for (const mutate of [
		(b) => { b.extra = 1; },
		(b) => { b.package.extra = 1; },
		(b) => { b.sandbox.extra = 1; },
		(b) => { b.runners.unit.plugin = 'vitest'; },
	]) {
		const block = clone();
		mutate(block);
		rejects({ acceptanceEvidence: block }, /Unrecognized key/);
	}
});

test('each required key is enforced', () => {
	for (const key of ['canaryId', 'slug', 'evidenceDir', 'runtimeDir', 'helpersDir', 'nodeExecutable', 'caseManifest', 'runtimeSources', 'package', 'sandbox', 'runners']) {
		const block = clone();
		delete block[key];
		rejects({ acceptanceEvidence: block }, new RegExp(`acceptanceEvidence\\.${key}`));
	}
	const noRoot = clone();
	delete noRoot.package.root;
	rejects({ acceptanceEvidence: noRoot }, /acceptanceEvidence\.package\.root/);
});

test('ids must be lowercase tokens, runners non-empty, and adapter argv[0] absolute', () => {
	for (const bad of ['Canary V1', '../x', '']) {
		rejects({ acceptanceEvidence: { ...clone(), canaryId: bad } }, /acceptanceEvidence\.canaryId/);
	}
	rejects({ acceptanceEvidence: { ...clone(), runners: {} } }, /at least one runner/);
	const relative = clone();
	relative.runners.unit.argv = ['node', 'a.mjs'];
	rejects({ acceptanceEvidence: relative }, /absolute executable path/);
});

test('every named path must be repository-relative and contained', () => {
	for (const mutate of [
		(b) => { b.evidenceDir = '/etc'; },
		(b) => { b.runtimeDir = '../runtime'; },
		(b) => { b.helpersDir = '/abs/helpers'; },
		(b) => { b.nodeExecutable = 'node'; },
		(b) => { b.caseManifest = '../outside.json'; },
		(b) => { b.runtimeSources = 'a/../../b'; },
		(b) => { b.package.root = '/abs'; },
		(b) => { b.package.openApiPath = '../x.json'; },
		(b) => { b.sandbox.readOnlyBinds = ['../secrets']; },
		(b) => { b.runners.unit.bundleFiles = ['/abs/config.ts']; },
	]) {
		const block = clone();
		mutate(block);
		rejects({ acceptanceEvidence: block }, /acceptanceEvidence\./);
	}
});

test('host check reports the acceptance block and omits it when absent', async () => {
	await withProfile({ acceptanceEvidence: BLOCK }, async (dir) => {
		const outcome = await runCli(['host', 'check', '--root', dir, '--json'], { rootDir: REPOSITORY_ROOT });
		assert.equal(outcome.exitCode, 0);
		assert.deepEqual(outcome.result.acceptanceEvidence, { canaryId: 'canary-v1', runners: ['unit'] });
	});
	await withProfile({}, async (dir) => {
		const outcome = await runCli(['host', 'check', '--root', dir, '--json'], { rootDir: REPOSITORY_ROOT });
		assert.equal('acceptanceEvidence' in outcome.result, false);
	});
});
