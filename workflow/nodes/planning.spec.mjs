import assert from 'node:assert/strict';
import test from 'node:test';
import { makeFixture } from '../../testing/test-support.mjs';
import {
	createPlanTasksNode,
	createEvaluatePolicyGateNode,
	createExecutePlanCriticNode,
	createAskPlanCriticNode,
	createApplyPlanCriticNode,
} from './planning.ts';

test('createPlanTasksNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createPlanTasksNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createPlanTasksNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createPlanTasksNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});

test('createEvaluatePolicyGateNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createEvaluatePolicyGateNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createEvaluatePolicyGateNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createEvaluatePolicyGateNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});

test('createExecutePlanCriticNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createExecutePlanCriticNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createExecutePlanCriticNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createExecutePlanCriticNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});

test('createAskPlanCriticNode returns the snapshot when no interrupt is pending', () => {
	const fixture = makeFixture('createAskPlanCriticNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createAskPlanCriticNode' });
		const result = createAskPlanCriticNode(fixture.runtime)({ snapshot: initial });
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.equal(result.humanResponse, null);
	} finally {
		fixture.close();
	}
});

test('createApplyPlanCriticNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createApplyPlanCriticNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createApplyPlanCriticNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createApplyPlanCriticNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});
