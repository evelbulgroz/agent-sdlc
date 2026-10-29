import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HOST_PROFILE_RELATIVE_PATH, loadHostProfile } from '../host/host-profile.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';

function withTempDir(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-repo-id-'));
	return Promise.resolve()
		.then(() => fn(dir))
		.finally(() => {
			fs.rmSync(dir, { recursive: true, force: true });
		});
}

function validHostProfile(overrides = {}) {
	return {
		schemaVersion: '1.2.0',
		profileId: 'fixture-host',
		repositoryId: 'fixture-host',
		adapter: 'script',
		stateDir: 'tools/.agent-sdlc',
		reviewDir: 'tools/.review',
		specDraftDir: 'docs/specs/drafts',
		verify: {
			argv: ['node', 'verify.mjs', '{baseSha}'],
			resultPath: 'tools/.verify/last.json',
			headField: 'head',
			require: { status: 'OK', canonical: true },
		},
		commands: [['node', '--test']],
		hydration: [],
		workspace: { directories: ['.'] },
		...overrides,
	};
}

test('@ac AC-06 @case AC-06.1 loadHostProfile rejects a profile missing repositoryId or with schemaVersion 1.0.0 with HOST_PROFILE_INVALID', async () => {
	await withTempDir(async (dir) => {
		const profilePath = path.join(dir, HOST_PROFILE_RELATIVE_PATH);
		fs.mkdirSync(path.dirname(profilePath), { recursive: true });

		const withoutRepoId = validHostProfile();
		delete withoutRepoId.repositoryId;
		fs.writeFileSync(profilePath, JSON.stringify(withoutRepoId, null, 2), 'utf8');
		assert.throws(
			() => loadHostProfile(dir),
			(err) => err?.code === 'INVALID_INPUT' && /^HOST_PROFILE_INVALID/.test(err.message),
		);

		const oldSchema = validHostProfile({ schemaVersion: '1.0.0' });
		fs.writeFileSync(profilePath, JSON.stringify(oldSchema, null, 2), 'utf8');
		assert.throws(
			() => loadHostProfile(dir),
			(err) => err?.code === 'INVALID_INPUT' && /^HOST_PROFILE_INVALID/.test(err.message),
		);
	});
});

test('@ac AC-06 @case AC-06.2 createDefaultAuthorizationEnvelope reads repositoryId from .agents/sdlc-host.json when omitted', async () => {
	await withTempDir(async (dir) => {
		const profilePath = path.join(dir, HOST_PROFILE_RELATIVE_PATH);
		fs.mkdirSync(path.dirname(profilePath), { recursive: true });
		fs.writeFileSync(
			profilePath,
			JSON.stringify(validHostProfile({ repositoryId: 'example-repo' }), null, 2),
			'utf8',
		);

		const envelope = createDefaultAuthorizationEnvelope({
			runId: '2026-10-24-repo-id-test',
			approvedSpecHash: 'a'.repeat(64),
			baseCommitSha: 'b'.repeat(40),
			allowedPackages: ['packages/engine'],
			allowedPathPrefixes: ['packages/engine'],
			rootDir: dir,
		});
		assert.equal(envelope.repositoryId, 'example-repo');
	});
});

const PACKAGE_ROOT = fs.existsSync(path.join(REPOSITORY_ROOT, 'packages/engine'))
	? path.join(REPOSITORY_ROOT, 'packages/engine')
	: REPOSITORY_ROOT;

test('@ac AC-06 @case AC-06.3 committed .agents/sdlc-host.json and fixture-host/profile.json carry expected schemaVersion and repositoryId', () => {
	const committed = loadHostProfile(REPOSITORY_ROOT);
	assert.equal(committed.schemaVersion, '1.3.0');
	assert.equal(committed.repositoryId, 'agent-sdlc');

	const fixtureRaw = JSON.parse(
		fs.readFileSync(
			path.join(PACKAGE_ROOT, 'testing/fixture-host/profile.json'),
			'utf8',
		),
	);
	assert.equal(fixtureRaw.schemaVersion, '1.2.0');
	assert.equal(fixtureRaw.repositoryId, 'fixture-host');
});

test('@ac AC-06 @case AC-06.4 policy/authorization.ts derives repositoryId dynamically without hardcoding', () => {
	const source = fs.readFileSync(
		path.join(PACKAGE_ROOT, 'policy/authorization.ts'),
		'utf8',
	);
	assert.equal(/repositoryId:\s*['"](?!resolvedRepositoryId)/.test(source), false);
});
