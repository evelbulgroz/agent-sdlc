import assert from 'node:assert/strict';
import test from 'node:test';
import { makeFixture } from '../../testing/test-support.mjs';
import {
	createPrepareAuthorizationNode,
	createAskAuthorizationNode,
	createApplyAuthorizationNode,
} from './authorization.ts';

test('createPrepareAuthorizationNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createPrepareAuthorizationNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createPrepareAuthorizationNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createPrepareAuthorizationNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});

test('createAskAuthorizationNode returns the snapshot when no interrupt is pending', () => {
	const fixture = makeFixture('createAskAuthorizationNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createAskAuthorizationNode' });
		const result = createAskAuthorizationNode(fixture.runtime)({ snapshot: initial });
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.equal(result.humanResponse, null);
	} finally {
		fixture.close();
	}
});

test('createApplyAuthorizationNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createApplyAuthorizationNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createApplyAuthorizationNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createApplyAuthorizationNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});
