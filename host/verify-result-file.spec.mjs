import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runHostVerify } from './verify-runner.ts';

const verify = {
	argv: ['node', 'verify.mjs'],
	resultPath: 'build/verify.json',
	headField: 'head',
	require: { status: 'OK', canonical: true },
};
const diagnostics = { schemaVersion: '1', coverageFloor: { pass: false, paths: ['pkg/src/orphan.ts'] } };

function withTempWorktree(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-verify-result-'));
	return Promise.resolve().then(() => fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function throwExit() {
	const error = new Error('fail');
	error.status = 1;
	error.stdout = '';
	error.stderr = 'fail';
	throw error;
}

test('@ac AC-05 @case AC-05.1 a non-zero exit with an existing result file keeps preflightResult', async () => {
	await withTempWorktree(async (worktreeDir) => {
		const sha = 'd'.repeat(40);
		fs.mkdirSync(path.join(worktreeDir, 'build'), { recursive: true });
		fs.writeFileSync(path.join(worktreeDir, 'build/verify.json'), JSON.stringify({
			status: 'FAIL', canonical: false, exitCode: 1, integrationDiagnostics: diagnostics,
		}));
		const outcome = await runHostVerify({ worktreeDir, verify, baseSha: sha, expectedHead: sha, execCli: throwExit });
		assert.equal(outcome.status, 'FAIL');
		assert.equal(outcome.preflightResult.integrationDiagnostics.coverageFloor.pass, false);
	});
});

test('@ac AC-05 @case AC-05.2 a missing result file leaves preflightResult unset', async () => {
	await withTempWorktree(async (worktreeDir) => {
		const sha = 'd'.repeat(40);
		const outcome = await runHostVerify({ worktreeDir, verify, baseSha: sha, expectedHead: sha, execCli: throwExit });
		assert.equal(outcome.status, 'FAIL');
		assert.equal(outcome.preflightResult, undefined);
	});
});

test('@ac AC-05 @case AC-05.3 a parsed non-canonical result still carries preflightResult', async () => {
	await withTempWorktree(async (worktreeDir) => {
		const sha = 'd'.repeat(40);
		fs.mkdirSync(path.join(worktreeDir, 'build'), { recursive: true });
		fs.writeFileSync(path.join(worktreeDir, 'build/verify.json'), JSON.stringify({
			status: 'FAIL', canonical: false, head: sha, integrationDiagnostics: diagnostics,
		}));
		const outcome = await runHostVerify({ worktreeDir, verify, baseSha: sha, expectedHead: sha, execCli: () => '' });
		assert.equal(outcome.status, 'FAIL');
		assert.equal(outcome.preflightResult.canonical, false);
		assert.equal(outcome.preflightResult.integrationDiagnostics.schemaVersion, '1');
	});
});

test('@ac AC-05 @case AC-05.4 invalid JSON stays failed without preflightResult', async () => {
	await withTempWorktree(async (worktreeDir) => {
		const sha = 'd'.repeat(40);
		fs.mkdirSync(path.join(worktreeDir, 'build'), { recursive: true });
		fs.writeFileSync(path.join(worktreeDir, 'build/verify.json'), '{');
		const outcome = await runHostVerify({ worktreeDir, verify, baseSha: sha, expectedHead: sha, execCli: () => '' });
		assert.equal(outcome.status, 'FAIL');
		assert.equal(outcome.ok, false);
		assert.equal(outcome.preflightResult, undefined);
		assert.match(outcome.output, /Failed to parse/);
	});
});
