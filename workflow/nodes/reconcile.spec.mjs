import assert from 'node:assert/strict';
import test from 'node:test';
import { END, START, StateGraph } from '@langchain/langgraph';
import { GraphState } from '../graph-topology.ts';
import { makeFixture } from '../../testing/test-support.mjs';
import {
	createReconcileIntegrationNode,
	createAskReconciliationConflictNode,
	createApplyReconciliationConflictNode,
} from './reconcile.ts';

test('createReconcileIntegrationNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createReconcileIntegrationNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createReconcileIntegrationNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createReconcileIntegrationNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});

test('createAskReconciliationConflictNode pauses on the pending reconciliation request', async () => {
	const fixture = makeFixture('createAskReconciliationConflictNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createAskReconciliationConflictNode' });
		const requestArtifact = fixture.artifacts.writeJson('recon-request', {
			kind: 'reconciliation_conflict',
			prompt: 'choose',
		});
		fixture.store.createInterrupt({
			interruptId: 'recon-interrupt',
			runId: fixture.runId,
			kind: 'reconciliation_conflict',
			stateHash: 'h'.repeat(64),
			requestArtifact,
			createdAt: new Date().toISOString(),
		});
		const graph = new StateGraph(GraphState)
			.addNode('ask', createAskReconciliationConflictNode(fixture.runtime))
			.addEdge(START, 'ask')
			.addEdge('ask', END)
			.compile({ checkpointer: fixture.runtime.checkpointer });
		const paused = await graph.invoke(
			{ snapshot: { ...initial, pendingInterruptId: 'recon-interrupt' } },
			{ configurable: { thread_id: `${fixture.runId}-ask` } },
		);
		assert.equal(paused.__interrupt__[0].value.prompt, 'choose');
		assert.equal(paused.__interrupt__[0].value.kind, 'reconciliation_conflict');
	} finally {
		fixture.close();
	}
});

test('createApplyReconciliationConflictNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createApplyReconciliationConflictNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createApplyReconciliationConflictNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createApplyReconciliationConflictNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});
