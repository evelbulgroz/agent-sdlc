import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loopInput, openLoop, readTranscripts } from '../testing/minimal-executor-fixtures.ts';
import { deleteFileTool } from './tool-mutations.ts';
import { taskAuthoredWritePaths, taskMutationAllowlist } from './task-scope.ts';

const authored = 'services/billing/src/keep.ts';
const removed = 'services/billing/src/old.ts';
const sibling = 'services/billing/src/sibling.ts';

function deletionTask() {
	return {
		authoredPaths: [authored],
		pathPrefixes: ['services/billing', removed],
		removedPaths: [removed],
	};
}

test('delete_file removes a declared path and rejects a sibling under the broad prefix', () => {
	const task = deletionTask();
	assert.deepEqual(taskAuthoredWritePaths(task), [authored]);
	const allowedPathPrefixes = taskMutationAllowlist(task);
	assert.deepEqual(allowedPathPrefixes, [authored, removed]);
	const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'removed-delete-'));
	try {
		fs.mkdirSync(path.dirname(path.join(worktreeDir, removed)), { recursive: true });
		fs.writeFileSync(path.join(worktreeDir, authored), 'keep\n');
		fs.writeFileSync(path.join(worktreeDir, removed), 'old\n');
		fs.writeFileSync(path.join(worktreeDir, sibling), 'sibling\n');
		assert.equal(deleteFileTool({ path: removed }, { worktreeDir, allowedPathPrefixes }).deleted, true);
		assert.equal(fs.existsSync(path.join(worktreeDir, removed)), false);
		assert.throws(
			() => deleteFileTool({ path: sibling }, { worktreeDir, allowedPathPrefixes }),
			(error) => error.code === 'PATH_CONTAINMENT_VIOLATION',
		);
		assert.equal(fs.existsSync(path.join(worktreeDir, sibling)), true);
	} finally {
		fs.rmSync(worktreeDir, { recursive: true, force: true });
	}
});

test('completion names a removed path that is still on disk and continues when it is absent', async () => {
	const present = openLoop({
		label: 'removed-still-present',
		script: Array.from({ length: 4 }, () => ({ action: { kind: 'complete', summary: 'candidate' } })),
		execCli: () => {
			throw new Error('verification ran before the removed path was absent');
		},
	});
	const absent = openLoop({
		label: 'removed-already-absent',
		script: [
			{ action: { kind: 'complete', summary: 'candidate' } },
			{ action: { kind: 'complete', summary: 'audited' } },
		],
		execCli: () => '',
	});
	try {
		fs.mkdirSync(path.dirname(path.join(present.worktreeDir, removed)), { recursive: true });
		fs.writeFileSync(path.join(present.worktreeDir, removed), 'old\n');
		const blocked = await present.executor.execute(loopInput(present.worktreeDir, {
			auditGate: true,
			removedPaths: [removed],
			allowedWritePathPrefixes: taskMutationAllowlist(deletionTask()),
		}));
		assert.deepEqual(blocked, {
			status: 'failed',
			failureReason: 'evidence-failed',
			attempts: 3,
			lastSummary: 'candidate',
		});
		assert.match(present.governor.calls[1].prompt, new RegExp(`Still on disk: ${removed}`));
		assert.equal(readTranscripts(present.fixture.artifacts.artifactsDir).length, 3);

		const finished = await absent.executor.execute(loopInput(absent.worktreeDir, {
			auditGate: true,
			removedPaths: [removed],
			allowedWritePathPrefixes: taskMutationAllowlist(deletionTask()),
		}));
		assert.equal(finished.status, 'completed');
		assert.equal(absent.governor.calls.length, 2);
		assert.equal(absent.governor.calls.some((call) => String(call.prompt).includes('Still on disk')), false);
	} finally {
		await present.close();
		await absent.close();
	}
});
