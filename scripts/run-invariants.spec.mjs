import '../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT, liveRunRoot } from '../persistence/run-paths.ts';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';
import { implementerScript, makeGraphFixture, reachSpecApproved } from '../testing/graph-fixtures.ts';
import { main, parseInvariantArgs } from './run-invariants.ts';

function captureMain(args) {
	const lines = [];
	const originalLog = console.log;
	const originalError = console.error;
	console.log = (line) => lines.push(String(line));
	console.error = (line) => lines.push(String(line));
	try {
		main(args);
		return { lines, code: process.exitCode };
	} finally {
		console.log = originalLog;
		console.error = originalError;
		process.exitCode = 0;
	}
}

test('parseInvariantArgs resolves --root and defaults to this checkout', () => {
	assert.equal(parseInvariantArgs(['--run', 'r1']).rootDir, REPOSITORY_ROOT);
	assert.equal(parseInvariantArgs(['--run', 'r1', '--root', '/tmp/x/../fixture']).rootDir, '/tmp/fixture');
	assert.equal(parseInvariantArgs(['--root', '/tmp/fixture']).runId, undefined);
});

test('@ac AC-07 --root audits a store that lives in another repository and reports git it cannot read as a failure', async () => {
	const fixture = makeGraphFixture('qual-invariants-root', implementerScript(), { profile: 'slice3' });
	const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qual-root-'));
	try {
		const approved = await reachSpecApproved(fixture);
		const terminal = await fixture.runtime.authorize(
			approved,
			createDefaultAuthorizationEnvelope({
				runId: fixture.runId,
				approvedSpecHash: approved.approvedSpecHash,
				baseCommitSha: fixture.baseCommitSha,
				allowedPackages: ['services/billing'],
				allowedPathPrefixes: ['services/billing'],
				createBranch: true,
				createLocalCommits: false,
			}),
		);
		assert.equal(terminal.state, 'READY_FOR_GIT_APPROVAL');
		fixture.store.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
		const runDir = path.join(liveRunRoot(otherRoot), fixture.runId);
		fs.mkdirSync(runDir, { recursive: true });
		fs.copyFileSync(path.join(fixture.runtimeDir, 'runtime.sqlite'), path.join(runDir, 'runtime.sqlite'));

		const missing = captureMain(['--run', fixture.runId]);
		assert.equal(missing.code, 64, 'the run is not under this checkout');

		const audited = captureMain(['--run', fixture.runId, '--root', otherRoot]);
		const text = audited.lines.join('\n');
		assert.match(text, /PASS event-hash-chain/);
		assert.match(text, /PASS terminal-state: state=READY_FOR_GIT_APPROVAL/);
		assert.match(text, /FAIL path-containment: git unavailable/);
		assert.equal(audited.code, 3);
	} finally {
		fs.rmSync(otherRoot, { recursive: true, force: true });
		fixture.close();
	}
});
