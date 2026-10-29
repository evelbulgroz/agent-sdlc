import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	executeCommittedPreflightVerifier,
	executePreflightVerifier,
} from '../review/verifier.ts';
import { makeFixture } from '../testing/test-support.mjs';
import {
	HOST_PROFILE_RELATIVE_PATH,
	loadHostProfile,
	loadHostProfileOrFallback,
} from './host-profile.ts';
import {
	DEFAULT_VERIFY_ARGV,
	resolveHostVerifyConfig,
} from './verify-config.ts';
import { runHostVerify } from './verify-runner.ts';

function writeRawProfile(rootDir, payload) {
	const fullPath = path.join(rootDir, HOST_PROFILE_RELATIVE_PATH);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

const PREFLIGHT_PROFILE = {
	schemaVersion: '1.3.0',
	profileId: 'preflight-host',
	repositoryId: 'preflight-host',
	adapter: 'default',
	stateDir: 'tools/.agent-sdlc',
	reviewDir: 'tools/.review',
	specDraftDir: 'docs/specs/drafts',
	verify: {
		argv: ['pnpm', 'run', 'agent:preflight', '--', '--base', '{baseSha}'],
		resultPath: 'tools/.agent-preflight-last.json',
	},
};

function withTempWorktree(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-verify-runner-'));
	return Promise.resolve()
		.then(() => fn(dir))
		.finally(() => {
			fs.rmSync(dir, { recursive: true, force: true });
		});
}

test('@ac AC-03 @case AC-03.1 executePreflightVerifier substitutes baseSha, reads resultPath, checks headField against the base SHA, and returns PASS with preflightResultHash', async () => {
	const fixture = makeFixture('verify-runner-ac03-1', []);
	try {
		const worktreeDir = path.join(fixture.runtimeDir, 'worktree');
		const baseCommitSha = '1'.repeat(40);
		const targetTreeSha = '2'.repeat(40);
		fs.mkdirSync(path.join(worktreeDir, 'tools'), { recursive: true });
		writeRawProfile(worktreeDir, PREFLIGHT_PROFILE);
		fs.writeFileSync(
			path.join(worktreeDir, 'tools/.agent-preflight-last.json'),
			JSON.stringify({
				status: 'OK',
				canonical: true,
				base: baseCommitSha,
				gitHeadSha: baseCommitSha,
			}),
		);

		const recorded = [];
		const result = await executePreflightVerifier({
			runId: fixture.runId,
			worktreeDir,
			baseCommitSha,
			targetTreeSha,
			artifactStore: fixture.artifacts,
			execCli: (cmd, args) => {
				recorded.push([cmd, ...args]);
				return '';
			},
		});

		assert.equal(result.status, 'PASS');
		assert.deepEqual(recorded, [
			['pnpm', 'run', 'agent:preflight', '--', '--base', baseCommitSha],
		]);
		assert.ok(result.preflightResultHash);
	} finally {
		fixture.close();
	}
});

test('@ac AC-03 @case AC-03.2 executeCommittedPreflightVerifier checks headField against the committed HEAD SHA and returns PASS with commitSha, treeSha, and preflightResultHash', async () => {
	const fixture = makeFixture('verify-runner-ac03-2', []);
	try {
		const worktreeDir = path.join(fixture.runtimeDir, 'worktree');
		const baseCommitSha = '1'.repeat(40);
		const commitSha = '3'.repeat(40);
		const targetTreeSha = '4'.repeat(40);
		fs.mkdirSync(path.join(worktreeDir, 'tools'), { recursive: true });
		writeRawProfile(worktreeDir, PREFLIGHT_PROFILE);
		fs.writeFileSync(
			path.join(worktreeDir, 'tools/.agent-preflight-last.json'),
			JSON.stringify({
				status: 'OK',
				canonical: true,
				base: baseCommitSha,
				gitHeadSha: commitSha,
			}),
		);

		const result = await executeCommittedPreflightVerifier({
			runId: fixture.runId,
			worktreeDir,
			baseCommitSha,
			commitSha,
			targetTreeSha,
			artifactStore: fixture.artifacts,
			execCli: () => '',
			gitCli: (_cmd, args) => {
				if (args[0] === 'status') return '';
				if (args[1] === 'HEAD') return `${commitSha}\n`;
				if (args[1] === 'HEAD^{tree}') return `${targetTreeSha}\n`;
				return '';
			},
		});

		assert.equal(result.status, 'PASS');
		assert.equal(result.commitSha, commitSha);
		assert.equal(result.treeSha, targetTreeSha);
		assert.ok(result.preflightResultHash);
	} finally {
		fixture.close();
	}
});

test('@ac AC-03 @case AC-03.3 custom resultPath (build/verify.json) and custom headField (head) pass when the script writes status OK, canonical true, and head sha', async () => {
	await withTempWorktree(async (worktreeDir) => {
		const sha = 'a'.repeat(40);
		const customVerify = {
			argv: ['node', 'verify.mjs', '{baseSha}'],
			resultPath: 'build/verify.json',
			headField: 'head',
			require: { status: 'OK', canonical: true },
		};
		const outcome = await runHostVerify({
			worktreeDir,
			verify: customVerify,
			baseSha: sha,
			expectedHead: sha,
			execCli: (_cmd, args) => {
				fs.mkdirSync(path.join(worktreeDir, 'build'), { recursive: true });
				fs.writeFileSync(
					path.join(worktreeDir, 'build/verify.json'),
					JSON.stringify({ status: 'OK', canonical: true, head: args[1] }),
				);
				return '';
			},
		});

		assert.equal(outcome.status, 'PASS');
		assert.equal(outcome.ok, true);
		assert.equal(outcome.result.head, sha);
	});
});

test('@ac AC-03 @case AC-03.4 canonical false, wrong headField value, or missing resultPath returns FAIL', async () => {
	await withTempWorktree(async (worktreeDir) => {
		const sha = 'b'.repeat(40);
		const customVerify = {
			argv: ['node', 'verify.mjs', '{baseSha}'],
			resultPath: 'build/verify.json',
			headField: 'head',
			require: { status: 'OK', canonical: true },
		};

		// 1. Missing resultPath
		const missing = await runHostVerify({
			worktreeDir,
			verify: customVerify,
			baseSha: sha,
			expectedHead: sha,
			execCli: () => '',
		});
		assert.equal(missing.status, 'FAIL');

		// 2. canonical: false
		fs.mkdirSync(path.join(worktreeDir, 'build'), { recursive: true });
		fs.writeFileSync(
			path.join(worktreeDir, 'build/verify.json'),
			JSON.stringify({ status: 'OK', canonical: false, head: sha }),
		);
		const nonCanonical = await runHostVerify({
			worktreeDir,
			verify: customVerify,
			baseSha: sha,
			expectedHead: sha,
			execCli: () => '',
		});
		assert.equal(nonCanonical.status, 'FAIL');
		assert.match(nonCanonical.output, /non-canonical outcome/);

		// 3. Wrong headField value
		fs.writeFileSync(
			path.join(worktreeDir, 'build/verify.json'),
			JSON.stringify({ status: 'OK', canonical: true, head: 'c'.repeat(40) }),
		);
		const wrongHead = await runHostVerify({
			worktreeDir,
			verify: customVerify,
			baseSha: sha,
			expectedHead: sha,
			execCli: () => '',
		});
		assert.equal(wrongHead.status, 'FAIL');
		assert.match(wrongHead.output, /Preflight result head/);
	});
});

function isHostProfileError(error) {
	return (
		error?.code === 'INVALID_INPUT' &&
		typeof error?.message === 'string' &&
		error.message.startsWith('HOST_PROFILE_INVALID')
	);
}

test('@ac AC-01 @case AC-01.1 resolveHostVerifyConfig, loadHostProfile, and loadHostProfileOrFallback default 1.3.0 verify to npm test and support custom exit-code verify.argv without baseSha or resultPath', async () => {
	assert.deepEqual(DEFAULT_VERIFY_ARGV, ['npm', 'test']);
	assert.deepEqual(resolveHostVerifyConfig(undefined, '1.3.0'), {
		argv: ['npm', 'test'],
	});

	await withTempWorktree(async (tempRoot) => {
		const fallback = loadHostProfileOrFallback(tempRoot);
		assert.deepEqual(fallback.verify, { argv: ['npm', 'test'] });

		writeRawProfile(tempRoot, {
			schemaVersion: '1.3.0',
			profileId: 'minimal-client',
			repositoryId: 'minimal-client',
			adapter: 'script',
			hydration: [['npm', 'install']],
			commands: [['npm', 'test']],
			workspace: { directories: ['.'] },
		});
		const defaulted = loadHostProfile(tempRoot);
		assert.deepEqual(defaulted.verify, { argv: ['npm', 'test'] });
		assert.equal(Object.isFrozen(defaulted.verify.argv), true);

		writeRawProfile(tempRoot, {
			schemaVersion: '1.3.0',
			profileId: 'custom-exit-client',
			repositoryId: 'custom-exit-client',
			adapter: 'script',
			hydration: [['pnpm', 'install']],
			commands: [['pnpm', 'run', 'check']],
			workspace: { directories: ['.'] },
			verify: { argv: ['pnpm', 'run', 'check'] },
		});
		const customExit = loadHostProfile(tempRoot);
		assert.deepEqual(customExit.verify, { argv: ['pnpm', 'run', 'check'] });
		assert.equal(Object.isFrozen(customExit.verify.argv), true);
	});
});

test('@ac AC-01 @case AC-01.2 loadHostProfile defaults require and headField when resultPath is present in 1.3.0 and rejects invalid 1.2.0 or 1.3.0 verify combinations with HOST_PROFILE_INVALID', async () => {
	await withTempWorktree(async (tempRoot) => {
		const base13 = {
			schemaVersion: '1.3.0',
			profileId: 'receipt-client',
			repositoryId: 'receipt-client',
			adapter: 'script',
			hydration: [['npm', 'install']],
			commands: [['npm', 'test']],
			workspace: { directories: ['.'] },
		};
		writeRawProfile(tempRoot, {
			...base13,
			verify: {
				argv: ['node', 'verify.mjs', '{baseSha}'],
				resultPath: '.agent-sdlc/verify.json',
			},
		});
		const receiptLoaded = loadHostProfile(tempRoot);
		assert.deepEqual(receiptLoaded.verify, {
			argv: ['node', 'verify.mjs', '{baseSha}'],
			resultPath: '.agent-sdlc/verify.json',
			require: { status: 'OK', canonical: true },
			headField: 'gitHeadSha',
		});

		const base12 = {
			schemaVersion: '1.2.0',
			profileId: 'legacy-client',
			repositoryId: 'legacy-client',
			adapter: 'default',
			stateDir: 'tools/.agent-sdlc',
			reviewDir: 'tools/.review',
			specDraftDir: 'docs/specs/drafts',
		};
		const invalidPayloads = [
			base12,
			{
				...base12,
				verify: {
					argv: ['pnpm', 'run', 'agent:preflight'],
					resultPath: 'tools/.agent-preflight-last.json',
					require: { status: 'OK', canonical: true },
					headField: 'gitHeadSha',
				},
			},
			{
				...base12,
				verify: {
					argv: ['pnpm', 'run', 'agent:preflight', '{baseSha}'],
				},
			},
			{
				...base13,
				verify: {
					argv: ['npm', 'test'],
					headField: 'gitHeadSha',
				},
			},
			{
				...base13,
				verify: {
					argv: ['npm', 'test'],
					require: { status: 'OK', canonical: true },
				},
			},
			{
				...base13,
				verify: {
					argv: ['node', 'verify.mjs', '{baseSha}', '{baseSha}'],
				},
			},
			{
				...base13,
				verify: {
					argv: ['node', 'verify.mjs', '--base={baseSha}'],
				},
			},
		];

		for (const payload of invalidPayloads) {
			writeRawProfile(tempRoot, payload);
			assert.throws(() => loadHostProfile(tempRoot), isHostProfileError);
		}
	});
});

test('@ac AC-02 @case AC-02.1 executePreflightVerifier and executeCommittedPreflightVerifier succeed in exit-code mode with synthesized receipt and binding when resultPath is omitted', async () => {
	const fixture = makeFixture('verify-runner-ac02-1', []);
	try {
		const worktreeDir = path.join(fixture.runtimeDir, 'worktree');
		const baseCommitSha = '5'.repeat(40);
		const commitSha = '6'.repeat(40);
		const targetTreeSha = '7'.repeat(40);
		const exitCodeVerify = { argv: ['npm', 'test'] };

		const recorded = [];
		const preflightRes = await executePreflightVerifier({
			runId: fixture.runId,
			worktreeDir,
			verify: exitCodeVerify,
			baseCommitSha,
			targetTreeSha,
			artifactStore: fixture.artifacts,
			execCli: (cmd, args) => {
				recorded.push([cmd, ...args]);
				return 'all tests passed';
			},
		});
		assert.equal(preflightRes.status, 'PASS');
		assert.deepEqual(recorded, [['npm', 'test']]);
		assert.equal(preflightRes.binding.command, 'npm test');
		assert.equal(preflightRes.binding.status, 'OK');
		assert.equal(preflightRes.binding.canonical, true);
		assert.ok(preflightRes.preflightResultHash);
		assert.equal(preflightRes.preflightResult.gitHeadSha, baseCommitSha);

		const committedRes = await executeCommittedPreflightVerifier({
			runId: fixture.runId,
			worktreeDir,
			verify: exitCodeVerify,
			baseCommitSha,
			commitSha,
			targetTreeSha,
			artifactStore: fixture.artifacts,
			execCli: () => 'all tests passed',
			gitCli: (_cmd, args) => {
				if (args[0] === 'status') return '';
				if (args[1] === 'HEAD') return `${commitSha}\n`;
				if (args[1] === 'HEAD^{tree}') return `${targetTreeSha}\n`;
				return '';
			},
		});
		assert.equal(committedRes.status, 'PASS');
		assert.equal(committedRes.commitSha, commitSha);
		assert.equal(committedRes.treeSha, targetTreeSha);
		assert.equal(committedRes.preflightResult.gitHeadSha, commitSha);
		assert.ok(committedRes.preflightResultHash);
	} finally {
		fixture.close();
	}
});

test('@ac AC-02 @case AC-02.2 runHostVerify in exit-code mode substitutes baseSha and fails closed when execCli exits non-zero', async () => {
	await withTempWorktree(async (worktreeDir) => {
		const baseSha = '8'.repeat(40);
		const recorded = [];
		const outcome = await runHostVerify({
			worktreeDir,
			verify: { argv: ['pnpm', 'run', 'check', '{baseSha}'] },
			baseSha,
			expectedHead: baseSha,
			execCli: (cmd, args) => {
				recorded.push([cmd, ...args]);
				const err = new Error('check failed');
				err.status = 2;
				err.stdout = 'checking...';
				err.stderr = 'assertion failed';
				throw err;
			},
		});
		assert.deepEqual(recorded, [['pnpm', 'run', 'check', baseSha]]);
		assert.equal(outcome.status, 'FAIL');
		assert.equal(outcome.ok, false);
		assert.equal(outcome.exitCode, 2);
		assert.equal(outcome.processFailed, true);
		assert.match(outcome.output, /assertion failed/);
	});
});
