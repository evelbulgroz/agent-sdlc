import assert from 'node:assert/strict';
import test from 'node:test';
import { executeRolePipeline } from './pipeline-executor.ts';

test('executeRolePipeline passes when the insertion point loads no roles', async () => {
	const result = await executeRolePipeline({
		insertionPoint: 'pre_review',
		runtime: {
			registry: { loadPipeline: () => [] },
			runtimeStore: { listOptionalRoleExecutions: () => [] },
		},
		snapshot: { runId: 'run-empty-pipeline' },
	});
	assert.equal(result.status, 'PASS');
	assert.deepEqual([...result.executedRoles], []);
	assert.deepEqual([...result.findings], []);
});
