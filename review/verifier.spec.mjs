import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
	executePreflightVerifier,
	executeCommittedPreflightVerifier,
	verifyPreflightEvidence,
} from './verifier.ts';
import { makeFixture } from '../testing/test-support.mjs';

test('@ac AC-03 @case AC-03.1 executePreflightVerifier parses successful preflight and emits 5-point binding', async () => {
	const fixture = makeFixture('verifier-test-2', []);
	const worktreeDir = path.join(fixture.runtimeDir, 'worktree');
	fs.mkdirSync(path.join(worktreeDir, 'tools'), { recursive: true });

	const baseCommitSha = '2222222222222222222222222222222222222222';
	const targetTreeSha = '3333333333333333333333333333333333333333';

	// Write mock successful .agent-preflight-last.json
	const preflightJsonPath = path.join(worktreeDir, 'tools/.agent-preflight-last.json');
	fs.writeFileSync(
		preflightJsonPath,
		JSON.stringify({
			schemaVersion: 1,
			status: 'OK',
			canonical: true,
			changeClass: 'A',
			exitCode: 0,
			base: baseCommitSha,
			gitHeadSha: baseCommitSha,
		}),
	);

	const mockExec = () => 'agent-preflight: RESULT status=OK class=A canonical=true';

	try {
		const result = await executePreflightVerifier({
			runId: fixture.runId,
			generation: 0,
			worktreeDir,
			baseCommitSha,
			targetTreeSha,
			targetPaths: ['apps/services/conditioning/**'],
			artifactStore: fixture.artifacts,
			execCli: mockExec,
		});

		assert.equal(result.status, 'PASS');
		assert.equal(result.binding.status, 'OK');
		assert.equal(result.binding.canonical, true);
		assert.equal(result.binding.baseCommitSha, baseCommitSha);
		assert.equal(result.binding.targetTreeSha, targetTreeSha);
		assert.ok(result.binding.preflightResultHash);
	} finally {
		fixture.close();
	}
});

test('executePreflightVerifier handles failing preflight and generates failure packet', async () => {
	const fixture = makeFixture('verifier-test-3', []);
	const worktreeDir = path.join(fixture.runtimeDir, 'worktree');
	fs.mkdirSync(worktreeDir, { recursive: true });

	const baseCommitSha = '4444444444444444444444444444444444444444';
	const targetTreeSha = '5555555555555555555555555555555555555555';

	const mockFailingExec = () => {
		const err = new Error('Preflight exit 1');
		err.status = 1;
		err.stdout = 'FAIL test suite in apps/services/conditioning';
		err.stderr = 'ERR: preflight failed';
		throw err;
	};

	try {
		const result = await executePreflightVerifier({
			runId: fixture.runId,
			generation: 0,
			worktreeDir,
			baseCommitSha,
			targetTreeSha,
			targetPaths: ['apps/services/conditioning/**'],
			artifactStore: fixture.artifacts,
			execCli: mockFailingExec,
		});

		assert.equal(result.status, 'FAIL');
		assert.equal(result.exitCode, 1);
		assert.equal(result.failurePacket.classification, 'test_failure');
		assert.equal(result.repairable, true);
		assert.ok(result.outputArtifact);

		// Read written failure packet artifact
		const storedPacket = fixture.artifacts.readJson(result.outputArtifact);
		assert.equal(storedPacket.runId, fixture.runId);
		assert.equal(storedPacket.classification, 'test_failure');
	} finally {
		fixture.close();
	}
});

test('executePreflightVerifier fails closed on base mismatch', async () => {
	const fixture = makeFixture('verifier-test-base-mismatch', []);
	const worktreeDir = path.join(fixture.runtimeDir, 'worktree');
	const baseCommitSha = '2222222222222222222222222222222222222222';
	const targetTreeSha = '3333333333333333333333333333333333333333';
	writePreflightResult(worktreeDir, {
		schemaVersion: 1,
		status: 'OK',
		canonical: true,
		changeClass: 'A',
		exitCode: 0,
		base: '9999999999999999999999999999999999999999',
		gitHeadSha: baseCommitSha,
	});
	try {
		const result = await executePreflightVerifier({
			runId: fixture.runId,
			generation: 0,
			worktreeDir,
			baseCommitSha,
			targetTreeSha,
			targetPaths: ['apps/services/conditioning/**'],
			artifactStore: fixture.artifacts,
			execCli: () => '',
		});
		assert.equal(result.status, 'FAIL');
		assert.ok(result.failurePacket);
		assert.ok(result.failurePacket.sanitizedOutput.includes('does not match authorized base'));
	} finally {
		fixture.close();
	}
});

test('executePreflightVerifier fails closed on gitHeadSha mismatch', async () => {
	const fixture = makeFixture('verifier-test-head-mismatch', []);
	const worktreeDir = path.join(fixture.runtimeDir, 'worktree');
	const baseCommitSha = '2222222222222222222222222222222222222222';
	const targetTreeSha = '3333333333333333333333333333333333333333';
	writePreflightResult(worktreeDir, {
		schemaVersion: 1,
		status: 'OK',
		canonical: true,
		changeClass: 'A',
		exitCode: 0,
		base: baseCommitSha,
		gitHeadSha: '8888888888888888888888888888888888888888',
	});
	try {
		const result = await executePreflightVerifier({
			runId: fixture.runId,
			generation: 0,
			worktreeDir,
			baseCommitSha,
			targetTreeSha,
			targetPaths: ['apps/services/conditioning/**'],
			artifactStore: fixture.artifacts,
			execCli: () => '',
		});
		assert.equal(result.status, 'FAIL');
		assert.ok(result.failurePacket);
		assert.ok(result.failurePacket.sanitizedOutput.includes('does not match authorized base'));
	} finally {
		fixture.close();
	}
});

test('@ac AC-03 @case AC-03.4 executePreflightVerifier fails closed when canonical is false or status not OK', async () => {
	const fixture = makeFixture('verifier-test-noncanonical', []);
	const worktreeDir = path.join(fixture.runtimeDir, 'worktree');
	const baseCommitSha = '2222222222222222222222222222222222222222';
	const targetTreeSha = '3333333333333333333333333333333333333333';
	writePreflightResult(worktreeDir, {
		schemaVersion: 1,
		status: 'OK',
		canonical: false,
		changeClass: 'A',
		exitCode: 0,
		base: baseCommitSha,
		gitHeadSha: baseCommitSha,
	});
	try {
		const result = await executePreflightVerifier({
			runId: fixture.runId,
			generation: 0,
			worktreeDir,
			baseCommitSha,
			targetTreeSha,
			targetPaths: ['apps/services/conditioning/**'],
			artifactStore: fixture.artifacts,
			execCli: () => '',
		});
		assert.equal(result.status, 'FAIL');
		assert.ok(result.failurePacket);
		assert.ok(result.failurePacket.sanitizedOutput.includes('Preflight reported non-canonical outcome'));
	} finally {
		fixture.close();
	}
});

test('executePreflightVerifier fails closed on malformed JSON', async () => {
	const fixture = makeFixture('verifier-test-malformed-json', []);
	const worktreeDir = path.join(fixture.runtimeDir, 'worktree');
	fs.mkdirSync(path.join(worktreeDir, 'tools'), { recursive: true });

	const baseCommitSha = '2222222222222222222222222222222222222222';
	const targetTreeSha = '3333333333333333333333333333333333333333';

	const preflightJsonPath = path.join(worktreeDir, 'tools/.agent-preflight-last.json');
	fs.writeFileSync(preflightJsonPath, '{"broken json');

	try {
		const result = await executePreflightVerifier({
			runId: fixture.runId,
			generation: 0,
			worktreeDir,
			baseCommitSha,
			targetTreeSha,
			targetPaths: ['apps/services/conditioning/**'],
			artifactStore: fixture.artifacts,
			execCli: () => '',
		});

		assert.equal(result.status, 'FAIL');
		assert.ok(result.failurePacket);
		assert.ok(result.failurePacket.sanitizedOutput.includes('Failed to parse .agent-preflight-last.json'));
	} finally {
		fixture.close();
	}
});

test('@ac AC-03 @case AC-03.2 executeCommittedPreflightVerifier validates clean committed tree, treeSha, and preflight OK', async () => {
	const fixture = makeFixture('committed-verifier-pass', []);
	const worktreeDir = path.join(fixture.runtimeDir, 'worktree');
	fs.mkdirSync(path.join(worktreeDir, 'tools'), { recursive: true });

	const baseCommitSha = '2222222222222222222222222222222222222222';
	const commitSha = '3333333333333333333333333333333333333333';
	const targetTreeSha = '4444444444444444444444444444444444444444';

	const preflightJsonPath = path.join(worktreeDir, 'tools/.agent-preflight-last.json');
	fs.writeFileSync(
		preflightJsonPath,
		JSON.stringify({
			schemaVersion: 1,
			status: 'OK',
			canonical: true,
			changeClass: 'A',
			exitCode: 0,
			base: baseCommitSha,
			gitHeadSha: commitSha,
		}),
	);

	const mockGitCli = (cmd, args) => {
		if (args[0] === 'status') return '';
		if (args[0] === 'rev-parse' && args[1] === 'HEAD') return commitSha + '\n';
		if (args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') return targetTreeSha + '\n';
		return '';
	};

	const mockExec = () => 'agent-preflight: RESULT status=OK class=A canonical=true';

	try {
		const result = await executeCommittedPreflightVerifier({
			runId: fixture.runId,
			generation: 0,
			worktreeDir,
			baseCommitSha,
			commitSha,
			targetTreeSha,
			targetPaths: ['apps/services/conditioning/**'],
			artifactStore: fixture.artifacts,
			execCli: mockExec,
			gitCli: mockGitCli,
		});

		assert.equal(result.status, 'PASS');
		assert.equal(result.commitSha, commitSha);
		assert.equal(result.treeSha, targetTreeSha);
		assert.equal(result.binding.status, 'OK');
		assert.equal(result.binding.canonical, true);
	} finally {
		fixture.close();
	}
});

test('executeCommittedPreflightVerifier fails closed if worktree is dirty or tree SHA mutated', async () => {
	const fixture = makeFixture('committed-verifier-fail', []);
	const worktreeDir = path.join(fixture.runtimeDir, 'worktree');
	fs.mkdirSync(path.join(worktreeDir, 'tools'), { recursive: true });

	const baseCommitSha = '2222222222222222222222222222222222222222';
	const commitSha = '3333333333333333333333333333333333333333';
	const targetTreeSha = '4444444444444444444444444444444444444444';

	// 1. Dirty worktree fails
	const dirtyGitCli = (cmd, args) => {
		if (args[0] === 'status') return 'M modified.ts\n';
		return '';
	};

	try {
		const result = await executeCommittedPreflightVerifier({
			runId: fixture.runId,
			generation: 0,
			worktreeDir,
			baseCommitSha,
			commitSha,
			targetTreeSha,
			artifactStore: fixture.artifacts,
			gitCli: dirtyGitCli,
		});

		assert.equal(result.status, 'FAIL');
		assert.ok(result.failurePacket.sanitizedOutput.includes('Worktree is dirty'));

		// 2. Mutated tree SHA fails
		const mutatedTreeGitCli = (cmd, args) => {
			if (args[0] === 'status') return '';
			if (args[0] === 'rev-parse' && args[1] === 'HEAD') return commitSha + '\n';
			if (args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') return 'mutated-tree-sha\n';
			return '';
		};

		const mutatedResult = await executeCommittedPreflightVerifier({
			runId: fixture.runId,
			generation: 0,
			worktreeDir,
			baseCommitSha,
			commitSha,
			targetTreeSha,
			artifactStore: fixture.artifacts,
			gitCli: mutatedTreeGitCli,
		});

		assert.equal(mutatedResult.status, 'FAIL');
		assert.ok(mutatedResult.failurePacket.sanitizedOutput.includes('does not match expected target tree SHA'));
	} finally {
		fixture.close();
	}
});

function writePreflightResult(worktreeDir, result) {
	fs.mkdirSync(path.join(worktreeDir, 'tools'), { recursive: true });
	fs.writeFileSync(path.join(worktreeDir, 'tools/.agent-preflight-last.json'), JSON.stringify(result));
}

function gitStub({ head, tree }) {
	return (_cmd, args) => {
		if (args[0] === 'status') return '';
		if (args[1] === 'HEAD') return `${head}\n`;
		if (args[1] === 'HEAD^{tree}') return `${tree}\n`;
		throw new Error(`unexpected git ${args.join(' ')}`);
	};
}

test('@ac AC-05 @case AC-05.1 executePreflightVerifier reports the full gitHeadSha mismatch message against the authorized base', async () => {
	const fixture = makeFixture('verifier-ac05-1', []);
	try {
		const worktreeDir = path.join(fixture.runtimeDir, 'worktree');
		const base = '2'.repeat(40);
		const head = '8'.repeat(40);
		writePreflightResult(worktreeDir, { status: 'OK', canonical: true, exitCode: 0, base, gitHeadSha: head });
		const result = await executePreflightVerifier({
			runId: fixture.runId,
			worktreeDir,
			baseCommitSha: base,
			targetTreeSha: '3'.repeat(40),
			artifactStore: fixture.artifacts,
			execCli: () => '',
		});
		assert.equal(result.status, 'FAIL');
		assert.equal(result.exitCode, 1);
		assert.ok(
			result.failurePacket.sanitizedOutput.includes(
				`Preflight result gitHeadSha '${head}' does not match authorized base '${base}'`,
			),
		);
	} finally {
		fixture.close();
	}
});

test('@ac AC-05 @case AC-05.2 executeCommittedPreflightVerifier reports the full gitHeadSha mismatch message against the committed HEAD', async () => {
	const fixture = makeFixture('verifier-ac05-2', []);
	try {
		const worktreeDir = path.join(fixture.runtimeDir, 'worktree');
		const base = '2'.repeat(40);
		const commit = '3'.repeat(40);
		const tree = '4'.repeat(40);
		const head = '8'.repeat(40);
		writePreflightResult(worktreeDir, { status: 'OK', canonical: true, exitCode: 0, base, gitHeadSha: head });
		const result = await executeCommittedPreflightVerifier({
			runId: fixture.runId,
			worktreeDir,
			baseCommitSha: base,
			commitSha: commit,
			targetTreeSha: tree,
			artifactStore: fixture.artifacts,
			execCli: () => '',
			gitCli: gitStub({ head: commit, tree }),
		});
		assert.equal(result.status, 'FAIL');
		assert.ok(
			result.failurePacket.sanitizedOutput.includes(
				`Preflight result gitHeadSha '${head}' does not match committed HEAD '${commit}'`,
			),
		);
	} finally {
		fixture.close();
	}
});

test('@ac AC-05 @case AC-05.2 a committed PASS carries commitSha and treeSha and a worktree PASS does not', async () => {
	const fixture = makeFixture('verifier-ac05-pass-shapes', []);
	try {
		const worktreeDir = path.join(fixture.runtimeDir, 'worktree');
		const base = '2'.repeat(40);
		const commit = '3'.repeat(40);
		const tree = '4'.repeat(40);
		writePreflightResult(worktreeDir, { status: 'OK', canonical: true, exitCode: 0, base, gitHeadSha: commit });
		const committed = await executeCommittedPreflightVerifier({
			runId: fixture.runId,
			worktreeDir,
			baseCommitSha: base,
			commitSha: commit,
			targetTreeSha: tree,
			artifactStore: fixture.artifacts,
			execCli: () => '',
			gitCli: gitStub({ head: commit, tree }),
		});
		assert.equal(committed.status, 'PASS');
		assert.equal(committed.commitSha, commit);
		assert.equal(committed.treeSha, tree);

		writePreflightResult(worktreeDir, { status: 'OK', canonical: true, exitCode: 0, base, gitHeadSha: base });
		const worktree = await executePreflightVerifier({
			runId: fixture.runId,
			worktreeDir,
			baseCommitSha: base,
			targetTreeSha: tree,
			artifactStore: fixture.artifacts,
			execCli: () => '',
		});
		assert.equal(worktree.status, 'PASS');
		assert.equal('commitSha' in worktree, false);
	} finally {
		fixture.close();
	}
});

test('@ac AC-03 @case AC-03.3 @case AC-03.5 runPreflightAndBind supports custom resultPath/headField and contains no preflight argv array or tools/.agent-preflight-last.json literal', async () => {
	const source = fs.readFileSync(new URL('./verifier.ts', import.meta.url), 'utf8');
	assert.equal(source.includes('tools/.agent-preflight-last.json'), false);
	assert.equal(source.includes('agent:preflight'), false);

	const fixture = makeFixture('verifier-ac03-custom', []);
	try {
		const worktreeDir = path.join(fixture.runtimeDir, 'worktree');
		const base = '2'.repeat(40);
		const tree = '3'.repeat(40);
		fs.mkdirSync(path.join(worktreeDir, 'build'), { recursive: true });
		fs.writeFileSync(
			path.join(worktreeDir, 'build/verify.json'),
			JSON.stringify({ status: 'OK', canonical: true, head: base }),
		);
		const res = await executePreflightVerifier({
			runId: fixture.runId,
			worktreeDir,
			verify: {
				argv: ['node', 'verify.mjs', '{baseSha}'],
				resultPath: 'build/verify.json',
				headField: 'head',
				require: { status: 'OK', canonical: true },
			},
			baseCommitSha: base,
			targetTreeSha: tree,
			artifactStore: fixture.artifacts,
			execCli: () => '',
		});
		assert.equal(res.status, 'PASS');
	} finally {
		fixture.close();
	}
});
