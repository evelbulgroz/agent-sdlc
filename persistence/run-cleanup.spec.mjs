import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createDetachedWorktree } from '../workflow/worktrees.ts';
import { applyBaselineSchema } from './migrations/baseline-schema.ts';
import { cleanMergedRunWorktrees } from './run-cleanup.ts';
import { liveRunRoot } from './run-paths.ts';

function git(cwd, args) {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function setupRepoWithRun(runId) {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdlc-cleanup-'));
	git(rootDir, ['init', '-b', 'main']);
	git(rootDir, ['config', 'user.name', 'Test Operator']);
	git(rootDir, ['config', 'user.email', 'test@example.com']);
	fs.writeFileSync(path.join(rootDir, 'README.md'), 'hello\n');
	git(rootDir, ['add', 'README.md']);
	git(rootDir, ['commit', '-m', 'init']);
	const baseCommitSha = git(rootDir, ['rev-parse', 'HEAD']);

	const runDir = path.join(liveRunRoot(rootDir), runId);
	fs.mkdirSync(path.join(rootDir, 'docs/specs/runs', runId), { recursive: true });
	fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
	fs.writeFileSync(path.join(runDir, 'artifacts', 'sample.json'), '{"ok":true}\n');
	const db = new DatabaseSync(path.join(runDir, 'runtime.sqlite'));
	applyBaselineSchema(db);
	db.close();

	const ledgerDir = path.join(rootDir, 'tools/.model-usage/runs');
	fs.mkdirSync(ledgerDir, { recursive: true });
	const ledgerPath = path.join(ledgerDir, `${runId}.json`);
	fs.writeFileSync(ledgerPath, '{"runId":"' + runId + '"}\n');

	return { rootDir, runDir, baseCommitSha, ledgerPath };
}

// @ac AC-03
test('AC-03: cleanMergedRunWorktrees removes single and multi-task worktrees while keeping run diagnostics', async (t) => {
	// @case AC-03.1
	await t.test(
		'AC-03.1: single-task landed run removes worktree and prunes git worktree list while preserving runtime.sqlite, artifacts, and ledger',
		() => {
			const runId = '2026-11-08-single-cleanup';
			const { rootDir, runDir, baseCommitSha, ledgerPath } = setupRepoWithRun(runId);
			try {
				const wt = createDetachedWorktree({ runId, baseCommitSha, rootDir });
				assert.equal(fs.existsSync(wt.worktreeDir), true);

				const result = cleanMergedRunWorktrees(runId, { rootDir });
				assert.equal(result.ok, true);
				assert.equal(result.skipped, false);
				assert.equal(fs.existsSync(path.join(runDir, 'worktree')), false);

				const worktreeList = git(rootDir, ['worktree', 'list']);
				assert.equal(worktreeList.includes(wt.worktreeDir), false);

				assert.equal(fs.existsSync(path.join(runDir, 'runtime.sqlite')), true);
				assert.equal(fs.existsSync(path.join(runDir, 'artifacts', 'sample.json')), true);
				assert.equal(fs.existsSync(ledgerPath), true);
			} finally {
				fs.rmSync(rootDir, { recursive: true, force: true });
			}
		},
	);

	// @case AC-03.2
	await t.test(
		'AC-03.2: multi-task landed run removes all worktrees/<task-id> and worktrees/integration and prunes git worktree list',
		() => {
			const runId = '2026-11-08-multi-cleanup';
			const { rootDir, runDir, baseCommitSha } = setupRepoWithRun(runId);
			try {
				const wt1 = createDetachedWorktree({
					runId,
					baseCommitSha,
					rootDir,
					worktreeDir: path.join(runDir, 'worktrees', 'task-1'),
				});
				const wt2 = createDetachedWorktree({
					runId,
					baseCommitSha,
					rootDir,
					worktreeDir: path.join(runDir, 'worktrees', 'task-2'),
				});
				const wtIntegration = createDetachedWorktree({
					runId,
					baseCommitSha,
					rootDir,
					worktreeDir: path.join(runDir, 'worktrees', 'integration'),
				});

				const result = cleanMergedRunWorktrees(runId, { rootDir });
				assert.equal(result.ok, true);
				assert.equal(fs.existsSync(wt1.worktreeDir), false);
				assert.equal(fs.existsSync(wt2.worktreeDir), false);
				assert.equal(fs.existsSync(wtIntegration.worktreeDir), false);
				assert.equal(fs.existsSync(path.join(runDir, 'worktrees')), false);

				const worktreeList = git(rootDir, ['worktree', 'list']);
				assert.equal(worktreeList.includes(wt1.worktreeDir), false);
				assert.equal(worktreeList.includes(wt2.worktreeDir), false);
				assert.equal(worktreeList.includes(wtIntegration.worktreeDir), false);
			} finally {
				fs.rmSync(rootDir, { recursive: true, force: true });
			}
		},
	);

	// @case AC-03.3
	await t.test('AC-03.3: running cleanup a second time on an already-cleaned run is a no-op', () => {
		const runId = '2026-11-08-idempotent-cleanup';
		const { rootDir, runDir, baseCommitSha } = setupRepoWithRun(runId);
		try {
			createDetachedWorktree({ runId, baseCommitSha, rootDir });
			const first = cleanMergedRunWorktrees(runId, { rootDir });
			assert.equal(first.ok, true);
			assert.equal(first.removedWorktrees.length, 1);

			const second = cleanMergedRunWorktrees(runId, { rootDir });
			assert.equal(second.ok, true);
			assert.equal(second.skipped, false);
			assert.equal(second.removedWorktrees.length, 0);
			assert.equal(fs.existsSync(path.join(runDir, 'runtime.sqlite')), true);
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	await t.test(
		'reports a worktree under skipped without recursive deletion if git worktree remove fails',
		() => {
			const runId = '2026-11-08-failed-cleanup';
			const { rootDir, baseCommitSha } = setupRepoWithRun(runId);
			try {
				const wt = createDetachedWorktree({ runId, baseCommitSha, rootDir });
				const failingGitCli = (cmd, args, options) => {
					if (Array.isArray(args) && args.includes('worktree') && args.includes('remove')) {
						throw new Error('simulated locked worktree failure');
					}
					return execFileSync(cmd, args, options);
				};

				const result = cleanMergedRunWorktrees(runId, { rootDir, gitCli: failingGitCli });
				assert.equal(result.ok, false);
				assert.equal(result.skipped, true);
				assert.equal(result.skippedWorktrees.length, 1);
				assert.equal(fs.existsSync(wt.worktreeDir), true);
			} finally {
				fs.rmSync(rootDir, { recursive: true, force: true });
			}
		},
	);
});
