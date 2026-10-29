import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import fs from 'node:fs';
import {
	FakeModelGovernor,
} from '../testing/fake-model-governor.mjs';
import {
	leanReplaceAction,
	leanWriteAction,
	makeFixture,
} from '../testing/test-support.mjs';
import {
	PRODUCT_IMPLEMENTER_ORIGINAL,
	PRODUCT_IMPLEMENTER_PATH,
	runProductImplementer,
} from '../testing/task-executor-fixtures.mjs';
import {
	TaskExecutor,
} from './task-executor.ts';

test('TaskExecutor reuses parentCommitSha on resume without minting new synthetic commit', async () => {
	const fixture = makeFixture('task_resume_commit', []);
	const baseCommitSha = 'a'.repeat(40);
	const parentTreeSha = 'b'.repeat(40);
	const existingParentCommitSha = 'c'.repeat(40);

	let commitTreeCalls = 0;
	const mockGitCli = (cmd, args = [], opts = {}) => {
		if (cmd === 'git') {
			if (args[0] === 'commit-tree') {
				commitTreeCalls++;
				return 'd'.repeat(40) + '\n';
			}
			if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
				return existingParentCommitSha + '\n';
			}
			if (args[0] === 'worktree') {
				if (args[1] === 'add') {
					fs.mkdirSync(args[3], { recursive: true });
				}
				return '';
			}
			if (args[0] === 'read-tree' || args[0] === 'add' || args[0] === 'write-tree') {
				return 'e'.repeat(40) + '\n';
			}
			if (args[0] === 'diff-index' || args[0] === 'diff-tree') {
				return '';
			}
		}
		return '';
	};

	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Test resume parent commit',
		});

		const taskPlan = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			planPolicyHash: '0'.repeat(64),
			baseCommitSha,
			isParallel: true,
			tasks: [
				{
					taskId: 'task-0',
					title: 'Task 0',
					targetPackage: 'apps/services/conditioning',
					pathPrefixes: ['apps/services/conditioning'],
					dependsOn: [],
					status: 'completed',
					integrationOrder: 0,
					worktreeSubdir: 'worktrees/task-0',
					baseCommitSha,
					parentTreeSha: null,
					parentCommitSha: null,
					targetTreeSha: parentTreeSha,
					patchHash: '1'.repeat(64),
					failurePacketArtifact: null,
					repairCount: 0,
				},
				{
					taskId: 'task-1',
					title: 'Task 1',
					targetPackage: 'apps/services/conditioning',
					pathPrefixes: ['apps/services/conditioning'],
					dependsOn: ['task-0'],
					status: 'pending',
					integrationOrder: 1,
					worktreeSubdir: 'worktrees/task-1',
					baseCommitSha,
					parentTreeSha,
					parentCommitSha: existingParentCommitSha,
					targetTreeSha: null,
					patchHash: null,
					failurePacketArtifact: null,
					repairCount: 0,
					verificationCommand: ['pnpm', 'run', 'test:unit'],
				},
			],
			integrationOrder: ['task-0', 'task-1'],
			createdAt: new Date().toISOString(),
		};

		fixture.store.saveTaskPlan(taskPlan);

		const executor = new TaskExecutor({
			governor: new FakeModelGovernor([
				leanWriteAction(
					'apps/services/conditioning/src/task-1.ts',
					'export const val = 1;',
				),
				{
					action: {
						kind: 'complete',
						summary: 'Done task 1',
					},
				},
			]),
			runtimeStore: fixture.store,
			artifactStore: fixture.artifacts,
			roleRegistry: fixture.registry,
			gitCli: mockGitCli,
			execCli: () => '',
			runTaskTests: false,
		});

		await executor.executeTaskPlan({
			taskPlan,
			authorization: {
				allowedPackages: ['apps/services/conditioning'],
				allowedPathPrefixes: ['apps/services/conditioning'],
				allowedOperations: {
					createDetachedWorktree: true,
					editIsolatedWorktree: true,
					runAllowlistedCommands: true,
				},
			},
			snapshot: { taskPlanFrozen: true },
			specSummary: 'Test goal',
			acceptanceCriteria: ['AC1'],
		});

		// commit-tree was NOT called because parentCommitSha was already stored and reused
		assert.equal(commitTreeCalls, 0);

		const task1 = fixture.store.getTask(fixture.runId, 'task-1');
		assert.equal(task1.parentCommitSha, existingParentCommitSha);
	} finally {
		fixture.close();
	}
});

test('@ac AC-01 @case AC-01.1 the product implementer replace_in_file changes the file', async () => {
	const expectedHash = crypto.createHash('sha256').update(PRODUCT_IMPLEMENTER_ORIGINAL, 'utf8').digest('hex');
	const { governor, error, content, task } = await runProductImplementer({
		label: 'product-ac-01-replace',
		verificationCommand: ['pnpm', 'run', 'test:unit'],
		script: [
			leanReplaceAction(
				PRODUCT_IMPLEMENTER_PATH,
				'export const value = "before";',
				'export const value = "after";',
				expectedHash,
			),
			{ action: { kind: 'complete', summary: 'Replaced the value' } },
		],
	});
	assert.equal(error, null);
	assert.equal(task?.status, 'completed');
	assert.equal(content, 'export const value = "after";\n');
	const schemaText = JSON.stringify(governor.calls[0].structuredOutputSchema);
	assert.equal(schemaText.includes('programmer_turn'), false);
	assert.equal(schemaText.includes('tool_call'), true);
});
