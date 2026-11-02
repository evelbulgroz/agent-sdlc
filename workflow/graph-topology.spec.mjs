import assert from 'node:assert/strict';
import test from 'node:test';
import { END, START, StateGraph } from '@langchain/langgraph';
import { GraphState, routeFromStart, routeAfterTasks, routeAfterQaCritic, wireWorkflowEdges } from './graph-topology.ts';

const NODE_IDS = [
	"check_completeness",
	"prepare_model_request",
	"execute_configured_role",
	"apply_model_patch",
	"prepare_questions",
	"ask_questions",
	"apply_answers",
	"ask_quality_answer",
	"apply_quality_answer",
	"execute_spec_critic",
	"prepare_approval",
	"ask_approval",
	"apply_approval",
	"prepare_authorization",
	"ask_authorization",
	"apply_authorization",
	"plan_tasks",
	"evaluate_policy_gate",
	"execute_plan_critic",
	"ask_plan_critic",
	"apply_plan_critic",
	"prepare_workspace",
	"hydrate_workspace",
	"execute_tasks",
	"reconcile_integration",
	"ask_reconciliation_conflict",
	"apply_reconciliation_conflict",
	"snapshot_generation",
	"execute_reviewer",
	"execute_verifier",
	"execute_qa_critic",
	"create_local_commit",
	"verify_committed_tree",
	"repair_failure",
	"finalize_run"
];

test('@ac AC-03 @case AC-03.5 wireWorkflowEdges compiles the 35-node graph and routes INITIALIZING to check_completeness', () => {
	assert.equal(NODE_IDS.length, 35);
	let graph = new StateGraph(GraphState);
	for (const id of NODE_IDS) {
		graph = graph.addNode(id, async () => ({ snapshot: { state: 'FAILED' } }));
	}
	const compiled = wireWorkflowEdges(graph).compile();
	assert.ok(compiled);
	assert.equal(routeFromStart({ snapshot: { state: 'INITIALIZING' } }), 'check_completeness');
	assert.equal(routeFromStart({ snapshot: { state: 'FAILED' } }), 'end');
	assert.equal(routeFromStart({ snapshot: { state: 'NOT_A_STATE' } }), 'end');
	assert.equal(routeFromStart({ snapshot: { state: 'DONE' } }), 'finalize_run');
});

test('@case AC-03.2 @case AC-07.4 slice QA yields back to execution and quality interrupts require answers', () => {
	assert.equal(routeAfterTasks({ snapshot: { state: 'REVIEWING_QA' } }), 'execute_qa_critic');
	assert.equal(routeAfterQaCritic({ snapshot: { state: 'EXECUTING_IMPLEMENTATION' } }), 'execute_tasks');
	const snapshot = { state: 'BLOCKED', blockedReason: 'QUALITY_REVIEW_BLOCKED', pendingInterruptId: 'quality' };
	assert.equal(routeFromStart({ snapshot }), 'ask_quality_answer');
	assert.equal(routeAfterQaCritic({ snapshot }), 'ask_quality_answer');
});

test('a route key missing from its edge map throws', async () => {
	const graph = new StateGraph(GraphState)
		.addNode('only', async () => ({ snapshot: { state: 'FAILED' } }))
		.addEdge(START, 'only')
		.addConditionalEdges('only', () => 'missing', { end: END });
	const compiled = graph.compile();
	await assert.rejects(() => compiled.invoke({ snapshot: { state: 'INITIALIZING' } }));
});
