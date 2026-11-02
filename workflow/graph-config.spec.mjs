import assert from 'node:assert/strict';
import test from 'node:test';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { workflowGraphConfig } from './graph-config.ts';

const state = { threadId: 'checkpoint-recursion', runId: '2026-11-01-sdlc-fixture' };
const Counter = Annotation.Root({ count: Annotation({ reducer: (_, next) => next, default: () => 0 }) });
const graph = new StateGraph(Counter)
	.addNode('step', ({ count }) => ({ count: count + 1 }))
	.addEdge(START, 'step')
	.addConditionalEdges('step', ({ count }) => count >= 40 ? 'done' : 'again', { done: END, again: 'step' })
	.compile();

test('approved slice cycles can progress beyond the legacy graph recursion limit', async () => {
	const config = workflowGraphConfig(state, {
		getTaskPlan: () => ({ schemaVersion: '2.0.0', slices: [
			{ kind: 'enabling' }, ...Array.from({ length: 12 }, () => ({ kind: 'activation' })),
		] }),
		getAuthorization: () => null,
	});
	assert.equal((await graph.invoke({ count: 0 }, config)).count, 40);
	const legacy = workflowGraphConfig(state, { getTaskPlan: () => null, getAuthorization: () => null });
	assert.deepEqual(legacy, { configurable: { thread_id: state.threadId } });
	await assert.rejects(graph.invoke({ count: 0 }, legacy), /recursion limit/i);
});

test('pre-freeze quality authorization bounds the initial graph invocation', async () => {
	const config = workflowGraphConfig(state, {
		getTaskPlan: () => null,
		getAuthorization: () => ({ qualityPlan: { evidenceObligations: Array.from({ length: 12 }, () => ({})) } }),
	});
	assert.equal((await graph.invoke({ count: 0 }, config)).count, 40);
});

test('plan read errors do not silently select legacy graph admission', () => {
	assert.throws(() => workflowGraphConfig(state, {
		getTaskPlan: () => { throw new Error('store unavailable'); },
		getAuthorization: () => null,
	}), /store unavailable/);
});
