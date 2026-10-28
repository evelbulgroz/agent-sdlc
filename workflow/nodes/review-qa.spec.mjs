import assert from 'node:assert/strict';
import test from 'node:test';
import { makeFixture } from '../../testing/test-support.mjs';
import {
	createSnapshotGenerationNode,
	createExecuteReviewerNode,
	createExecuteVerifierNode,
	createExecuteQaCriticNode,
} from './review-qa.ts';

test('createSnapshotGenerationNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createSnapshotGenerationNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createSnapshotGenerationNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createSnapshotGenerationNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});

test('createExecuteReviewerNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createExecuteReviewerNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createExecuteReviewerNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createExecuteReviewerNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});

test('createExecuteVerifierNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createExecuteVerifierNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createExecuteVerifierNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createExecuteVerifierNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});

test('createExecuteQaCriticNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createExecuteQaCriticNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createExecuteQaCriticNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createExecuteQaCriticNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});
