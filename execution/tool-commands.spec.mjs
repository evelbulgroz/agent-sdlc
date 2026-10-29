import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveCommandPolicy } from '../host/command-policy.ts';
import {
	readFileTool,
} from './tool-read.ts';
import {
	grepTool,
} from './tool-search.ts';
import {
	writeFileTool,
} from './tool-mutations.ts';
import {
	MAX_COMMAND_OUTPUT_CHARS,
	COMMAND_MAX_BUFFER_BYTES,
	runCommandTool,
	truncateCommandOutput,
	validateCommandAllowlist,
	validateHostCommand,
} from './tool-commands.ts';

function createTempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-tools-test-'));
}

test('validateCommandAllowlist and runCommandTool enforce security constraints', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = tempDir;
		const allowedPackages = ['services/billing'];

		// Allowed command
		assert.ok(
			validateCommandAllowlist(
				'pnpm',
				['--filter', 'services/billing', 'test'],
				allowedPackages,
			),
		);
		assert.ok(
			validateCommandAllowlist(
				'pnpm',
				['--filter', 'services/billing', 'run', 'build:contracts'],
				allowedPackages,
			),
		);
		assert.ok(
			validateCommandAllowlist(
				'pnpm',
				[
					'--filter',
					'services/billing',
					'test',
					'--',
					'src/feature.spec.ts',
				],
				allowedPackages,
			),
		);
		assert.ok(
			validateCommandAllowlist('pnpm', ['run', 'test:unit'], allowedPackages),
		);
		// Removed engine-baked verbs are rejected unless the host declares them.
		for (const legacy of [['run', 'agent:test-engine'], ['run', 'agent:verify', '--', '--base', '6c277953d732ed447f89035d51716ec0bab56b3f']]) {
			assert.throws(
				() => validateCommandAllowlist('pnpm', legacy, allowedPackages),
				(err) => err.code === 'INVALID_INPUT',
			);
		}
		assert.ok(
			validateCommandAllowlist(
				'pnpm',
				[
					'--filter',
					'services/billing',
					'test',
					'--',
					'src/feature.spec.ts',
					'--reporter=json',
				],
				allowedPackages,
			),
		);
		assert.ok(
			validateCommandAllowlist(
				'pnpm',
				[
					'--filter',
					'services/billing',
					'run',
					'test:unit',
					'src/feature.spec.ts',
				],
				allowedPackages,
			),
		);
		assert.throws(
			() =>
				validateCommandAllowlist(
					'pnpm',
					['--filter', 'services/billing', 'test', '--watch'],
					allowedPackages,
				),
			(err) => err.code === 'INVALID_INPUT',
		);
		assert.throws(
			() =>
				validateCommandAllowlist(
					'pnpm',
					[
						'--filter',
						'services/billing',
						'test',
						'--',
						'../outside.spec.ts',
						'--reporter=json',
					],
					allowedPackages,
				),
			(err) => err.code === 'INVALID_INPUT',
		);

		// Disallowed commands
		assert.throws(
			() => validateCommandAllowlist('git', ['status'], allowedPackages),
			(err) => err.code === 'INVALID_INPUT',
		);
		assert.throws(
			() => validateCommandAllowlist('pnpm', ['install'], allowedPackages),
			(err) => err.code === 'INVALID_INPUT',
		);
		assert.throws(
			() =>
				validateCommandAllowlist(
					'pnpm',
					['--filter', 'services/auth', 'test'],
					allowedPackages,
				),
			(err) => err.code === 'INVALID_INPUT',
		);
		assert.throws(
			() =>
				validateCommandAllowlist(
					'pnpm',
					['--filter', 'services/billing', 'test; rm -rf /'],
					allowedPackages,
				),
			(err) => err.code === 'INVALID_INPUT',
		);

		// Mock execution
		let executed = null;
		const mockExec = (cmd, args, opts) => {
			executed = { cmd, args, opts };
			return 'mock stdout';
		};

		const res = runCommandTool(
			{ command: 'pnpm', args: ['--filter', 'services/billing', 'test'] },
			{ worktreeDir, allowedPackages, execCli: mockExec },
		);

		assert.equal(res.exitCode, 0);
		assert.equal(res.stdout, 'mock stdout');
		assert.equal(executed.cmd, 'pnpm');
		assert.deepEqual(executed.args, ['--filter', 'services/billing', 'test']);
		assert.equal(executed.opts.maxBuffer, COMMAND_MAX_BUFFER_BYTES);
		const failingExec = () => {
			const err = new Error('Test failed');
			err.status = 1;
			err.stdout = 'Failed tests: 1';
			err.stderr = 'ERR';
			throw err;
		};

		const failRes = runCommandTool(
			{ command: 'pnpm', args: ['--filter', 'services/billing', 'test'] },
			{ worktreeDir, allowedPackages, execCli: failingExec },
		);
		assert.equal(failRes.exitCode, 1);
		assert.equal(failRes.stdout, 'Failed tests: 1');

		// Oversized output truncation
		const hugeStdout = 'START_MARKER\n' + 'x'.repeat(250_000) + '\nEND_MARKER';
		const hugeExec = () => hugeStdout;
		const truncatedRes = runCommandTool(
			{ command: 'pnpm', args: ['--filter', 'services/billing', 'test'] },
			{ worktreeDir, allowedPackages, execCli: hugeExec },
		);
		assert.equal(truncatedRes.exitCode, 0);
		assert.ok(truncatedRes.stdout.length <= MAX_COMMAND_OUTPUT_CHARS);
		assert.ok(truncatedRes.stdout.startsWith('START_MARKER'));
		assert.ok(truncatedRes.stdout.endsWith('END_MARKER'));
		assert.ok(truncatedRes.stdout.includes('output truncated:'));
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-01 AC-03 preserves parsed TAP evidence before command output truncation', () => {
	const result = runCommandTool(
		{
			command: 'pnpm',
			args: ['run', 'test:unit'],
		},
		{
			worktreeDir: process.cwd(),
			execCli: () =>
				[
					'TAP version 13',
					'# Subtest: executed behavior @ac AC-01',
					'ok 1 - executed behavior @ac AC-01',
					'x'.repeat(120_000),
				].join('\n'),
		},
	);
	assert.ok(result.stdout.length <= 100_000);
	assert.equal(result.testExecutionEvidence.format, 'tap');
	assert.deepEqual(result.testExecutionEvidence.passedTitles, [
		'executed behavior @ac AC-01',
	]);
});

test('truncateCommandOutput preserves head and tail and inserts omission marker', () => {
	assert.equal(truncateCommandOutput('short'), 'short');
	assert.equal(truncateCommandOutput(''), '');

	const input = 'HEAD' + 'a'.repeat(200) + 'TAIL';
	const truncated = truncateCommandOutput(input, 150);
	assert.ok(truncated.length <= 150);
	assert.ok(truncated.startsWith('HEAD'));
	assert.ok(truncated.endsWith('TAIL'));
	assert.ok(truncated.includes('output truncated:'));
});

test('validateCommandAllowlist enforces exact package match, no dependency expansion, and blocks unfiltered build/test', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = tempDir;
		const allowedPackages = ['services/billing'];

		// Create package.json in worktree to test package name resolution
		const pkgDir = path.join(worktreeDir, 'services/billing');
		fs.mkdirSync(pkgDir, { recursive: true });
		fs.writeFileSync(
			path.join(pkgDir, 'package.json'),
			JSON.stringify({ name: '@fixture/billing-service' }),
		);

		// The repository-level unit suite is the only unfiltered role command by default.
		assert.ok(
			validateCommandAllowlist(
				'pnpm',
				['run', 'test:unit'],
				allowedPackages,
				worktreeDir,
			),
		);

		// Unfiltered build and test are forbidden
		assert.throws(
			() => validateCommandAllowlist('pnpm', ['run', 'build'], allowedPackages, worktreeDir),
			(err) => err.code === 'INVALID_INPUT' && err.message.includes('Unfiltered'),
		);
		assert.throws(
			() => validateCommandAllowlist('pnpm', ['run', 'test'], allowedPackages, worktreeDir),
			(err) => err.code === 'INVALID_INPUT' && err.message.includes('Unfiltered'),
		);

		// Reject '...' dependency expansion
		assert.throws(
			() =>
				validateCommandAllowlist(
					'pnpm',
					['--filter', 'services/billing...', 'test'],
					allowedPackages,
					worktreeDir,
				),
			(err) => err.code === 'INVALID_INPUT' && err.message.includes('dependency expansion'),
		);

		// Exact package matching (reject partial path substring matching)
		assert.throws(
			() =>
				validateCommandAllowlist(
					'pnpm',
					['--filter', 'apps', 'test'],
					allowedPackages,
					worktreeDir,
				),
			(err) => err.code === 'INVALID_INPUT' && err.message.includes('not within authorized packages'),
		);
		assert.throws(
			() =>
				validateCommandAllowlist(
					'pnpm',
					['--filter', 'services', 'test'],
					allowedPackages,
					worktreeDir,
				),
			(err) => err.code === 'INVALID_INPUT' && err.message.includes('not within authorized packages'),
		);

		// Package name resolution from package.json succeeds
		assert.ok(
			validateCommandAllowlist(
				'pnpm',
				['--filter', '@fixture/billing-service', 'test'],
				allowedPackages,
				worktreeDir,
			),
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-08 @case AC-08.1 @case AC-08.2 @case AC-08.3 @case AC-08.4 @case AC-08.5 containment and the command allowlist reject unauthorized calls', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = path.join(tempDir, 'worktree');
		const target = path.join(worktreeDir, 'src/kept.txt');
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, 'kept\n');
		assert.throws(
			() =>
				writeFileTool(
					{ path: 'src/kept.txt', content: 'changed\n' },
					{ worktreeDir, allowedPathPrefixes: ['other'] },
				),
			(error) => error.code === 'PATH_CONTAINMENT_VIOLATION',
		);
		assert.equal(fs.readFileSync(target, 'utf8'), 'kept\n');
		assert.throws(
			() => readFileTool({ path: '../outside' }, { worktreeDir, pageOverflow: true }),
			(error) => error.code === 'PATH_CONTAINMENT_VIOLATION',
		);
		let started = false;
		assert.throws(
			() =>
				runCommandTool(
					{ command: 'node', args: ['-e', '1'] },
					{
						worktreeDir,
						execCli: () => {
							started = true;
							return '';
						},
					},
				),
			(error) => error.code === 'INVALID_INPUT',
		);
		assert.equal(started, false);
		assert.throws(
			() => grepTool({ path: '../outside', pattern: 'x' }, { worktreeDir }),
			(error) => error.code === 'PATH_CONTAINMENT_VIOLATION',
		);
		assert.throws(
			() => grepTool({ path: 'src/kept.txt', pattern: '(' }, { worktreeDir }),
			(error) => error.code === 'INVALID_INPUT',
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('validateCommandAllowlist accepts contract verbs by default and unfiltered scripts only when the host declares them', () => {
	const allowedPackages = ['services/authentication'];
	assert.equal(
		validateCommandAllowlist(
			'pnpm',
			['--filter', 'services/authentication', 'run', 'check:contract-drift'],
			allowedPackages,
		),
		true,
	);
	assert.equal(
		validateCommandAllowlist(
			'pnpm',
			['--filter', 'services/authentication', 'run', 'build:contracts'],
			allowedPackages,
		),
		true,
	);
	assert.throws(
		() => validateCommandAllowlist('pnpm', ['run', 'quality:affected'], allowedPackages),
		(error) => error.code === 'INVALID_INPUT' && /commandPolicy/.test(error.message),
	);
	const declared = resolveCommandPolicy({ commandPolicy: { repositoryScripts: [['pnpm', 'run', 'quality:affected']] } });
	assert.equal(validateCommandAllowlist('pnpm', ['run', 'quality:affected'], allowedPackages, null, declared), true);
	assert.throws(
		() => validateCommandAllowlist('pnpm', ['run', 'quality:affected', '--', 'x'], allowedPackages, null, declared),
		(error) => error.code === 'INVALID_INPUT',
	);
	assert.throws(
		() => validateCommandAllowlist('pnpm', ['run', 'quality:affected;rm'], allowedPackages, null, declared),
		(error) => error.code === 'INVALID_INPUT',
	);
	const narrowed = resolveCommandPolicy({ commandPolicy: { allowedVerbs: ['test'] } });
	assert.throws(
		() => validateCommandAllowlist('pnpm', ['--filter', 'services/authentication', 'run', 'build:contracts'], allowedPackages, null, narrowed),
		(error) => error.code === 'INVALID_INPUT' && /not allowlisted/.test(error.message),
	);
	assert.throws(
		() => validateCommandAllowlist('pnpm', ['run', 'quality:full'], allowedPackages),
		(error) => error.code === 'INVALID_INPUT' && /Unfiltered/.test(error.message),
	);
	assert.throws(
		() => validateCommandAllowlist('pnpm', ['run', 'quality:duplicates'], allowedPackages),
		(error) => error.code === 'INVALID_INPUT',
	);
	assert.throws(
		() =>
			validateCommandAllowlist(
				'pnpm',
				['--filter', 'services/authentication', 'run', 'quality:affected'],
				allowedPackages,
			),
		(error) => error.code === 'INVALID_INPUT' && /not allowlisted/.test(error.message),
	);
});

test('@ac AC-04 @case AC-04.1 @case AC-04.2 @case AC-04.3 validateHostCommand dispatches script and default command policies', () => {
	const scriptProfile = {
		schemaVersion: '1.0.0',
		profileId: 'fixture-host',
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
	};
	assert.equal(validateHostCommand('node', ['--test'], { profile: scriptProfile }), true);
	assert.throws(
		() => validateHostCommand('node', ['--test', 'foo.mjs'], { profile: scriptProfile }),
		(err) => err.code === 'INVALID_INPUT',
	);
	assert.throws(
		() => validateHostCommand('pnpm', ['test'], { profile: scriptProfile }),
		(err) => err.code === 'INVALID_INPUT',
	);
	for (const bad of [';', '&&', '||', '`', '$()', '.git', '.agent-sdlc']) {
		assert.throws(
			() => validateHostCommand('node', [bad], { profile: { ...scriptProfile, commands: [['node', bad]] } }),
			(err) => err.code === 'INVALID_INPUT',
		);
	}
	assert.equal(
		validateHostCommand('pnpm', ['--filter', '@fixture/billing-service', 'test']),
		true,
	);
	assert.throws(
		() => validateHostCommand('git', ['commit', '-m', 'x']),
		(err) => err.code === 'INVALID_INPUT',
	);
});
