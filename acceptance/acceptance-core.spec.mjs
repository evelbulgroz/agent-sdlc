import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acceptanceConfig as resolveConfig } from './config.ts';
import { loadHostProfile } from '../host/host-profile.ts';
import { caseSelections } from './contracts.ts';
import { executeOwned } from './process.ts';
import {
	argumentsFor, normalizedCase, regularFile, relativePath, runnerOutcome, selectionGrep, titleMatches, verifyFile, bytesHash,
} from './primitives.ts';
import { namespaceArgv } from './sandbox.ts';

const acceptanceConfig = (root) => resolveConfig(loadHostProfile(root), root);

const BLOCK = {
	canaryId: 'canary-v1', slug: 'healthy', evidenceDir: 'ev', runtimeDir: 'rt', helpersDir: 'helpers',
	nodeExecutable: process.execPath, caseManifest: 'cases.json', runtimeSources: 'sources.json',
	package: { root: 'pkg', openApiPath: 'api/openapi.json' }, sandbox: { readOnlyBinds: ['src', 'package.json'] },
	commands: { unit: { argv: [process.execPath, 'run.mjs'] } },
};

function withRepo(fn, block = BLOCK) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-acceptance-')));
	for (const dir of ['.agents', 'ev/canary-v1/out', 'rt/sysroot/usr/lib', 'rt/node_modules', 'helpers', 'pkg/src', 'api']) {
		fs.mkdirSync(path.join(root, dir), { recursive: true });
	}
	fs.writeFileSync(path.join(root, '.agents/sdlc-host.json'), JSON.stringify({
		schemaVersion: '1.6.0', profileId: 'p', repositoryId: 'r', adapter: 'default', acceptanceEvidence: block,
	}));
	for (const file of ['package.json', 'pkg/package.json', 'api/openapi.json']) fs.writeFileSync(path.join(root, file), '{}');
	try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('acceptanceConfig exposes the optional packageManager and preflightCommand, null when absent', () => {
	withRepo((root) => {
		const config = acceptanceConfig(root);
		assert.equal(config.packageManager, null);
		assert.equal(config.preflightCommand, null);
	});
	withRepo((root) => {
		const config = acceptanceConfig(root);
		assert.equal(config.packageManager, 'pm');
		assert.deepEqual(config.preflightCommand, ['pm', 'run', 'verify', '--', '--base']);
		assert.throws(() => config.preflightCommand.push('x'));
	}, { ...BLOCK, packageManager: 'pm', preflightCommand: ['pm', 'run', 'verify', '--', '--base'] });
	withRepo((root) => assert.throws(() => acceptanceConfig(root), /HOST_PROFILE_INVALID/),
		{ ...BLOCK, preflightCommand: ['pm'] });
});

test('acceptanceConfig derives output from evidenceDir and canaryId and fails closed without the block', () => {
	withRepo((root) => {
		const config = acceptanceConfig(root);
		assert.equal(config.output, 'ev/canary-v1');
		assert.equal(config.packageRoot, 'pkg');
		assert.throws(() => { config.output = 'x'; });
	});
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-acceptance-none-'));
	fs.mkdirSync(path.join(root, '.agents'));
	fs.writeFileSync(path.join(root, '.agents/sdlc-host.json'), JSON.stringify({
		schemaVersion: '1.6.0', profileId: 'p', repositoryId: 'r', adapter: 'default',
	}));
	try { assert.throws(() => acceptanceConfig(root), /acceptanceEvidence is not configured/); }
	finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('relativePath rejects absolute, traversal, empty, dot and backslash segments', () => {
	for (const bad of ['/abs', '../x', 'a/../b', 'a//b', './a', 'a\\b', '', 'a\0b', 7]) assert.throws(() => relativePath(bad), /unsafe relative path/);
	assert.equal(relativePath('a/b.txt'), 'a/b.txt');
});

test('regularFile and verifyFile refuse symlinks and changed bytes', () => {
	withRepo((root) => {
		fs.writeFileSync(path.join(root, 'real.txt'), 'one');
		fs.symlinkSync('real.txt', path.join(root, 'link.txt'));
		assert.equal(regularFile(root, 'real.txt'), path.join(root, 'real.txt'));
		assert.throws(() => regularFile(root, 'link.txt'), /non-regular path/);
		assert.equal(verifyFile(root, { path: 'real.txt', sha256: bytesHash('one') }), path.join(root, 'real.txt'));
		assert.throws(() => verifyFile(root, { path: 'real.txt', sha256: bytesHash('two') }), /file changed/);
		assert.throws(() => verifyFile(root, { path: 'real.txt', sha256: 'nope' }), /missing file hash/);
	});
});

test('argumentsFor rejects unknown, duplicate and missing flags', () => {
	assert.deepEqual(argumentsFor(['--a', '1'], ['--a']), { '--a': '1' });
	assert.throws(() => argumentsFor(['--b', '1'], ['--a']), /invalid flag/);
	assert.throws(() => argumentsFor(['--a', '1', '--a', '2'], ['--a']), /invalid flag/);
	assert.throws(() => argumentsFor([], ['--a']), /missing --a/);
});

test('title matching accepts the exact title or a carried @case tag and rejects prefixes', () => {
	assert.equal(titleMatches('renders', 'renders'), true);
	assert.equal(titleMatches('@ac AC-04 @case AC-04.1 renders', '@case AC-04.1'), true);
	assert.equal(titleMatches('@case AC-04.10 renders', '@case AC-04.1'), false);
	assert.equal(titleMatches('@case AC-04x1', '@case AC-04.1'), false);
	assert.equal(selectionGrep(['a.b', '@case AC-1.2']), 'a\\.b|@case AC-1\\.2(?=\\s|$)');
});

test('normalizedCase and runnerOutcome fail closed on unknown or mixed outcomes', () => {
	const entry = { file: 'f', caseKey: 'k', obligationIds: ['o'], capabilities: ['c'] };
	assert.equal(normalizedCase(entry, [{ outcome: 'passed' }, { outcome: 'failed' }]).outcome, 'failed');
	assert.deepEqual(normalizedCase(entry, [{ outcome: 'passed' }]).exercisedCapabilities, ['c']);
	assert.equal(normalizedCase(entry, []).outcome, 'not-run');
	assert.equal(runnerOutcome('timedOut'), 'incomplete');
	assert.throws(() => runnerOutcome('weird'), /unknown runner outcome/);
});

test('caseSelections binds cases to the package root and required capabilities', () => {
	const entry = { file: 'pkg/a.spec.ts', caseKey: 'k', kind: 'unit', runnerTitle: 't', capabilities: ['c'] };
	const request = (extra = {}) => ({ obligations: [{ obligationId: 'o', requiredCapabilities: ['c'], testCases: [{ file: 'pkg/a.spec.ts', caseKey: 'k' }], ...extra }] });
	assert.equal(caseSelections(request(), [entry], 'unit', 'pkg')[0].obligationIds[0], 'o');
	assert.throws(() => caseSelections(request(), [entry], 'unit', 'other'), /invalid case mapping/);
	assert.throws(() => caseSelections(request(), [entry], 'browser', 'pkg'), /ambiguous\/unknown case/);
	assert.throws(() => caseSelections(request({ requiredCapabilities: ['missing'] }), [entry], 'unit', 'pkg'), /unqualified capability/);
	assert.throws(() => caseSelections(request(), [], 'unit', 'pkg'), /empty case map/);
});

test('namespaceArgv binds only configured package files and stays inside the repository', () => {
	withRepo((root) => {
		fs.writeFileSync(path.join(root, 'pkg/package.json'), '{}');
		const args = namespaceArgv(acceptanceConfig(root), [process.execPath, 'x']);
		assert.ok(args.includes(path.join(root, 'pkg/src')));
		assert.ok(args.includes(path.join(root, 'api/openapi.json')));
		assert.ok(args.includes('--unshare-net'));
		assert.equal(args.at(-2), process.execPath);
		assert.equal(args[args.indexOf('--chdir') + 1], path.join(root, 'pkg'));
	});
});

test('the profile loader and namespaceArgv both refuse bind escapes: traversal, absolute, and symlink', () => {
	for (const bind of ['../outside', '/etc', 'a/../../b']) {
		withRepo((root) => assert.throws(() => acceptanceConfig(root), /HOST_PROFILE_INVALID/), { ...BLOCK, sandbox: { readOnlyBinds: [bind] } });
		withRepo((root) => assert.throws(
			() => namespaceArgv({ ...acceptanceConfig(root), readOnlyBinds: [bind] }, [process.execPath]),
			/unsafe relative path/,
		));
	}
});

test('a symlinked bind that leaves the package is refused by the loader and by namespaceArgv', () => {
	withRepo((root) => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-outside-'));
		try {
			const config = acceptanceConfig(root);
			fs.symlinkSync(outside, path.join(root, 'pkg/linked'));
			assert.throws(() => namespaceArgv({ ...config, readOnlyBinds: ['linked'] }, [process.execPath]), /bind escapes its base: linked/);
			fs.writeFileSync(path.join(root, '.agents/sdlc-host.json'), JSON.stringify({
				schemaVersion: '1.6.0', profileId: 'p', repositoryId: 'r', adapter: 'default',
				acceptanceEvidence: { ...BLOCK, sandbox: { readOnlyBinds: ['linked'] } },
			}));
			assert.throws(() => acceptanceConfig(root), /escapes rootDir via symlink/);
		} finally { fs.rmSync(outside, { recursive: true, force: true }); }
	});
});

test('namespaceArgv confines writable paths to the owned output and rejects relative executables', () => {
	withRepo((root) => {
		const config = acceptanceConfig(root);
		assert.ok(namespaceArgv(config, [process.execPath], { writable: ['ev/canary-v1/out'] }).includes('--bind'));
		assert.throws(() => namespaceArgv(config, [process.execPath], { writable: ['pkg/src'] }), /outside owned output/);
		assert.throws(() => namespaceArgv(config, ['node']), /non-absolute namespace command/);
		assert.throws(() => namespaceArgv(config, [process.execPath], { env: { API_TOKEN: 'x' } }), /unsafe namespace environment/);
	});
});

test('executeOwned bounds time and output and rejects unbounded or relative commands', async () => {
	assert.throws(() => executeOwned(['node'], { timeoutMs: 1000 }), /unbounded\/non-absolute/);
	assert.throws(() => executeOwned([process.execPath], {}), /unbounded\/non-absolute/);
	const ok = await executeOwned([process.execPath, '-e', 'process.stdout.write("hi")'], { timeoutMs: 10000, env: {} });
	assert.equal(ok.stdout, 'hi');
	await assert.rejects(executeOwned([process.execPath, '-e', 'setInterval(()=>{},1000)'], { timeoutMs: 300, env: {} }), /EvidenceTimeout/);
	await assert.rejects(
		executeOwned([process.execPath, '-e', 'process.stdout.write("x".repeat(5000))'], { timeoutMs: 10000, maxBytes: 100, env: {} }),
		/EvidenceOutputLimit/,
	);
});
