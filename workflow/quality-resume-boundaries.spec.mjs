import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { prepareTaskWorktree } from '../execution/task-worktree-preparation.ts';
import { taskQualityFixture } from '../testing/task-quality-fixture.mjs';
import { createDetachedWorktree, createSyntheticCommit } from './worktrees.ts';

test('active quality task retains parent provenance across unrelated SQLite status updates', t => {
	const f = taskQualityFixture(t);
	f.store.updateTaskStatus(f.runId, 'vertical-task', {
		status: 'in_progress', parentTreeSha: f.tree, parentCommitSha: f.base,
	});
	assert.equal(f.store.getTask(f.runId, 'vertical-task').parentTreeSha, f.tree);
	f.store.updateTaskStatus(f.runId, 'vertical-task', { repairCount: 1 });
	assert.equal(f.store.getTask(f.runId, 'vertical-task').parentTreeSha, f.tree);
	assert.equal(f.store.getTaskPlan(f.runId).tasks[1].parentTreeSha, f.tree);
	f.store.updateTaskStatus(f.runId, 'vertical-task', { status: 'pending' });
	assert.equal(f.store.getTask(f.runId, 'vertical-task').parentTreeSha, null);
});

for (const previousParentTreeSha of [null, undefined]) test(
	`derived task preparation validates a persisted commit tree when prior tree is ${previousParentTreeSha}`,
	async t => {
	const f = taskQualityFixture(t);
	fs.writeFileSync(path.join(f.rootDir, 'src/a.ts'), 'export const value = 2;\n');
	execFileSync('git', ['add', 'src/a.ts'], { cwd: f.rootDir });
	const parentTreeSha = execFileSync('git', ['write-tree'], { cwd: f.rootDir, encoding: 'utf8' }).trim();
	const task = { ...f.plan.tasks[1], parentCommitSha: f.base };
	const worktreeDir = path.join(path.dirname(f.worktreeDir), 'parent-validation');
	const preparation = { task, taskPlan: f.plan, authorization: f.auth, snapshot: f.snapshot,
		runId: f.runId, worktreeDir, parentTreeSha, previousParentTreeSha, useDerivedParent: true,
		rootDir: f.rootDir, gitCli: execFileSync, execCli: f.runtime.execCli, runtimeStore: f.store };
	await prepareTaskWorktree(preparation);
	assert.equal(execFileSync('git', ['rev-parse', 'HEAD^{tree}'],
		{ cwd: worktreeDir, encoding: 'utf8' }).trim(), parentTreeSha);
	assert.notEqual(task.parentCommitSha, f.base);
	const pinnedParent = task.parentCommitSha;
	await prepareTaskWorktree(preparation);
	assert.equal(task.parentCommitSha, pinnedParent);
});

test('synthetic parent identity is deterministic across wall clock and ambient identity changes', t => {
	const f = taskQualityFixture(t);
	const options = { parentTreeSha: f.tree, baseCommitSha: f.base, message: 'pinned correction parent',
		rootDir: f.rootDir, gitCli: execFileSync };
	const previous = { ...process.env };
	t.after(() => { process.env = previous; });
	process.env.GIT_AUTHOR_DATE = '2026-11-01T10:00:00Z';
	process.env.GIT_COMMITTER_DATE = '2026-11-01T10:00:00Z';
	const first = createSyntheticCommit(options);
	const worktreeDir = path.join(path.dirname(f.worktreeDir), 'pinned-parent');
	createDetachedWorktree({ ...options, runId: f.runId, commitSha: first, worktreeDir });
	process.env.GIT_AUTHOR_DATE = '2026-11-01T10:00:01Z';
	process.env.GIT_COMMITTER_DATE = '2026-11-01T10:00:01Z';
	process.env.GIT_AUTHOR_NAME = 'A different operator';
	const recovered = createSyntheticCommit(options);
	assert.equal(recovered, first);
	assert.equal(createDetachedWorktree({ ...options, runId: f.runId, commitSha: recovered, worktreeDir }).reused, true);
	assert.notEqual(createSyntheticCommit({ ...options, message: 'different provenance' }), first);
});
