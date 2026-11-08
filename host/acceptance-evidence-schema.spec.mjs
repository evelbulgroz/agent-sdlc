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
		JSON.stringify({ schemaVersion: overrides.schemaVersion ?? '1.5.0', profileId: 'p', repositoryId: 'r', adapter: 'default', ...overrides }),
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
		(b) => { b.runners.unit.config = '../outside.config.ts'; },
	]) {
		const block = clone();
		mutate(block);
		rejects({ acceptanceEvidence: block }, /acceptanceEvidence\./);
	}
});

test('canary block is optional, closed, and its paths must be contained', () => {
	const canary = { spec: 'docs/spec.md', tasks: 'docs/tasks.json', corpus: 'tools/corpus.json',
		obligations: 'tools/obligations.json', files: [{ path: 'apps/web/t.spec.ts', kind: 'unit' }] };
	withProfile({ acceptanceEvidence: { ...BLOCK, canary, taskVerificationCommand: ['pm', 'run', 'lint'] } }, (dir) => {
		assert.equal(loadHostProfile(dir).acceptanceEvidence.canary.files[0].kind, 'unit');
	});
	for (const mutate of [
		(c) => { c.spec = '../spec.md'; },
		(c) => { c.obligations = '/abs.json'; },
		(c) => { c.files[0].path = 'a/../../x'; },
		(c) => { c.files[0].kind = 'other'; },
		(c) => { c.files = []; },
		(c) => { c.extra = 1; },
		(c) => { delete c.corpus; },
		(c) => { c.providerCredentials = ['lower_case']; },
	]) {
		const next = structuredClone(canary);
		mutate(next);
		rejects({ acceptanceEvidence: { ...BLOCK, canary: next } }, /HOST_PROFILE_INVALID: acceptanceEvidence\.canary/);
	}
	rejects({ acceptanceEvidence: { ...BLOCK, preflightResult: '../receipt.json' } }, /acceptanceEvidence\.preflightResult/);
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

const TIER_A = (() => {
	const { runners, helpersDir, nodeExecutable, ...rest } = BLOCK;
	return { ...rest, commands: { unit: { argv: ['node', '--test', '--test-reporter-destination={reportPath}'] } } };
})();
const v16 = (acceptanceEvidence) => ({ schemaVersion: '1.6.0', acceptanceEvidence });

test('a 1.6.0 Tier A block needs no runners, helpersDir or nodeExecutable', () => {
	withProfile(v16(TIER_A), (dir) => {
		const block = loadHostProfile(dir).acceptanceEvidence;
		assert.equal(block.runners, undefined);
		assert.deepEqual(Object.keys(block.commands), ['unit']);
	});
	withProfile(v16({ ...BLOCK, runners: undefined, commands: undefined }), (dir) => assert.throws(() => loadHostProfile(dir), /at least one runner or command/));
});

test('1.5.0 rejects commands and keeps its required fields; 1.6.0 loads 1.5.0 blocks', () => {
	rejects({ acceptanceEvidence: { ...BLOCK, commands: { other: TIER_A.commands.unit } } }, /commands requires schemaVersion '1\.6\.0'/);
	rejects({ acceptanceEvidence: { ...TIER_A } }, /requires schemaVersion '1\.6\.0'/);
	withProfile(v16(BLOCK), (dir) => assert.ok(loadHostProfile(dir).acceptanceEvidence.runners.unit));
});

test('a layer cannot set both runners and commands', () => {
	rejects(v16({ ...BLOCK, commands: TIER_A.commands }), /sets both runners and commands/);
});

test('a command may serve a layer beside a runner under its own key, and rejects unknown layers', () => {
	const beside = (layer) => v16({ ...BLOCK, commands: { 'unit-cmd': { argv: ['node', 'a.mjs'], layer } } });
	withProfile(beside('unit'), (dir) => assert.deepEqual(Object.keys(loadHostProfile(dir).acceptanceEvidence.commands), ['unit-cmd']));
	rejects(beside('nonsense'), /acceptanceEvidence/);
});

test('command argv placeholders are validated', () => {
	const argv = (value) => v16({ ...TIER_A, commands: { unit: { argv: value } } });
	withProfile(argv(['node', 'run.mjs', '--outputFile={reportPath}', '{baseSha}']), (dir) => assert.ok(loadHostProfile(dir)));
	for (const bad of [['node', '{other}'], ['{reportPath}'], ['node', 'x{reportPath}'], ['node', '{reportPath}{baseSha}'], ['node', '--a=$' + '{reportPath}x']]) {
		rejects(argv(bad), /only \{reportPath\} or \{baseSha\}/);
	}
});

test('command cwd and pins must be contained', () => {
	const command = (extra) => v16({ ...TIER_A, commands: { unit: { argv: ['node', 'a.mjs'], ...extra } } });
	withProfile(command({ cwd: 'apps/web/sub', pins: [{ file: 'package.json' }, { script: { file: 'package.json', name: 'test' } }] }), (dir) => assert.ok(loadHostProfile(dir)));
	rejects(command({ cwd: 'apps/other' }), /cwd must lie inside package\.root/);
	rejects(command({ cwd: '../x' }), /acceptanceEvidence\./);
	rejects(command({ pins: [{ file: '../../secrets' }] }), /acceptanceEvidence\.commands\.unit\.pins/);
	rejects(command({ pins: [{ file: 'a', extra: 1 }] }), /acceptanceEvidence/);
	rejects(command({ retries: -1 }), /acceptanceEvidence/);
});

test('host check lists command layers', async () => {
	await withProfile(v16(TIER_A), async (dir) => {
		const outcome = await runCli(['host', 'check', '--root', dir, '--json'], { rootDir: REPOSITORY_ROOT });
		assert.deepEqual(outcome.result.acceptanceEvidence.runners, ['unit']);
	});
});
