import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import {
	assertPathContained,
	cleanWorktree,
	createDetachedWorktree,
	createSyntheticCommit,
	isWorktreeClean,
	removeWorktree,
	resolveIntegrationWorktreeDir,
	resolveTaskWorktreeDir,
	resolveWorktreeDir,
} from './worktrees.ts';

test('resolveWorktreeDir computes path under tools/.agent-sdlc/<run-id>/worktree', () => {
	const runId = '2026-09-04-worktree-path-test';
	const dir = resolveWorktreeDir(runId);
	assert.ok(dir.endsWith(path.join('tools/.agent-sdlc', runId, 'worktree')));
});

test('assertPathContained allows contained files and rejects path traversal and escapes', () => {
	const worktreeDir = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`containment-${crypto.randomUUID()}`,
	);
	fs.mkdirSync(worktreeDir, { recursive: true });

	try {
		// Valid inside
		const filePath = path.join(worktreeDir, 'apps/services/conditioning/src/file.ts');
		assert.equal(assertPathContained(worktreeDir, 'apps/services/conditioning/src/file.ts'), filePath);

		// Escape via relative ..
		assert.throws(
			() => assertPathContained(worktreeDir, '../../outside.txt'),
			(error) => error.code === 'PATH_CONTAINMENT_VIOLATION',
		);

		// Escape via absolute path
		assert.throws(
			() => assertPathContained(worktreeDir, '/etc/passwd'),
			(error) => error.code === 'PATH_CONTAINMENT_VIOLATION',
		);
	} finally {
		fs.rmSync(worktreeDir, { recursive: true, force: true });
	}
});

test('createDetachedWorktree invokes git with explicit argument arrays and safely reuses existing checkouts', () => {
	const runId = '2026-09-04-wt-create-test';
	const baseCommitSha = 'a'.repeat(40);
	const worktreeDir = resolveWorktreeDir(runId);

	const calls = [];
	const mockGitCli = (cmd, args, opts) => {
		calls.push({ cmd, args, cwd: opts?.cwd });
		if (args[0] === 'rev-parse') {
			return baseCommitSha + '\n';
		}
		if (args[0] === 'worktree' && args[1] === 'add') {
			fs.mkdirSync(args[3], { recursive: true });
			return '';
		}
		return '';
	};

	try {
		// 1. Initial creation
		const result = createDetachedWorktree({
			runId,
			baseCommitSha,
			gitCli: mockGitCli,
		});

		assert.equal(result.worktreeDir, worktreeDir);
		assert.equal(result.baseCommitSha, baseCommitSha);
		assert.equal(result.reused, false);

		// Verify git command arguments
		const addCall = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
		assert.ok(addCall);
		assert.deepEqual(addCall.args, ['worktree', 'add', '--detach', worktreeDir, baseCommitSha]);

		// 2. Safe reuse on subsequent call
		const reuseResult = createDetachedWorktree({
			runId,
			baseCommitSha,
			gitCli: mockGitCli,
		});
		assert.equal(reuseResult.reused, true);

		// 3. Mismatched commit on existing checkout throws
		const wrongGitCli = (cmd, args) => {
			if (args[0] === 'rev-parse') return 'b'.repeat(40) + '\n';
			return '';
		};
		assert.throws(
			() =>
				createDetachedWorktree({
					runId,
					baseCommitSha,
					gitCli: wrongGitCli,
				}),
			(error) => error.code === 'WORKTREE_FAILED',
		);

		// 4. Reuse after local commit when expectedCommitSha matches HEAD
		const committedSha = 'c'.repeat(40);
		const committedGitCli = (cmd, args) => {
			if (args[0] === 'rev-parse' && args[1] === 'HEAD') return committedSha + '\n';
			if (args[0] === 'branch') return 'agent-sdlc/reuse-commit\n';
			return '';
		};
		const committedReuse = createDetachedWorktree({
			runId,
			baseCommitSha,
			expectedCommitSha: committedSha,
			targetBranch: 'agent-sdlc/reuse-commit',
			gitCli: committedGitCli,
		});
		assert.equal(committedReuse.reused, true);
		assert.equal(committedReuse.commitSha, committedSha);
	} finally {
		if (fs.existsSync(worktreeDir)) {
			fs.rmSync(worktreeDir, { recursive: true, force: true });
		}
	}
});

test('isWorktreeClean and removeWorktree respect dirty state and force flags', () => {
	const runId = '2026-09-04-wt-remove-test';
	const worktreeDir = resolveWorktreeDir(runId);
	fs.mkdirSync(worktreeDir, { recursive: true });

	let statusOutput = '';
	const mockGitCli = (cmd, args) => {
		if (args[0] === 'status') return statusOutput;
		return '';
	};

	try {
		// Clean worktree
		assert.equal(isWorktreeClean(worktreeDir, { gitCli: mockGitCli }), true);

		// Dirty worktree
		statusOutput = ' M apps/services/conditioning/src/file.ts\n';
		assert.equal(isWorktreeClean(worktreeDir, { gitCli: mockGitCli }), false);

		// Remove without force on dirty worktree throws WORKTREE_DIRTY
		assert.throws(
			() => removeWorktree(runId, { force: false, gitCli: mockGitCli }),
			(error) => error.code === 'WORKTREE_DIRTY',
		);

		// Remove with force succeeds
		const result = removeWorktree(runId, { force: true, gitCli: mockGitCli });
		assert.equal(result.removed, true);
	} finally {
		if (fs.existsSync(worktreeDir)) {
			fs.rmSync(worktreeDir, { recursive: true, force: true });
		}
	}
});

test('resolveTaskWorktreeDir and resolveIntegrationWorktreeDir compute correct paths and validate inputs', () => {
	const runId = '2026-09-04-wt-path-test';
	const taskDir = resolveTaskWorktreeDir(runId, 'conditioning-task');
	assert.ok(taskDir.endsWith(path.join('tools/.agent-sdlc', runId, 'worktrees', 'conditioning-task')));

	const integrationDir = resolveIntegrationWorktreeDir(runId);
	assert.ok(integrationDir.endsWith(path.join('tools/.agent-sdlc', runId, 'worktrees', 'integration')));

	assert.throws(
		() => resolveTaskWorktreeDir(runId, 'invalid task id!'),
		(error) => error.code === 'TASK_PLAN_INVALID',
	);
});

test('createSyntheticCommit executes git commit-tree with tree and parent arguments', () => {
	const parentTreeSha = '1'.repeat(40);
	const baseCommitSha = '2'.repeat(40);
	const syntheticSha = '3'.repeat(40);

	const calls = [];
	const mockGitCli = (cmd, args, opts) => {
		calls.push({ cmd, args, cwd: opts?.cwd });
		return syntheticSha + '\n';
	};

	const resultSha = createSyntheticCommit({
		parentTreeSha,
		baseCommitSha,
		message: 'sdlc intermediate parent for test-task',
		gitCli: mockGitCli,
	});

	assert.equal(resultSha, syntheticSha);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].cmd, 'git');
	assert.deepEqual(calls[0].args, [
		'commit-tree',
		parentTreeSha,
		'-p',
		baseCommitSha,
		'-m',
		'sdlc intermediate parent for test-task',
	]);

	// Rejects invalid SHA
	assert.throws(
		() =>
			createSyntheticCommit({
				parentTreeSha: 'invalid',
				baseCommitSha,
				gitCli: mockGitCli,
			}),
		(error) => error.code === 'WORKTREE_FAILED',
	);
});

test('cleanWorktree executes git checkout -- . and git clean -fdx without git reset --hard', () => {
	const commands = [];
	const mockGitCli = (cmd, args, opts) => {
		commands.push({ cmd, args, cwd: opts?.cwd });
		return '';
	};

	const worktreeDir = '/fake/worktree';
	cleanWorktree(worktreeDir, { gitCli: mockGitCli });

	assert.equal(commands.length, 2);
	assert.equal(commands[0].cmd, 'git');
	assert.deepEqual(commands[0].args, ['checkout', '--', '.']);
	assert.equal(commands[0].cwd, worktreeDir);
	assert.equal(commands[1].cmd, 'git');
	assert.deepEqual(commands[1].args, ['clean', '-fdx']);
	assert.equal(commands[1].cwd, worktreeDir);
});

test('createDetachedWorktree and removeWorktree support task-scoped subdirs', () => {
	const runId = '2026-09-04-wt-create-remove-test';
	const baseCommitSha = 'a'.repeat(40);
	const syntheticSha = 'b'.repeat(40);
	const taskDir = resolveTaskWorktreeDir(runId, 'assessment-task');

	const calls = [];
	const mockGitCli = (cmd, args, opts) => {
		calls.push({ cmd, args, cwd: opts?.cwd });
		if (args[0] === 'rev-parse') return syntheticSha + '\n';
		if (args[0] === 'worktree' && args[1] === 'add') {
			fs.mkdirSync(args[3], { recursive: true });
			return '';
		}
		if (args[0] === 'status') return '';
		return '';
	};

	try {
		const created = createDetachedWorktree({
			runId,
			baseCommitSha,
			commitSha: syntheticSha,
			worktreeDir: taskDir,
			gitCli: mockGitCli,
		});

		assert.equal(created.worktreeDir, taskDir);
		assert.equal(created.commitSha, syntheticSha);
		assert.equal(created.reused, false);

		const addCall = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
		assert.ok(addCall);
		assert.deepEqual(addCall.args, ['worktree', 'add', '--detach', taskDir, syntheticSha]);

		// Remove task worktree
		const removed = removeWorktree(runId, {
			worktreeDir: taskDir,
			gitCli: mockGitCli,
		});
		assert.equal(removed.removed, true);
	} finally {
		if (fs.existsSync(taskDir)) {
			fs.rmSync(taskDir, { recursive: true, force: true });
		}
	}
});

test('live git: index inside linked worktree .git fails with ENOTDIR while outside index succeeds', () => {
	const runId = `2026-09-07-live-git-idx-test-${process.pid}-${Date.now()}`;
	const rootDir = REPOSITORY_ROOT;
	const runDir = path.join(rootDir, 'tools/.agent-sdlc', runId);
	const worktreeDir = path.join(runDir, 'worktrees', 'test-task');

	try {
		fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
		const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
			cwd: rootDir,
			encoding: 'utf8',
		}).trim();

		execFileSync('git', ['worktree', 'add', '--detach', worktreeDir, headSha], {
			cwd: rootDir,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		// 1. Verify .git is a file, not a directory
		const gitPath = path.join(worktreeDir, '.git');
		assert.ok(fs.existsSync(gitPath));
		const stat = fs.lstatSync(gitPath);
		assert.ok(stat.isFile(), '.git in a linked worktree must be a file');

		// 2. Writing into .git/temp-index throws ENOTDIR
		const insideIndex = path.join(gitPath, 'temp.index');
		assert.throws(
			() => fs.writeFileSync(insideIndex, 'content'),
			(err) => err.code === 'ENOTDIR',
		);

		// 3. Temporary index outside worktree succeeds with read-tree and write-tree
		const outsideIndex = path.join(runDir, '.test.index');
		const env = { ...process.env, GIT_INDEX_FILE: outsideIndex };
		try {
			execFileSync('git', ['read-tree', headSha], {
				cwd: worktreeDir,
				env,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			const treeSha = execFileSync('git', ['write-tree'], {
				cwd: worktreeDir,
				env,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			}).trim();
			assert.ok(/^[a-f0-9]{40}$/.test(treeSha));
		} finally {
			if (fs.existsSync(outsideIndex)) fs.unlinkSync(outsideIndex);
		}
	} finally {
		try {
			execFileSync('git', ['worktree', 'remove', '--force', worktreeDir], {
				cwd: rootDir,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch {}
		if (fs.existsSync(runDir)) {
			fs.rmSync(runDir, { recursive: true, force: true });
		}
	}
});

