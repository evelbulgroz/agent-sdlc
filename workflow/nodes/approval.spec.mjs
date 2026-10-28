import assert from 'node:assert/strict';
import test from 'node:test';
import { makeFixture } from '../../testing/test-support.mjs';
import {
	createExecuteSpecCriticNode,
	createPrepareApprovalNode,
	createAskApprovalNode,
	createApplyApprovalNode,
} from './approval.ts';

test('createExecuteSpecCriticNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createExecuteSpecCriticNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createExecuteSpecCriticNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createExecuteSpecCriticNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});

test('createPrepareApprovalNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createPrepareApprovalNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createPrepareApprovalNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createPrepareApprovalNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});

test('createAskApprovalNode returns the snapshot when no interrupt is pending', () => {
	const fixture = makeFixture('createAskApprovalNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createAskApprovalNode' });
		const result = createAskApprovalNode(fixture.runtime)({ snapshot: initial });
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.equal(result.humanResponse, null);
	} finally {
		fixture.close();
	}
});

test('createApplyApprovalNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createApplyApprovalNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createApplyApprovalNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createApplyApprovalNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});
