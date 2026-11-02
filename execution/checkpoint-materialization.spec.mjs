import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { materializeSliceCheckpoint } from '../workflow/checkpoint-materialization.ts';

test('@case AC-11.4 registers exact enabling snapshot and refuses changed source on reuse', t => {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-checkpoint-'));
	t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
	const git = (args, opts = {}) => execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', ...opts });
	git(['init', '--quiet']);
	git(['config', 'user.name', 'Fixture']);
	git(['config', 'user.email', 'fixture@example.invalid']);
	git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'fixture base']);
	const base = git(['rev-parse', 'HEAD']).trim();
	const baseTree = git(['rev-parse', 'HEAD^{tree}']).trim();
	fs.writeFileSync(path.join(rootDir, 'feature.txt'), 'feature\n');
	git(['add', 'feature.txt']);
	const tree = git(['write-tree']).trim();
	const patch = git(['diff-tree', '-r', '-p', '--binary', baseTree, tree]);
	const taskPlan = {
		slices: [{ sliceId: 'enable', kind: 'enabling', dependsOn: [] }],
		integrationOrder: ['task'],
		tasks: [{ taskId: 'task', sliceId: 'enable', status: 'completed', pathPrefixes: ['feature.txt'],
			parentTreeSha: baseTree, targetTreeSha: tree,
			patchHash: crypto.createHash('sha256').update(patch).digest('hex') }],
	};
	const registrations = [];
	const opts = { runId: '2026-11-01-sdlc-fixture', sliceId: 'enable', taskPlan,
		baseCommitSha: base, rootDir, gitCli: execFileSync, frozen: true,
		register: record => registrations.push(record) };
	const result = materializeSliceCheckpoint(opts);
	assert.equal(result.kind, 'enabling');
	assert.equal(result.treeSha, tree);
	assert.equal(registrations[0].relativePath, `checkpoint-worktrees/${result.checkpointId}`);
	assert.equal(fs.readFileSync(path.join(result.worktreeDir, 'feature.txt'), 'utf8'), 'feature\n');
	assert.equal(materializeSliceCheckpoint(opts).checkpointId, result.checkpointId);
	const revised = materializeSliceCheckpoint({ ...opts, revisionIdentity: 'new-selected-revision-set' });
	assert.notEqual(revised.checkpointId, result.checkpointId);
	assert.notEqual(revised.worktreeDir, result.worktreeDir);
	assert.equal(revised.treeSha, result.treeSha);
	assert.equal(materializeSliceCheckpoint({ ...opts, revisionIdentity: 'new-selected-revision-set' }).checkpointId, revised.checkpointId);
	fs.writeFileSync(path.join(result.worktreeDir, 'feature.txt'), 'tampered\n');
	assert.throws(() => materializeSliceCheckpoint(opts), /changed/);
	assert.throws(() => materializeSliceCheckpoint({ ...opts, frozen: false }), /frozen/);
});
