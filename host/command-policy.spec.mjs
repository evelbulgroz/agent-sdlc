import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	runCommandTool,
	validateCommandAllowlist,
	validateHostCommand,
} from '../execution/tool-commands.ts';
import { writeSyntheticHostProfile } from '../testing/cli-test-support.mjs';
import { validateCommand as validateFitnessAppCommand } from './fitness-app.ts';
import { loadHostProfile } from './host-profile.ts';
import { validateScriptCommand } from './script.ts';

const SCRIPT_PROFILE = Object.freeze({
	schemaVersion: '1.3.0',
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
});

test('@ac AC-04 @case AC-04.1 the script adapter allows node --test and rejects node --test foo.mjs and pnpm test with INVALID_INPUT', () => {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-cmd-policy-'));
	try {
		writeSyntheticHostProfile(tempRoot, SCRIPT_PROFILE);
		const loaded = loadHostProfile(tempRoot);
		assert.doesNotThrow(() =>
			validateScriptCommand('node', ['--test'], loaded),
		);
		const res = runCommandTool(
			{ command: 'node', args: ['--test'] },
			{
				worktreeDir: tempRoot,
				profile: loaded,
				execCli: () => 'ok',
			},
		);
		assert.equal(res.exitCode, 0);

		assert.throws(
			() => validateScriptCommand('node', ['--test', 'foo.mjs'], loaded),
			(error) => error.code === 'INVALID_INPUT',
		);
		assert.throws(
			() => validateScriptCommand('pnpm', ['test'], loaded),
			(error) => error.code === 'INVALID_INPUT',
		);
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

test('@ac AC-04 @case AC-04.2 the script adapter rejects arguments containing ;, &&, ||, backtick, $(), .git, or .agent-sdlc with INVALID_INPUT', () => {
	const dangerousArgs = [
		'--test;ls',
		'--test&&ls',
		'--test||ls',
		'--test`id`',
		'--test$(id)',
		'.git/config',
		'tools/.agent-sdlc/run',
	];
	for (const arg of dangerousArgs) {
		assert.throws(
			() =>
				validateScriptCommand('node', [arg], {
					commands: [['node', arg]],
				}),
			(error) => error.code === 'INVALID_INPUT',
			`expected rejection for ${arg}`,
		);
	}
});

test('@ac AC-04 @case AC-04.3 the fitness-app adapter allows pnpm --filter @acme/billing-service test and rejects git commit -m x', () => {
	assert.doesNotThrow(() =>
		validateFitnessAppCommand('pnpm', [
			'--filter',
			'@acme/billing-service',
			'test',
		]),
	);
	assert.equal(
		validateCommandAllowlist('pnpm', [
			'--filter',
			'@acme/billing-service',
			'test',
		]),
		true,
	);
	assert.throws(
		() => validateFitnessAppCommand('git', ['commit', '-m', 'x']),
		(error) => error.code === 'INVALID_INPUT',
	);
});

test('@ac AC-03 @case AC-03.1 validateHostCommand and runCommandTool allow configured verify.argv with SHA or HEAD in baseSha slots and allow defaulted npm test across script and fitness-app adapters', () => {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-cmd-verify-'));
	try {
		writeSyntheticHostProfile(tempRoot, SCRIPT_PROFILE);
		const scriptLoaded = loadHostProfile(tempRoot);
		const sha40 = 'a'.repeat(40);

		assert.equal(
			validateHostCommand('node', ['verify.mjs', sha40], { profile: scriptLoaded }),
			true,
		);
		assert.equal(
			validateHostCommand('node', ['verify.mjs', 'HEAD'], { profile: scriptLoaded }),
			true,
		);
		const scriptRes = runCommandTool(
			{ command: 'node', args: ['verify.mjs', sha40] },
			{ worktreeDir: tempRoot, profile: scriptLoaded, execCli: () => 'verified' },
		);
		assert.equal(scriptRes.exitCode, 0);

		writeSyntheticHostProfile(tempRoot, {
			schemaVersion: '1.3.0',
			profileId: 'default-verify-host',
			repositoryId: 'default-verify-host',
			adapter: 'fitness-app',
			verify: undefined,
		});
		const fitnessDefaulted = loadHostProfile(tempRoot);
		assert.deepEqual(fitnessDefaulted.verify.argv, ['npm', 'test']);
		assert.equal(
			validateHostCommand('npm', ['test'], { profile: fitnessDefaulted }),
			true,
		);
		const npmRes = runCommandTool(
			{ command: 'npm', args: ['test'] },
			{ worktreeDir: tempRoot, profile: fitnessDefaulted, execCli: () => 'npm test ok' },
		);
		assert.equal(npmRes.exitCode, 0);
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

test('@ac AC-03 @case AC-03.2 validateHostCommand rejects non-SHA baseSha tokens, extra arguments, arbitrary npm subcommands, and shell-injection tokens with INVALID_INPUT', () => {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-cmd-verify-reject-'));
	try {
		writeSyntheticHostProfile(tempRoot, SCRIPT_PROFILE);
		const scriptLoaded = loadHostProfile(tempRoot);
		const sha40 = 'b'.repeat(40);

		for (const [cmd, args] of [
			['node', ['verify.mjs', 'not-a-sha!']],
			['node', ['verify.mjs', `${sha40};id`]],
			['node', ['verify.mjs', sha40, 'extra-arg']],
			['npm', ['run', 'build']],
		]) {
			assert.throws(
				() => validateHostCommand(cmd, args, { profile: scriptLoaded }),
				(error) => error.code === 'INVALID_INPUT',
			);
		}

		writeSyntheticHostProfile(tempRoot, {
			schemaVersion: '1.3.0',
			profileId: 'default-verify-host',
			repositoryId: 'default-verify-host',
			adapter: 'fitness-app',
			verify: undefined,
		});
		const fitnessDefaulted = loadHostProfile(tempRoot);
		for (const [cmd, args] of [
			['npm', ['run', 'build']],
			['npm', ['test', '--watch']],
			['npm', ['test', '--', '--watch']],
		]) {
			assert.throws(
				() => validateHostCommand(cmd, args, { profile: fitnessDefaulted }),
				(error) => error.code === 'INVALID_INPUT',
			);
		}
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

