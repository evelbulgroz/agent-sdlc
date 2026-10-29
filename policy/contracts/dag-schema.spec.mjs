import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDagTask, validateReconciliationRecord, validateTaskPlan } from './dag-schema.ts';

test('DAG task, task plan, and reconciliation record contracts validate strictly', () => {
	const validTask = {
		taskId: 'billing-task',
		title: 'Update billing service log model',
		targetPackage: 'services/billing',
		pathPrefixes: ['services/billing/src/'],
		dependsOn: [],
		status: 'pending',
		integrationOrder: 0,
		worktreeSubdir: 'worktrees/billing-task',
		baseCommitSha: 'a'.repeat(40),
		parentTreeSha: null,
		targetTreeSha: null,
		patchHash: null,
		failurePacketArtifact: null,
		repairCount: 0,
	};
	const parsedTask = validateDagTask(validTask);
	assert.equal(parsedTask.taskId, 'billing-task');
	assert.equal(parsedTask.status, 'pending');

	assert.throws(() => validateDagTask(null), /Invalid DagTask/);
	assert.throws(() => validateDagTask({ ...validTask, taskId: 'INVALID_ID' }), /Invalid DagTask/);
	assert.throws(() => validateDagTask({ ...validTask, status: 'unknown_status' }), /Invalid DagTask/);
	assert.throws(() => validateDagTask({ ...validTask, baseCommitSha: 'short-sha' }), /Invalid DagTask/);
	assert.throws(() => validateDagTask({ ...validTask, pathPrefixes: [] }), /Invalid DagTask/);

	const validPlan = {
		schemaVersion: '1.0.0',
		runId: '2026-09-07-cross-service',
		planPolicyHash: 'b'.repeat(64),
		baseCommitSha: 'a'.repeat(40),
		tasks: [validTask],
		integrationOrder: ['billing-task'],
		isParallel: false,
		createdAt: new Date().toISOString(),
	};
	const parsedPlan = validateTaskPlan(validPlan);
	assert.equal(parsedPlan.runId, '2026-09-07-cross-service');
	assert.equal(parsedPlan.tasks.length, 1);

	assert.throws(() => validateTaskPlan(null), /Invalid TaskPlan/);
	assert.throws(() => validateTaskPlan({ ...validPlan, tasks: [] }), /Invalid TaskPlan/);
	assert.throws(() => validateTaskPlan({ ...validPlan, runId: 'invalid-run-id' }), /runId must use/);
	assert.throws(() => validateTaskPlan({ ...validPlan, planPolicyHash: 'invalid' }), /Invalid TaskPlan/);

	const validReconcile = {
		reconciliationId: 'rec-12345678',
		runId: '2026-09-07-cross-service',
		integrationOrder: ['billing-task'],
		reconciledTreeSha: 'c'.repeat(40),
		status: 'RECONCILIATION_COMPLETED',
		conflictDetails: null,
		reconciledAt: new Date().toISOString(),
	};
	const parsedReconcile = validateReconciliationRecord(validReconcile);
	assert.equal(parsedReconcile.status, 'RECONCILIATION_COMPLETED');
	assert.equal(parsedReconcile.conflictDetails, null);

	assert.throws(() => validateReconciliationRecord(null), /Invalid ReconciliationRecord/);
	assert.throws(
		() => validateReconciliationRecord({ ...validReconcile, status: 'UNKNOWN' }),
		/Invalid ReconciliationRecord/,
	);
	assert.throws(
		() => validateReconciliationRecord({ ...validReconcile, reconciledTreeSha: 'short' }),
		/Invalid ReconciliationRecord/,
	);
});
