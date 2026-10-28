import assert from 'node:assert/strict';
import test from 'node:test';
import { makeFixture } from '../../testing/test-support.mjs';
import {
	createExecuteTasksNode,
} from './execute-tasks.ts';

test('createExecuteTasksNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createExecuteTasksNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createExecuteTasksNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createExecuteTasksNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});
