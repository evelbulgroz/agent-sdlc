import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { writeSyntheticHostProfile } from '../testing/cli-test-support.mjs';
import { writeSyntheticHostProfile as writeShellSyntheticHostProfile } from '../testing/shell-driver-support.mjs';
import { HOST_PROFILE_RELATIVE_PATH, loadHostProfile } from './host-profile.ts';

function withTempRoot(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-host-profile-'));
	return Promise.resolve()
		.then(() => fn(dir))
		.finally(() => {
			fs.rmSync(dir, { recursive: true, force: true });
		});
}

test('@ac AC-04 @case AC-04.1 a synthetic 1.3.0 host profile in a temporary directory selects default and declares declarative hydration, workspace, prompts, and learnings', async () => {
	await withTempRoot(async (tempRoot) => {
		writeSyntheticHostProfile(tempRoot, {
			prompts: {
				preset: 'default',
				roleAddendaDir: '.agents/workflows/prompts',
				rubricAddendaDir: '.agents/review-rubrics',
				pathScopedRules: [
					{
						id: 'pkg-rule',
						pathPrefixes: ['packages'],
						roles: ['implementer'],
						addendaFile: '.agents/workflows/prompts/addenda/pkg-rule.md',
					},
				],
			},
		});
		const profile = loadHostProfile(tempRoot);
		assert.equal(profile.schemaVersion, '1.3.0');
		assert.equal(profile.adapter, 'default');
		assert.equal(profile.profileId, 'default-host');
		assert.equal(profile.stateDir, 'tools/.agent-sdlc');
		assert.equal(profile.reviewDir, 'tools/.review');
		assert.equal(profile.specDraftDir, 'docs/specs/drafts');
		assert.deepEqual(profile.verify.argv, [
			'pnpm',
			'run',
			'agent:preflight',
			'--',
			'--base',
			'{baseSha}',
		]);
		assert.equal(profile.verify.resultPath, 'tools/.agent-preflight-last.json');
		assert.equal(profile.verify.require.status, 'OK');
		assert.equal(profile.verify.require.canonical, true);
		assert.equal(profile.verify.headField, 'gitHeadSha');

		const raw = JSON.parse(
			fs.readFileSync(path.join(tempRoot, HOST_PROFILE_RELATIVE_PATH), 'utf8'),
		);
		assert.equal('hydration' in raw, true);
		assert.equal('commands' in raw, false);
		assert.equal('workspace' in raw, true);
		assert.equal(profile.prompts?.preset, 'default');
		assert.equal(profile.prompts?.roleAddendaDir, '.agents/workflows/prompts');
		assert.equal(profile.prompts?.rubricAddendaDir, '.agents/review-rubrics');
		assert.equal(profile.prompts?.pathScopedRules?.length, 1);
	});
});

const PACKAGE_ROOT = fs.existsSync(path.join(REPOSITORY_ROOT, 'packages/agent-sdlc'))
	? path.join(REPOSITORY_ROOT, 'packages/agent-sdlc')
	: REPOSITORY_ROOT;

test('@ac AC-04 @case AC-04.2 none of the 6 host and CLI test support/spec files contains forbidden service names', () => {
	const files = [
		'packages/agent-sdlc/testing/cli-test-support.mjs',
		'packages/agent-sdlc/testing/shell-driver-support.mjs',
		'packages/agent-sdlc/host/default-profile.spec.mjs',
		'packages/agent-sdlc/host/command-policy.spec.mjs',
		'packages/agent-sdlc/host/workspace.spec.mjs',
		'packages/agent-sdlc/host/hydration.spec.mjs',
	];
	const forbiddenServicePath = `${'apps/services'}/${'conditioning'}`;
	const forbiddenServicePkg = `${'@' + 'conditioning'}/${'service'}`;
	for (const relPath of files) {
		const targetPath = fs.existsSync(path.join(REPOSITORY_ROOT, relPath))
			? path.join(REPOSITORY_ROOT, relPath)
			: path.join(PACKAGE_ROOT, relPath.replace(/^packages\/agent-sdlc\//, ''));
		const text = fs.readFileSync(targetPath, 'utf8');
		assert.equal(
			text.includes(forbiddenServicePath),
			false,
			`${relPath} must not contain ${forbiddenServicePath}`,
		);
		assert.equal(
			text.includes(forbiddenServicePkg),
			false,
			`${relPath} must not contain ${forbiddenServicePkg}`,
		);
	}
});

test('@ac AC-05 @case AC-05.1 engine default prompts and rubrics contain zero host-specific domain literals', () => {
	const defaultsDirs = [
		path.join(PACKAGE_ROOT, 'roles/defaults'),
		path.join(PACKAGE_ROOT, 'review/defaults'),
	];
	const forbidden = new RegExp(
		`${'conditioning'}|NestJS|${'docs'}/${'handbook'}/`,
		'i',
	);
	function scan(dir) {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				scan(full);
			} else if (entry.name.endsWith('.md') || entry.name.endsWith('.json')) {
				const text = fs.readFileSync(full, 'utf8');
				assert.equal(forbidden.test(text), false, `Forbidden domain literal in ${full}`);
			}
		}
	}
	for (const d of defaultsDirs) scan(d);
});

test('@ac AC-01 @case AC-01.1 raw .agents/sdlc-host.json at REPOSITORY_ROOT omits verify.require and verify.headField while loadHostProfile resolves both 1.3.0 defaults', () => {
	const raw = JSON.parse(
		fs.readFileSync(path.join(REPOSITORY_ROOT, HOST_PROFILE_RELATIVE_PATH), 'utf8'),
	);
	assert.deepEqual(raw.verify, {
		argv: ['pnpm', 'run', 'agent:preflight', '--', '--base', '{baseSha}'],
		resultPath: 'tools/.agent-preflight-last.json',
	});
	assert.equal(raw.verify.require, undefined);
	assert.equal(raw.verify.headField, undefined);

	const loaded = loadHostProfile(REPOSITORY_ROOT);
	assert.deepEqual(loaded.verify, {
		argv: ['pnpm', 'run', 'agent:preflight', '--', '--base', '{baseSha}'],
		resultPath: 'tools/.agent-preflight-last.json',
		require: { status: 'OK', canonical: true },
		headField: 'gitHeadSha',
	});
});

test('@ac AC-01 @case AC-01.2 writeSyntheticHostProfile in cli-test-support.mjs and shell-driver-support.mjs omits raw verify.require and verify.headField and loadHostProfile resolves both defaults', async () => {
	for (const writer of [writeSyntheticHostProfile, writeShellSyntheticHostProfile]) {
		await withTempRoot(async (tempRoot) => {
			writer(tempRoot);
			const raw = JSON.parse(
				fs.readFileSync(path.join(tempRoot, HOST_PROFILE_RELATIVE_PATH), 'utf8'),
			);
			assert.equal(raw.verify.require, undefined);
			assert.equal(raw.verify.headField, undefined);

			const loaded = loadHostProfile(tempRoot);
			assert.deepEqual(loaded.verify.require, { status: 'OK', canonical: true });
			assert.equal(loaded.verify.headField, 'gitHeadSha');
		});
	}
});

