import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
	checkBranchCollision,
	createLocalBranch,
	createLocalCommit,
	formatCommitMessage,
	pushBranch,
	validateBranchName,
} from './git-manager.ts';
import { createDetachedWorktree, resolveWorktreeDir } from './worktrees.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

function setupRepoWithWorktree(testDir, runId = '2026-09-06-commit-test') {
	const repoDir = path.join(testDir, 'repo');
	fs.mkdirSync(path.join(testDir, 'docs/specs/runs'), { recursive: true });
	fs.mkdirSync(repoDir, { recursive: true });

	execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
	execFileSync('git', ['config', 'user.email', 'test@example.local'], { cwd: repoDir });
	execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoDir });

	fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Repo\n');
	fs.mkdirSync(path.join(repoDir, 'apps/services/conditioning/src'), { recursive: true });
	fs.writeFileSync(
		path.join(repoDir, 'apps/services/conditioning/src/index.ts'),
		'export const v = 1;\n',
	);
	execFileSync('git', ['add', '-A'], { cwd: repoDir });
	execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repoDir });

	const baseCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
		cwd: repoDir,
		encoding: 'utf8',
	}).trim();

	const worktreeDir = resolveWorktreeDir(runId, testDir);
	fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });

	// Add worktree
	execFileSync('git', ['worktree', 'add', '--detach', worktreeDir, baseCommitSha], {
		cwd: repoDir,
	});

	return { repoDir, worktreeDir, baseCommitSha };
}

test('validateBranchName validates safe git branch names', () => {
	assert.equal(validateBranchName('agent-sdlc/feat-1'), 'agent-sdlc/feat-1');
	assert.equal(validateBranchName('feature/my_branch-2.0'), 'feature/my_branch-2.0');

	assert.throws(() => validateBranchName(''), /Invalid git branch name/);
	assert.throws(() => validateBranchName('../escape'), /Invalid git branch name/);
	assert.throws(() => validateBranchName('branch//name'), /Invalid git branch name/);
	assert.throws(() => validateBranchName('branch@{1}'), /Invalid git branch name/);
	assert.throws(() => validateBranchName('branch/'), /Invalid git branch name/);
	assert.throws(() => validateBranchName('branch.lock'), /Invalid git branch name/);
});

test('createLocalBranch creates local branch and rejects collision', () => {
	const tempDir = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`git-branch-${crypto.randomUUID()}`,
	);
	try {
		const { repoDir, worktreeDir, baseCommitSha } = setupRepoWithWorktree(tempDir);

		// 1. Successful branch creation
		const result = createLocalBranch({
			worktreeDir,
			baseCommitSha,
			branchName: 'agent-sdlc/run-01',
			rootDir: repoDir,
		});
		assert.equal(result.branchName, 'agent-sdlc/run-01');
		assert.equal(result.created, true);

		// 2. Re-invoking while on same branch reuses cleanly
		const reused = createLocalBranch({
			worktreeDir,
			baseCommitSha,
			branchName: 'agent-sdlc/run-01',
			rootDir: repoDir,
		});
		assert.equal(reused.reused, true);

		// 3. Collision with primary branch
		assert.throws(
			() =>
				checkBranchCollision({
					branchName: 'main',
					rootDir: repoDir,
				}),
			/already exists/i,
		);

		// 4. Collision with checked out branch
		assert.throws(
			() =>
				checkBranchCollision({
					branchName: 'agent-sdlc/run-01',
					rootDir: repoDir,
				}),
			/already exists/i,
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('formatCommitMessage produces conventional commit with Directive 11 sections', () => {
	const msg = formatCommitMessage({
		spec: {
			goal: 'Add dynamic critic review adapter',
			owningContext: 'agent-sdlc',
		},
		decisions: [
			{ topic: 'Module system', chosen: 'Node.js ESM' },
			{ topic: 'Test framework', chosen: 'node:test' },
		],
		repairs: 1,
	});

	assert.ok(msg.startsWith('feat(agent-sdlc): Add dynamic critic review adapter'));
	assert.ok(msg.includes('Decisions:'));
	assert.ok(msg.includes('- Module system: Node.js ESM'));
	assert.ok(msg.includes('- Test framework: node:test'));
	assert.ok(msg.includes('Remaining:\n- none'));
	assert.ok(msg.includes('Tried:\n- completed after 1 semantic repair attempt(s)'));
});

test('createLocalCommit stages changes, verifies containment, and commits', () => {
	const tempDir = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`git-commit-${crypto.randomUUID()}`,
	);
	try {
		const { repoDir, worktreeDir, baseCommitSha } = setupRepoWithWorktree(tempDir);

		createLocalBranch({
			worktreeDir,
			baseCommitSha,
			branchName: 'agent-sdlc/commit-test',
			rootDir: repoDir,
		});

		// 1. Empty diff handling
		const emptyCommit = createLocalCommit({
			worktreeDir,
			message: 'feat: empty change',
			allowedPackages: ['apps/services/conditioning'],
		});
		assert.equal(emptyCommit.committed, false);
		assert.equal(emptyCommit.reason, 'NO_CHANGES_STAGED');

		// 2. Modify authorized file and unauthorized file
		fs.writeFileSync(
			path.join(worktreeDir, 'apps/services/conditioning/src/index.ts'),
			'export const v = 2;\n',
		);
		fs.writeFileSync(path.join(worktreeDir, 'unauthorized.txt'), 'leaked');

		// 3. Containment check fails closed if unauthorized path staged
		execFileSync('git', ['add', 'unauthorized.txt'], { cwd: worktreeDir });
		assert.throws(
			() =>
				createLocalCommit({
					worktreeDir,
					message: 'feat: illegal stage',
					allowedPathPrefixes: ['apps/services/conditioning'],
					allowedPackages: ['apps/services/conditioning'],
				}),
			/outside allowed paths/,
		);

		// 4. Successful commit with authorized changes only
		const commitResult = createLocalCommit({
			worktreeDir,
			message: 'feat(conditioning): update version',
			allowedPackages: ['apps/services/conditioning'],
			authorName: 'sdlc-agent',
			authorEmail: 'agent@sdlc.local',
		});

		assert.equal(commitResult.committed, true);
		assert.match(commitResult.commitSha, /^[a-f0-9]{40}$/);
		assert.match(commitResult.treeSha, /^[a-f0-9]{40}$/);
		assert.notEqual(commitResult.commitSha, baseCommitSha);
		assert.equal(commitResult.branchName, 'agent-sdlc/commit-test');
		assert.deepEqual(commitResult.stagedFiles, ['apps/services/conditioning/src/index.ts']);

		// Verify author attribution
		const authorLog = execFileSync('git', ['log', '-1', '--format=%an <%ae>'], {
			cwd: worktreeDir,
			encoding: 'utf8',
		}).trim();
		assert.equal(authorLog, 'sdlc-agent <agent@sdlc.local>');

		// 5. Worktree reuse post-commit: accepts headOutput === commitSha
		const reused = createDetachedWorktree({
			runId: '2026-09-06-commit-test',
			baseCommitSha,
			expectedCommitSha: commitResult.commitSha,
			targetBranch: 'agent-sdlc/commit-test',
			rootDir: tempDir,
		});
		assert.equal(reused.reused, true);
		assert.equal(reused.commitSha, commitResult.commitSha);
		assert.equal(reused.branch, 'agent-sdlc/commit-test');
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('pushBranch executes git push with tracking branch and handles shadow paths', () => {
	// 1. Happy path: mock git CLI verifies arguments
	const commands = [];
	const mockGitCli = (cmd, args) => {
		commands.push({ cmd, args });
		return '';
	};

	const result = pushBranch({
		worktreeDir: '/tmp/worktree',
		branchName: 'agent-sdlc/run-42',
		remote: 'origin',
		gitCli: mockGitCli,
	});

	assert.equal(result.pushed, true);
	assert.equal(result.branchName, 'agent-sdlc/run-42');
	assert.equal(result.remote, 'origin');
	assert.equal(commands.length, 1);
	assert.equal(commands[0].cmd, 'git');
	assert.deepEqual(commands[0].args, ['push', '-u', 'origin', 'agent-sdlc/run-42']);

	// 2. Invalid branch name
	assert.throws(
		() =>
			pushBranch({
				worktreeDir: '/tmp/worktree',
				branchName: '../escape',
				gitCli: mockGitCli,
			}),
		/Invalid git branch name/,
	);

	// 3. Invalid remote name
	assert.throws(
		() =>
			pushBranch({
				worktreeDir: '/tmp/worktree',
				branchName: 'agent-sdlc/run-42',
				remote: 'invalid remote; rm -rf',
				gitCli: mockGitCli,
			}),
		/Invalid git remote name/,
	);

	// 4. Upstream error path: git push fails
	const failingGitCli = () => {
		throw new Error('remote: Permission to user/repo.git denied to token');
	};
	assert.throws(
		() =>
			pushBranch({
				worktreeDir: '/tmp/worktree',
				branchName: 'agent-sdlc/run-42',
				gitCli: failingGitCli,
			}),
		/GIT_PUSH_FAILED/,
	);
});

