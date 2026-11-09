import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeSyntheticHostProfile } from '../testing/cli-test-support.ts';
import { loadHostProfile } from './host-profile.ts';
import {
	computePreparationPolicyHash,
	selectPreparationPlan,
	validatePreparationPolicy,
} from './verification-preparation.ts';
import { VerificationPreparationSchema } from './verification-preparation-schema.ts';

const BASE = {
	id: 'build-base',
	targetPackages: ['packages/consumer'],
	packagePath: 'packages/base',
	argv: ['pnpm', '--filter', '@fx/base', 'build'],
	outputPathPrefixes: ['dist'],
};
const CONSUMER = {
	id: 'build-consumer',
	targetPackages: ['packages/consumer'],
	packagePath: 'packages/consumer',
	argv: ['pnpm', '--filter', '@fx/consumer', 'build'],
	outputPathPrefixes: ['dist/'],
	dependsOn: ['build-base'],
};

function withWorkspace(builds, fn) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-prep-host-'));
	try {
		for (const name of ['base', 'consumer', 'other']) {
			const dir = path.join(root, 'packages', name);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				path.join(dir, 'package.json'),
				JSON.stringify({ name: `@fx/${name}`, scripts: { build: 'tsc', test: 'node --test' } }),
			);
		}
		writeSyntheticHostProfile(root, { verificationPreparation: { builds } });
		return fn(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function issuesOf(builds) {
	const parsed = VerificationPreparationSchema.safeParse({ builds });
	return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

test('@ac AC-01 @case AC-01.1 matching target selects the ordered dependency closure', () => {
	withWorkspace([CONSUMER, BASE], (root) => {
		const profile = loadHostProfile(root);
		validatePreparationPolicy({ profile, rootDir: root });
		const plan = selectPreparationPlan(profile.verificationPreparation, ['packages/consumer/']);
		assert.deepEqual(
			plan.steps.map((step) => [step.id, step.argv.join(' '), step.outputPathPrefixes.join(',')]),
			[
				['build-base', 'pnpm --filter @fx/base build', 'dist'],
				['build-consumer', 'pnpm --filter @fx/consumer build', 'dist'],
			],
		);
		assert.match(plan.selectionHash, /^[0-9a-f]{64}$/);
	});
});

test('@ac AC-01 @case AC-01.1 a target matching only the dependent still pulls in its prerequisite first', () => {
	const consumerOnly = { ...CONSUMER, targetPackages: ['packages/app'] };
	const base = { ...BASE, targetPackages: ['packages/unrelated'] };
	const plan = selectPreparationPlan({ builds: [consumerOnly, base] }, ['packages/app']);
	assert.deepEqual(plan.steps.map((step) => step.id), ['build-base', 'build-consumer']);
});

test('@ac AC-01 @case AC-01.2 unrelated target, absent config, and empty builds select no builds', () => {
	const config = { builds: [BASE, CONSUMER] };
	for (const [cfg, targets] of [[config, ['packages/other']], [undefined, ['packages/consumer']], [{ builds: [] }, ['packages/consumer']], [config, []]]) {
		const plan = selectPreparationPlan(cfg, targets);
		assert.deepEqual(plan.steps, []);
		assert.equal(plan.selectionHash, null);
	}
	assert.equal(computePreparationPolicyHash(undefined), null);
	assert.equal(computePreparationPolicyHash({ builds: [] }), null);
});

test('@ac AC-01 @case AC-01.3 duplicate ids and unresolved dependencies are rejected', () => {
	assert.ok(issuesOf([BASE, { ...BASE }]).some((m) => m.includes("duplicate build id 'build-base'")));
	assert.ok(issuesOf([CONSUMER]).some((m) => m.includes("unresolved dependency 'build-base'")));
	withWorkspace([CONSUMER], (root) => {
		assert.throws(() => loadHostProfile(root), /HOST_PROFILE_INVALID: .*unresolved dependency 'build-base'/);
	});
});

test('@ac AC-01 @case AC-01.4 dependency cycles, including self-dependency, are rejected', () => {
	const a = { ...BASE, id: 'a', dependsOn: ['b'] };
	const b = { ...BASE, id: 'b', dependsOn: ['a'] };
	assert.ok(issuesOf([a, b]).some((m) => m.includes('dependency cycle: a -> b -> a')));
	assert.ok(issuesOf([{ ...BASE, dependsOn: ['build-base'] }]).some((m) => m.includes('dependency cycle')));
});

test('@ac AC-01 @case AC-01.5 traversal, absolute paths and package-wide outputs are rejected', () => {
	for (const outputs of [['../base/dist'], ['/tmp/dist'], ['.'], ['dist/../../x'], ['C:/dist']]) {
		assert.ok(issuesOf([{ ...BASE, outputPathPrefixes: outputs }]).length > 0, `outputs ${outputs}`);
	}
	assert.ok(issuesOf([{ ...BASE, packagePath: '../outside' }]).length > 0);
	assert.ok(issuesOf([{ ...BASE, targetPackages: ['/abs'] }]).length > 0);
	assert.ok(issuesOf([{ ...BASE, argv: [] }]).length > 0);
	assert.ok(issuesOf([{ ...BASE, targetPackages: [] }]).length > 0);
	assert.ok(issuesOf([{ ...BASE, outputPathPrefixes: [] }]).length > 0);
	assert.ok(issuesOf([{ ...BASE, extra: true }]).length > 0);
});

test('@ac AC-01 @case AC-01.5 output paths escaping through a symlink are rejected at profile load', () => {
	withWorkspace([BASE], (root) => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-prep-outside-'));
		try {
			fs.symlinkSync(outside, path.join(root, 'packages/base/dist'));
			assert.throws(() => loadHostProfile(root), /escapes rootDir via symlink/);
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});
});

test('@ac AC-01 @case AC-01.5 a packagePath that is not a workspace package is rejected', () => {
	withWorkspace([{ ...BASE, packagePath: 'tools/base' }], (root) => {
		assert.throws(
			() => validatePreparationPolicy({ profile: loadHostProfile(root), rootDir: root }),
			/VERIFICATION_PREPARATION_INVALID: build 'build-base' packagePath 'tools\/base' is not a workspace package/,
		);
	});
});

test('@ac AC-01 @case AC-01.6 argv rejected by the existing command policy is rejected', () => {
	const cases = [
		['npm', 'run', 'build'],
		['pnpm', '--filter', '@fx/base', 'publish'],
		['pnpm', '--filter', '@fx/consumer', 'build'],
		['pnpm', '--filter', '@fx/base...', 'build'],
		['pnpm', 'run', 'build:all'],
		['pnpm', '--filter', '@fx/base', 'build;rm'],
	];
	for (const argv of cases) {
		withWorkspace([{ ...BASE, argv }], (root) => {
			assert.throws(
				() => validatePreparationPolicy({ profile: loadHostProfile(root), rootDir: root }),
				/VERIFICATION_PREPARATION_INVALID: build 'build-base' argv is not allowlisted/,
				argv.join(' '),
			);
		});
	}
});

test('@ac AC-01 @case AC-01.6 an exact host repositoryScripts entry is accepted for preparation', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-prep-host-'));
	try {
		fs.mkdirSync(path.join(root, 'packages/base'), { recursive: true });
		fs.writeFileSync(path.join(root, 'packages/base/package.json'), JSON.stringify({ name: '@fx/base' }));
		writeSyntheticHostProfile(root, {
			commandPolicy: { repositoryScripts: [['pnpm', 'run', 'build:base']] },
			verificationPreparation: { builds: [{ ...BASE, argv: ['pnpm', 'run', 'build:base'] }] },
		});
		validatePreparationPolicy({ profile: loadHostProfile(root), rootDir: root });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('preparation policy hash is order- and formatting-insensitive but changes with argv or output scope', () => {
	const hash = computePreparationPolicyHash({ builds: [BASE, CONSUMER] });
	assert.equal(computePreparationPolicyHash({ builds: [CONSUMER, { ...BASE, outputPathPrefixes: ['dist/', 'dist'] }] }), hash);
	assert.notEqual(computePreparationPolicyHash({ builds: [{ ...BASE, argv: [...BASE.argv, '--x'] }, CONSUMER] }), hash);
	assert.notEqual(computePreparationPolicyHash({ builds: [{ ...BASE, outputPathPrefixes: ['lib'] }, CONSUMER] }), hash);
});

test('verificationPreparation is rejected on legacy 1.2.0 host profiles', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-prep-host-'));
	try {
		const legacy = {
			schemaVersion: '1.2.0', profileId: 'p', repositoryId: 'r', adapter: 'default',
			stateDir: 's', reviewDir: 'r', specDraftDir: 'd', verificationPreparation: { builds: [] },
		};
		fs.mkdirSync(path.join(root, '.agents'));
		fs.writeFileSync(path.join(root, '.agents/sdlc-host.json'), JSON.stringify(legacy));
		assert.throws(() => loadHostProfile(root), /verificationPreparation' requires schemaVersion '1.3.0'/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
