import assert from 'node:assert/strict';
import test from 'node:test';
import { makeFixture } from '../../testing/test-support.mjs';
import {
	createCreateLocalCommitNode,
	createVerifyCommittedTreeNode,
} from './commit.ts';

test('createCreateLocalCommitNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createCreateLocalCommitNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createCreateLocalCommitNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createCreateLocalCommitNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});

test('createVerifyCommittedTreeNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createVerifyCommittedTreeNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createVerifyCommittedTreeNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createVerifyCommittedTreeNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});
