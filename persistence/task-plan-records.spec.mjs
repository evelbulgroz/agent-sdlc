import assert from 'node:assert/strict';
import test from 'node:test';

import { createTaskPlanRecords } from './task-plan-records.ts';
import { makeFixture } from '../testing/test-support.mjs';

test('runtime store persists and retrieves DAG task plans, individual tasks, and reconciliation records', () => {
	const fixture = makeFixture('store-v5', []);
	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Slice 4 store test',
		});

		// 1. Task Plan and Tasks
		assert.equal(fixture.store.getTaskPlan(fixture.runId), null);
		assert.equal(fixture.store.getTask(fixture.runId, 'conditioning-task'), null);
		assert.equal(fixture.store.listTasks(fixture.runId).length, 0);

		const taskPlan = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			planPolicyHash: 'a'.repeat(64),
			baseCommitSha: 'b'.repeat(40),
			tasks: [
				{
					taskId: 'conditioning-task',
					title: 'Implement conditioning domain logic',
					targetPackage: 'apps/services/conditioning',
					pathPrefixes: ['apps/services/conditioning/'],
					dependsOn: [],
					status: 'pending',
					integrationOrder: 0,
					worktreeSubdir: 'worktrees/conditioning-task',
					baseCommitSha: 'b'.repeat(40),
					parentTreeSha: null,
					targetTreeSha: null,
					patchHash: null,
					failurePacketArtifact: null,
					repairCount: 0,
				},
				{
					taskId: 'assessment-task',
					title: 'Implement assessment domain logic',
					targetPackage: 'apps/services/assessment',
					pathPrefixes: ['apps/services/assessment/'],
					dependsOn: ['conditioning-task'],
					status: 'pending',
					integrationOrder: 1,
					worktreeSubdir: 'worktrees/assessment-task',
					baseCommitSha: 'b'.repeat(40),
					parentTreeSha: null,
					targetTreeSha: null,
					patchHash: null,
					failurePacketArtifact: null,
					repairCount: 0,
				},
			],
			integrationOrder: ['conditioning-task', 'assessment-task'],
			isParallel: true,
			createdAt: '2026-09-07T00:00:00.000Z',
		};

		fixture.store.saveTaskPlan(taskPlan);

		const retrievedPlan = fixture.store.getTaskPlan(fixture.runId);
		assert.equal(retrievedPlan.tasks.length, 2);
		assert.equal(retrievedPlan.tasks[0].taskId, 'conditioning-task');
		assert.equal(retrievedPlan.tasks[1].taskId, 'assessment-task');

		const conditioningTask = fixture.store.getTask(fixture.runId, 'conditioning-task');
		assert.equal(conditioningTask.targetPackage, 'apps/services/conditioning');
		assert.equal(conditioningTask.status, 'pending');
		assert.deepEqual(conditioningTask.dependsOn, []);

		// Register a fake patch artifact for task-0 to test artifact references
		const patchContent = 'diff --git a/foo b/foo\n';
		const patchHash = fixture.artifacts.writeText('patch', patchContent, {
			redactionStatus: 'clean',
		});

		// Update task status
		const updatedTask = fixture.store.updateTaskStatus(fixture.runId, 'conditioning-task', {
			status: 'completed',
			parentTreeSha: 'c'.repeat(40),
			targetTreeSha: 'd'.repeat(40),
			patchHash: patchHash,
		});
		assert.equal(updatedTask.status, 'completed');
		assert.equal(updatedTask.parentTreeSha, 'c'.repeat(40));
		assert.equal(updatedTask.targetTreeSha, 'd'.repeat(40));
		assert.equal(updatedTask.patchHash, patchHash);

		const retrievedUpdated = fixture.store.getTask(fixture.runId, 'conditioning-task');
		assert.equal(retrievedUpdated.status, 'completed');
		assert.equal(retrievedUpdated.patchHash, patchHash);

		// 2. Reconciliations
		assert.equal(fixture.store.getLatestReconciliation(fixture.runId), null);
		assert.equal(fixture.store.getReconciliation('rec-0'), null);

		const recRecord = {
			reconciliationId: 'rec-0',
			runId: fixture.runId,
			integrationOrder: ['conditioning-task', 'assessment-task'],
			reconciledTreeSha: 'e'.repeat(40),
			status: 'RECONCILIATION_COMPLETED',
			conflictDetails: null,
			reconciledAt: '2026-09-07T00:05:00.000Z',
		};

		fixture.store.saveReconciliation(recRecord);

		const retrievedRec = fixture.store.getReconciliation('rec-0');
		assert.equal(retrievedRec.reconciliationId, 'rec-0');
		assert.equal(retrievedRec.status, 'RECONCILIATION_COMPLETED');
		assert.deepEqual(retrievedRec.integrationOrder, ['conditioning-task', 'assessment-task']);

		const latestRec = fixture.store.getLatestReconciliation(fixture.runId);
		assert.equal(latestRec.reconciliationId, 'rec-0');

		// 3. Tool executions and optional roles with task_id
		fixture.store.recordToolExecution({
			schemaVersion: '1.0.0',
			executionId: 'exec-task-0',
			runId: fixture.runId,
			taskId: 'conditioning-task',
			roleId: 'implementer',
			generation: 0,
			stepIndex: 0,
			toolName: 'write_file',
			inputHash: '2'.repeat(64),
			outputArtifact: null,
			exitCode: 0,
			createdAt: new Date().toISOString(),
		});

		fixture.store.recordToolExecution({
			schemaVersion: '1.0.0',
			executionId: 'exec-task-1',
			runId: fixture.runId,
			taskId: 'assessment-task',
			roleId: 'implementer',
			generation: 0,
			stepIndex: 0,
			toolName: 'write_file',
			inputHash: '3'.repeat(64),
			outputArtifact: null,
			exitCode: 0,
			createdAt: new Date().toISOString(),
		});

		const conditioningExecs = fixture.store.listToolExecutions(
			fixture.runId,
			0,
			'conditioning-task',
		);
		assert.equal(conditioningExecs.length, 1);
		assert.equal(conditioningExecs[0].executionId, 'exec-task-0');

		const assessmentExecs = fixture.store.listToolExecutions(
			fixture.runId,
			0,
			'assessment-task',
		);
		assert.equal(assessmentExecs.length, 1);
		assert.equal(assessmentExecs[0].executionId, 'exec-task-1');

		// 4. reconcile(runId) completes cleanly with tasks verified
		const reconciled = fixture.store.reconcile(fixture.runId);
		assert.equal(reconciled.tasks.length, 2);
		assert.equal(
			reconciled.tasks.find((t) => t.taskId === 'conditioning-task')?.patchHash,
			patchHash,
		);
	} finally {
		fixture.close();
	}
});

function recordContext(store) {
	return Object.freeze({
		database: store.database,
		transaction: (operation) => store.transaction(operation),
		assertOpen: () => store.assertOpen(),
	});
}

test('task plan records return null for a missing plan and reject a missing task', () => {
	const fixture = makeFixture('task-plan-direct');
	try {
		fixture.runtime.initialize({ runId: fixture.runId, goal: 'direct task plans' });
		const records = createTaskPlanRecords(recordContext(fixture.store));
		assert.equal(records.getTaskPlan(fixture.runId), null);
		assert.equal(records.getTask(fixture.runId, 'missing-task'), null);
		assert.throws(
			() => records.updateTaskStatus(fixture.runId, 'missing-task', { status: 'completed' }),
			(error) => error instanceof TypeError && error.message === 'Unsupported SDLC error code: TASK_NOT_FOUND',
		);
	} finally {
		fixture.close();
	}
});
