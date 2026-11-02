import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { taskQualityFixture } from '../../testing/task-quality-fixture.mjs';
import { sha256 } from '../../policy/contracts.ts';
import { createDefaultAuthorizationEnvelope } from '../../policy/authorization.ts';
import { qaCheckpointAttemptKey } from '../../review/critic-budget.ts';
import { createCreateLocalCommitNode, createVerifyCommittedTreeNode } from './commit.ts';

function fixture(t) {
	const f = taskQualityFixture(t);
	const runtimeDir = path.dirname(f.artifacts.artifactsDir);
	const cwd = f.worktreeDir;
	const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	git(['checkout', '-b', 'delivery']);
	const remote = path.join(runtimeDir, 'origin.git');
	git(['init', '--bare', '--quiet', remote]);
	git(['remote', 'add', 'origin', remote]);
	const binding = {
		runId: f.runId, approvedSpecHash: f.snapshot.approvedSpecHash, taskPlanHash: f.snapshot.taskPlanHash,
		qualityPolicyHash: sha256(f.plan.qualityPolicy), checkpointId: 'final', checkpointKind: 'final',
		ownerId: null, candidateRevision: 0, baseCommitSha: f.base, treeSha: f.tree,
		revisionSetHash: 'a'.repeat(64), preparationHash: 'a'.repeat(64),
	};
	const snapshot = {
		...f.snapshot, state: 'VERIFYING_COMMITTED_TREE', worktreePath: cwd, targetTreeSha: f.tree,
		qualityPolicy: f.plan.qualityPolicy, qualityCheckpointId: 'final', qualityCheckpointKind: 'final',
		qualityCheckpointTreeSha: f.tree, qualityCheckpointBindingHash: sha256(binding),
		preflightBindingArtifact: f.artifacts.writeJson('preflight', { status: 'OK', canonical: true, targetTreeSha: f.tree }),
	};
	const commitRecord = { commitSha: f.base, treeSha: f.tree, targetBranch: 'delivery', message: 'approved' };
	const auth = createDefaultAuthorizationEnvelope({
		runId: f.runId, approvedSpecHash: snapshot.approvedSpecHash, repositoryId: 'fixture/repo',
		baseCommitSha: f.base, allowedPackages: ['src'], allowedPathPrefixes: ['src'],
		qualityPlan: f.auth.qualityPlan, rootDir: f.rootDir, now: f.runtime.now(),
		targetBranch: 'delivery', createBranch: true, createLocalCommits: true, push: true,
	});
	snapshot.approvedPlanPolicyHash = auth.approvedPlanPolicyHash;
	f.store.getAuthorization = () => auth;
	f.store.getGitCommit = () => commitRecord;
	f.store.quality.listClosures = () => [{
		binding, status: 'accepted', selectedRevisions: [], receiptHashes: ['a'.repeat(64)], registryId: 'final',
	}];
	f.store.quality.getWorktree = () => ({
		bindingHash: sha256(binding), kind: 'final', ownerId: null,
		relativePath: path.relative(runtimeDir, cwd),
	});
	const payload = {
		qualityCheckpointBindingHash: sha256(binding), qualityCheckpointTreeSha: f.tree,
		qualityPolicyHash: binding.qualityPolicyHash, coveragePass: true, status: 'PASS',
		attemptKey: qaCheckpointAttemptKey({ approvedSpecHash: snapshot.approvedSpecHash,
			taskPlanHash: snapshot.taskPlanHash, checkpointKind: 'final', treeSha: f.tree }),
	};
	f.store.listEvents = () => ['AC_COVERAGE_PASSED', 'QA_CRITIC_COMPLETED'].map(eventType =>
		({ eventType, runtimeRevision: 1, payload }));
	const runtime = { ...f.runtime, currentOrAlreadyAdvanced: () => null, execCli: () => '' };
	const move = () => {
		const moved = git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
			'commit-tree', f.tree, '-p', f.base, '-m', 'unreviewed same-tree recommit']);
		git(['update-ref', 'refs/heads/delivery', moved]);
		return moved;
	};
	const remoteHead = () => {
		try { return git(['--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/delivery']); }
		catch { return null; }
	};
	return { ...f, runtime, snapshot, commitRecord, git, move, remoteHead };
}

test('graph pushes the exact recorded commit even if the branch moves at push invocation', async t => {
	const f = fixture(t);
	let pushed;
	f.runtime.gitCli = (command, args, options) => {
		if (args[0] === 'push') {
			pushed = args;
			f.move();
		}
		return execFileSync(command, args, options);
	};
	const result = await createVerifyCommittedTreeNode(f.runtime)({ snapshot: f.snapshot });
	assert.equal(result.snapshot.state, 'DONE');
	assert.deepEqual(pushed, ['push', 'origin', `${f.base}:refs/heads/delivery`]);
	assert.equal(f.remoteHead(), f.base);
	assert.notEqual(f.git(['rev-parse', 'delivery']), f.base);
});

test('graph rejects same-tree branch drift after the verifier and before push', async t => {
	const f = fixture(t);
	f.runtime.execCli = () => { f.move(); return ''; };
	const result = await createVerifyCommittedTreeNode(f.runtime)({ snapshot: f.snapshot });
	assert.equal(result.snapshot.state, 'FAILED');
	assert.equal(result.snapshot.lastError.code, 'POLICY_VIOLATION');
	assert.equal(f.remoteHead(), null);
});

test('reused local commits reject moved branches before advancing', async t => {
	const f = fixture(t);
	f.move();
	await assert.rejects(createCreateLocalCommitNode(f.runtime)({ snapshot: f.snapshot }),
		{ code: 'POLICY_VIOLATION' });
	assert.equal(f.remoteHead(), null);
});

test('reused local commits reject a record outside the approved branch or tree', async t => {
	const f = fixture(t);
	for (const change of [{ targetBranch: 'foreign' }, { treeSha: 'a'.repeat(40) }]) {
		const original = { ...f.commitRecord };
		Object.assign(f.commitRecord, change);
		await assert.rejects(createCreateLocalCommitNode(f.runtime)({ snapshot: f.snapshot }),
			{ code: 'POLICY_VIOLATION' });
		Object.assign(f.commitRecord, original);
	}
});

test('reuses an unchanged approved commit without creating or publishing another commit', async t => {
	const f = fixture(t);
	const result = await createCreateLocalCommitNode(f.runtime)({ snapshot: f.snapshot });
	assert.equal(result.snapshot.state, 'VERIFYING_COMMITTED_TREE');
	assert.equal(f.git(['rev-parse', 'delivery']), f.base);
	assert.equal(f.remoteHead(), null);
});

test('quality committed verification rejects a missing record before command execution', async t => {
	const f = fixture(t);
	f.store.getGitCommit = () => null;
	let commands = 0;
	f.runtime.execCli = () => { commands++; return ''; };
	await assert.rejects(createVerifyCommittedTreeNode(f.runtime)({ snapshot: f.snapshot }),
		{ code: 'POLICY_VIOLATION' });
	assert.equal(commands, 0);
	assert.equal(f.remoteHead(), null);
});
