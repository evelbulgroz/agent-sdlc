import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { captureTaskDelta } from './task-tree-delta.ts';
import { materializeClosureTree } from './eligible-closure.ts';
import { reconcileTasks } from '../workflow/reconciliation.ts';
import { liveRunRoot } from '../persistence/run-paths.ts';

for (const [label, before, after] of [
	['non-UTF8 source', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), Buffer.from([0x63, 0x61, 0x66, 0xe8, 0x0a])],
	['binary diff', Buffer.from([0, 0xff, 1, 0x0a]), Buffer.from([0, 0xfe, 2, 0x0a])],
]) test(`captured ${label} patch preserves raw bytes through closure application`, async t => {
	const fixtures = path.resolve('tools/.agent-sdlc/test-fixtures');
	fs.mkdirSync(fixtures, { recursive: true });
	const rootDir = fs.mkdtempSync(path.join(fixtures, 'delta-bytes-'));
	t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
	const git = (args, options = {}) => execFileSync('git', args, { cwd: rootDir, ...options });
	git(['init', '--quiet']);
	fs.mkdirSync(path.join(rootDir, 'src'));
	fs.writeFileSync(path.join(rootDir, 'src/value'), before);
	git(['add', '.']);
	const parentTreeSha = git(['write-tree']).toString().trim();
	fs.writeFileSync(path.join(rootDir, 'src/value'), after);
	const task = { taskId: 'bytes', pathPrefixes: ['src'], parentTreeSha };
	const delta = captureTaskDelta({ task, worktreeDir: rootDir, rootDir, gitCli: execFileSync, rawPatchHash: true });
	const rawPatch = git(['diff-tree', '-r', '-p', '--binary', parentTreeSha, delta.targetTreeSha]);
	assert.equal(delta.patchHash, crypto.createHash('sha256').update(rawPatch).digest('hex'));
	assert.deepEqual(delta.patch, rawPatch);
	if (label === 'binary diff') assert.match(rawPatch.toString(), /GIT binary patch/);
	const tree = materializeClosureTree({ baseTreeSha: parentTreeSha,
		tasks: [{ ...task, ...delta, status: 'completed' }], rootDir, gitCli: execFileSync });
	assert.equal(tree, delta.targetTreeSha);
	assert.deepEqual(git(['show', `${tree}:src/value`]), after);
	const baseCommitSha = git(['-c', 'user.name=Byte fixture', '-c', 'user.email=bytes@example.invalid',
		'commit-tree', parentTreeSha, '-m', 'fixture base']).toString().trim();
	const runId = `2026-11-02-bytes-${crypto.randomUUID().slice(0, 8)}`;
	fs.mkdirSync(path.join(liveRunRoot(rootDir), runId), { recursive: true });
	fs.mkdirSync(path.join(rootDir, 'docs/specs/runs', runId), { recursive: true });
	const reconciled = await reconcileTasks({
		runId,
		taskPlan: { schemaVersion: '2.0.0', baseCommitSha, integrationOrder: ['bytes'],
			tasks: [{ ...task, ...delta, authoredPaths: ['src'], status: 'completed' }] },
		rootDir, gitCli: execFileSync, taskPlanFrozen: true,
	});
	assert.equal(reconciled.status, 'RECONCILIATION_COMPLETED');
	assert.equal(reconciled.reconciledTreeSha, tree);
	assert.deepEqual(fs.readFileSync(path.join(reconciled.integrationWorktreePath, 'src/value')), after);
});
