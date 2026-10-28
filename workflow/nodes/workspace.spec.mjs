import assert from 'node:assert/strict';
import test from 'node:test';
import { makeFixture } from '../../testing/test-support.mjs';
import {
	createPrepareWorkspaceNode,
	createHydrateWorkspaceNode,
} from './workspace.ts';

test('createPrepareWorkspaceNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createPrepareWorkspaceNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createPrepareWorkspaceNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createPrepareWorkspaceNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});

test('createHydrateWorkspaceNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createHydrateWorkspaceNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createHydrateWorkspaceNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createHydrateWorkspaceNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});
