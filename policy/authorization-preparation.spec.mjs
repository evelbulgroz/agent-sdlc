import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeSyntheticHostProfile } from '../testing/cli-test-support.ts';
import { createDefaultAuthorizationEnvelope, validateAuthorizationEnvelope } from './authorization.ts';
import { sha256, validateRunAuthorization } from './contracts.ts';

const BUILDS = [
	{
		id: 'build-base',
		targetPackages: ['packages/consumer'],
		packagePath: 'packages/base',
		argv: ['pnpm', '--filter', '@fx/base', 'build'],
		outputPathPrefixes: ['dist'],
	},
	{
		id: 'build-consumer',
		targetPackages: ['packages/consumer'],
		packagePath: 'packages/consumer',
		argv: ['pnpm', '--filter', '@fx/consumer', 'build'],
		outputPathPrefixes: ['dist'],
		dependsOn: ['build-base'],
	},
];

const ENVELOPE_INPUT = {
	runId: '2026-11-01-prep-auth-test',
	approvedSpecHash: 'a'.repeat(64),
	baseCommitSha: 'b'.repeat(40),
	repositoryId: 'fixture-repo',
	allowedPackages: ['packages/consumer'],
	allowedPathPrefixes: ['packages/consumer/'],
};

function withHost(builds, fn) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-prep-auth-'));
	try {
		for (const name of ['base', 'consumer']) {
			fs.mkdirSync(path.join(root, 'packages', name), { recursive: true });
			fs.writeFileSync(
				path.join(root, 'packages', name, 'package.json'),
				JSON.stringify({ name: `@fx/${name}`, scripts: { build: 'tsc', test: 'node --test' } }),
			);
		}
		const write = (next) =>
			writeSyntheticHostProfile(root, next === undefined ? {} : { verificationPreparation: { builds: next } });
		write(builds);
		return fn(root, write);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test('@ac AC-02 @case AC-02.1 identical normalized preparation policy validates', () => {
	withHost(BUILDS, (root, write) => {
		const envelope = createDefaultAuthorizationEnvelope({ ...ENVELOPE_INPUT, rootDir: root });
		assert.match(envelope.preparationPolicyHash, /^[0-9a-f]{64}$/);
		write([...BUILDS].reverse().map((build) => ({ ...build, outputPathPrefixes: ['dist/'] })));
		const validated = validateAuthorizationEnvelope(envelope, { rootDir: root });
		assert.equal(validated.preparationPolicyHash, envelope.preparationPolicyHash);
	});
});

test('@ac AC-02 @case AC-02.2 changed argv or output scope fails authorization validation', () => {
	withHost(BUILDS, (root, write) => {
		const envelope = createDefaultAuthorizationEnvelope({ ...ENVELOPE_INPUT, rootDir: root });
		for (const changed of [
			[{ ...BUILDS[0], argv: ['pnpm', '--filter', '@fx/base', 'typecheck'] }, BUILDS[1]],
			[{ ...BUILDS[0], outputPathPrefixes: ['dist', 'lib'] }, BUILDS[1]],
			[{ ...BUILDS[0], targetPackages: ['packages/base'] }, BUILDS[1]],
			[BUILDS[0]],
		]) {
			write(changed);
			assert.throws(
				() => validateAuthorizationEnvelope(envelope, { rootDir: root }),
				(error) =>
					error.code === 'AUTHORIZATION_INVALID' &&
					/policy differs from the authorized binding; reauthorize/.test(error.message),
			);
		}
	});
});

test('@ac AC-02 @case AC-02.4 legacy envelope fails closed when the host declares preparation', () => {
	let legacy;
	withHost(undefined, (root) => {
		legacy = createDefaultAuthorizationEnvelope({ ...ENVELOPE_INPUT, rootDir: root });
	});
	assert.equal('preparationPolicyHash' in legacy, false);
	withHost(BUILDS, (root) => {
		assert.throws(
			() => validateAuthorizationEnvelope(legacy, { rootDir: root }),
			(error) => error.code === 'AUTHORIZATION_INVALID' && /no preparation binding; reauthorize/.test(error.message),
		);
	});
});

test('@ac AC-02 @case AC-02.5 hosts without preparation keep the previous envelope shape and plan policy hash', () => {
	for (const builds of [undefined, []]) {
		withHost(builds, (root) => {
			const envelope = createDefaultAuthorizationEnvelope({ ...ENVELOPE_INPUT, rootDir: root });
			assert.equal('preparationPolicyHash' in envelope, false);
			const legacyHash = sha256({
				runId: ENVELOPE_INPUT.runId,
				approvedSpecHash: ENVELOPE_INPUT.approvedSpecHash,
				taskManifestHash: null,
				baseCommitSha: ENVELOPE_INPUT.baseCommitSha,
				allowedPackages: ENVELOPE_INPUT.allowedPackages,
				allowedPathPrefixes: ENVELOPE_INPUT.allowedPathPrefixes,
				maxSemanticRepairs: 2,
				createBranch: false,
				createLocalCommits: false,
				push: false,
				openPullRequest: false,
				targetBranch: null,
			});
			assert.equal(envelope.approvedPlanPolicyHash, legacyHash);
			validateAuthorizationEnvelope(envelope, { rootDir: root });
		});
	}
});

test('@ac AC-02 @case AC-02.5 a stale binding is rejected after the host removes preparation', () => {
	withHost(BUILDS, (root, write) => {
		const envelope = createDefaultAuthorizationEnvelope({ ...ENVELOPE_INPUT, rootDir: root });
		write(undefined);
		assert.throws(() => validateAuthorizationEnvelope(envelope, { rootDir: root }), /reauthorize/);
	});
});

test('@ac AC-02 @case AC-02.6 preparation packages are not added to authored-source scope', () => {
	withHost(BUILDS, (root) => {
		const envelope = createDefaultAuthorizationEnvelope({ ...ENVELOPE_INPUT, rootDir: root });
		assert.deepEqual(envelope.allowedPackages, ['packages/consumer']);
		assert.deepEqual(envelope.allowedPathPrefixes, ['packages/consumer/']);
		assert.equal(
			envelope.allowedPathPrefixes.some((prefix) => prefix.startsWith('packages/base')),
			false,
		);
	});
});

test('preparation binding changes the plan policy hash and must be a well-formed hash', () => {
	let withPrep;
	let withoutPrep;
	withHost(BUILDS, (root) => {
		withPrep = createDefaultAuthorizationEnvelope({ ...ENVELOPE_INPUT, rootDir: root });
	});
	withHost(undefined, (root) => {
		withoutPrep = createDefaultAuthorizationEnvelope({ ...ENVELOPE_INPUT, rootDir: root });
	});
	assert.notEqual(withPrep.approvedPlanPolicyHash, withoutPrep.approvedPlanPolicyHash);
	assert.throws(
		() => validateRunAuthorization({ ...withPrep, preparationPolicyHash: 'not-a-hash' }),
		/preparationPolicyHash/,
	);
	assert.equal('preparationPolicyHash' in validateRunAuthorization({ ...withoutPrep, preparationPolicyHash: null }), false);
});

test('authorization rejects a declared preparation build whose argv the command policy forbids', () => {
	withHost([{ ...BUILDS[0], argv: ['pnpm', '--filter', '@fx/base', 'publish'] }], (root) => {
		assert.throws(
			() => createDefaultAuthorizationEnvelope({ ...ENVELOPE_INPUT, rootDir: root }),
			/VERIFICATION_PREPARATION_INVALID: build 'build-base' argv is not allowlisted/,
		);
	});
});
