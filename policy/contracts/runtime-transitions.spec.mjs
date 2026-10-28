import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTransition } from './runtime-transitions.ts';

test('planning and QA transitions allow the Slice 4 edges and reject skipped states', () => {
	// Test transitions and new runtime states
	assert.doesNotThrow(() => assertTransition('SPEC_APPROVED', 'PLANNING_TASKS'));
	assert.doesNotThrow(() => assertTransition('WAITING_FOR_AUTHORIZATION', 'PLANNING_TASKS'));
	assert.doesNotThrow(() => assertTransition('PLANNING_TASKS', 'EVALUATING_POLICY'));
	assert.doesNotThrow(() => assertTransition('EVALUATING_POLICY', 'REVIEWING_PLAN'));
	assert.doesNotThrow(() => assertTransition('REVIEWING_PLAN', 'PREPARING_WORKSPACE'));
	assert.doesNotThrow(() =>
		assertTransition('WAITING_FOR_PLAN_ACCEPTANCE', 'WAITING_FOR_AUTHORIZATION'),
	);
	assert.throws(() => assertTransition('EVALUATING_POLICY', 'EXECUTING_IMPLEMENTATION'));
	assert.throws(() => assertTransition('EVALUATING_POLICY', 'PREPARING_WORKSPACE'));
	assert.throws(() => assertTransition('SPEC_APPROVED', 'PREPARING_WORKSPACE'));
	assert.throws(() => assertTransition('WAITING_FOR_AUTHORIZATION', 'PREPARING_WORKSPACE'));
	assert.throws(() => assertTransition('WAITING_FOR_PLAN_ACCEPTANCE', 'PLANNING_TASKS'));
	assert.doesNotThrow(() => assertTransition('VERIFYING_PREFLIGHT', 'REVIEWING_QA'));
	assert.doesNotThrow(() => assertTransition('REVIEWING_QA', 'READY_FOR_GIT_APPROVAL'));
	assert.doesNotThrow(() => assertTransition('REVIEWING_QA', 'COMMITTING_CHANGES'));
	assert.throws(() => assertTransition('VERIFYING_PREFLIGHT', 'READY_FOR_GIT_APPROVAL'));
	assert.throws(() => assertTransition('VERIFYING_PREFLIGHT', 'COMMITTING_CHANGES'));
	assert.doesNotThrow(() => assertTransition('EXECUTING_IMPLEMENTATION', 'RECONCILING_INTEGRATION'));
	assert.doesNotThrow(() => assertTransition('RECONCILING_INTEGRATION', 'SNAPSHOT_GENERATION'));
	assert.doesNotThrow(() => assertTransition('REPAIRING_FAILURE', 'RECONCILING_INTEGRATION'));
});

test('assertTransition names the illegal and the unknown edge', () => {
	assert.throws(
		() => assertTransition('EVALUATING_POLICY', 'EXECUTING_IMPLEMENTATION'),
		(error) => error.code === 'INVALID_TRANSITION'
			&& error.message === 'Transition EVALUATING_POLICY -> EXECUTING_IMPLEMENTATION is not allowed',
	);
	assert.throws(
		() => assertTransition('NOT_A_STATE', 'DONE'),
		(error) => error.code === 'INVALID_TRANSITION'
			&& error.message === 'Unknown transition NOT_A_STATE -> DONE',
	);
});
