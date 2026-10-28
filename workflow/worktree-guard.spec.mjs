import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { assertPlanFrozenThenCreateWorktree } from './worktree-guard.ts';

test('assertPlanFrozenThenCreateWorktree throws before git worktree add when unfrozen', () => {
	const gitCalls = [];
	const gitCli = (cmd, args) => {
		gitCalls.push({ cmd, args });
		return '';
	};
	assert.throws(
		() =>
			assertPlanFrozenThenCreateWorktree({
				snapshot: { taskPlanFrozen: false },
				runId: '2026-09-10-guard-unfrozen',
				baseCommitSha: 'a'.repeat(40),
				gitCli,
			}),
		(error) => error.code === 'POLICY_VIOLATION',
	);
	assert.equal(gitCalls.length, 0);

	assert.throws(
		() =>
			assertPlanFrozenThenCreateWorktree({
				taskPlanFrozen: null,
				runId: '2026-09-10-guard-null',
				baseCommitSha: 'a'.repeat(40),
				gitCli,
			}),
		(error) => error.code === 'POLICY_VIOLATION',
	);
	assert.equal(gitCalls.length, 0);
});

test('assertPlanFrozenThenCreateWorktree creates a worktree after freeze', () => {
	const gitCalls = [];
	const runId = `2026-09-10-guard-frozen-${crypto.randomUUID().slice(0, 8)}`;
	const gitCli = (cmd, args) => {
		gitCalls.push({ cmd, args });
		if (args[0] === 'rev-parse') return `${'a'.repeat(40)}\n`;
		if (args[0] === 'worktree' && args[1] === 'add') {
			fs.mkdirSync(args[3], { recursive: true });
			return '';
		}
		if (args[0] === 'branch') return '';
		return '';
	};
	try {
		const result = assertPlanFrozenThenCreateWorktree({
			snapshot: { taskPlanFrozen: true },
			runId,
			baseCommitSha: 'a'.repeat(40),
			gitCli,
		});
		assert.ok(result.worktreeDir);
		assert.ok(
			gitCalls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add'),
		);
	} finally {
		fs.rmSync(path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId), {
			recursive: true,
			force: true,
		});
	}
});
