import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { makeFixture } from '../testing/test-support.mjs';
import { reconcileTasks } from './reconciliation.ts';

test('quality reconciliation rejects completed tasks without a captured delta', async () => {
	const fixture = makeFixture('recon-missing-quality-delta', []);
	const baseCommitSha = 'a'.repeat(40);
	try {
		await assert.rejects(
			() => reconcileTasks({
				runId: fixture.runId,
				taskPlan: {
					schemaVersion: '2.0.0',
					runId: fixture.runId,
					baseCommitSha,
					tasks: [{
						taskId: 'task-one',
						status: 'completed',
						parentTreeSha: null,
						targetTreeSha: null,
						patchHash: null,
						pathPrefixes: ['src'],
					}],
					integrationOrder: ['task-one'],
				},
				rootDir: fixture.runtime.rootDir,
				gitCli(_command, args) {
					if (args[0] === 'rev-parse' && args[1] === 'HEAD') return `${baseCommitSha}\n`;
					if (args[0] === 'worktree' && args[1] === 'add') {
						fs.mkdirSync(args[3], { recursive: true });
						return '';
					}
					return '';
				},
				taskPlanFrozen: true,
			}),
			(error) => error.code === 'INVALID_CONTRACT',
		);
	} finally {
		fixture.close();
	}
});

test('quality reconciliation rejects a patch hash inconsistent with its selected trees', async () => {
	const fixture = makeFixture('recon-wrong-quality-patch-hash', []);
	const baseCommitSha = 'a'.repeat(40);
	try {
		await assert.rejects(
			() => reconcileTasks({
				runId: fixture.runId,
				taskPlan: {
					schemaVersion: '2.0.0',
					runId: fixture.runId,
					baseCommitSha,
					tasks: [{
						taskId: 'task-one',
						status: 'completed',
						parentTreeSha: 'b'.repeat(40),
						targetTreeSha: 'c'.repeat(40),
						patchHash: 'd'.repeat(64),
						pathPrefixes: ['src'],
					}],
					integrationOrder: ['task-one'],
				},
				rootDir: fixture.runtime.rootDir,
				gitCli(_command, args) {
					if (args[0] === 'worktree' && args[1] === 'add') {
						fs.mkdirSync(args[3], { recursive: true });
						return '';
					}
					if (args[0] === 'rev-parse') return `${baseCommitSha}\n`;
					if (args[0] === 'diff-tree' && args.includes('-p')) return Buffer.from('captured patch\n');
					return '';
				},
				taskPlanFrozen: true,
			}),
			(error) => error.code === 'INVALID_CONTRACT',
		);
	} finally {
		fixture.close();
	}
});

test('quality reconciliation does not use legacy path prefixes as v2 authored-path authorization', async () => {
	const fixture = makeFixture('recon-v2-authored-paths', []);
	const baseCommitSha = 'a'.repeat(40);
	const patch = 'captured patch\n';
	try {
		await assert.rejects(
			() => reconcileTasks({
				runId: fixture.runId,
				taskPlan: {
					schemaVersion: '2.0.0',
					runId: fixture.runId,
					baseCommitSha,
					tasks: [{
						taskId: 'task-one',
						status: 'completed',
						parentTreeSha: 'b'.repeat(40),
						targetTreeSha: 'c'.repeat(40),
						patchHash: crypto.createHash('sha256').update(patch, 'utf8').digest('hex'),
						pathPrefixes: ['src'],
						authoredPaths: ['allowed'],
					}],
					integrationOrder: ['task-one'],
				},
				rootDir: fixture.runtime.rootDir,
				gitCli(_command, args) {
					if (args[0] === 'worktree' && args[1] === 'add') {
						fs.mkdirSync(args[3], { recursive: true });
						return '';
					}
					if (args[0] === 'rev-parse') return `${baseCommitSha}\n`;
					if (args[0] === 'diff-tree' && args.includes('-p')) return Buffer.from(patch);
					if (args[0] === 'diff-tree' && args[1] === '--name-only') return 'src/file.ts\n';
					return '';
				},
				taskPlanFrozen: true,
			}),
			(error) => error.code === 'PATH_CONTAINMENT_VIOLATION',
		);
	} finally {
		fixture.close();
	}
});
