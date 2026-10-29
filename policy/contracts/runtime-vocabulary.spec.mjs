import assert from 'node:assert/strict';
import test from 'node:test';
import { EVENT_TYPES, STORE_SCHEMA_VERSION, validateRuntimeState } from './runtime-vocabulary.ts';

test('runtime state with closed keys for Slice 4 validates strictly', () => {
	// Test runtime state with closed keys for Slice 4
	const validRuntimeState = {
		schemaVersion: '1.0.0',
		runId: '2026-09-07-state-test',
		threadId: 'thread-1',
		runtimeRevision: 1,
		state: 'PLANNING_TASKS',
		goalArtifact: 'a'.repeat(64),
		draftArtifact: 'b'.repeat(64),
		draftHash: 'c'.repeat(64),
		completeness: { complete: true, missingFields: [], ambiguousFields: [] },
		pendingInterruptId: null,
		approvedSpecHash: 'd'.repeat(64),
		modelOperations: [],
		blockedReason: null,
		lastError: null,
		workflowHash: 'e'.repeat(64),
		roleHash: 'f'.repeat(64),
		promptPolicyHash: '1'.repeat(64),
		capabilitySetHash: '2'.repeat(64),
		evaluatorSetHash: '3'.repeat(64),
		completenessHash: null,
		activeModelOperationId: null,
		activeProposalArtifact: null,
		interviewRound: 0,
		activeGeneration: null,
		worktreePath: null,
		semanticRepairsCount: 0,
		approvedPlanPolicyHash: '4'.repeat(64),
		preflightBindingArtifact: null,
		targetTreeSha: null,
		authorVendor: null,
		taskPlanHash: '5'.repeat(64),
		integrationWorktreePath: 'tools/.agent-sdlc/2026-09-07-state-test/worktrees/integration',
		activeTaskId: 'billing-task',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	const parsedState = validateRuntimeState(validRuntimeState);
	assert.equal(parsedState.taskPlanHash, '5'.repeat(64));
	assert.equal(parsedState.activeTaskId, 'billing-task');
	assert.equal(Object.hasOwn(parsedState, 'executor'), false);
});

test('@ac AC-03 @case AC-03.1 @case AC-03.2 stored executor must be minimal or omitted', () => {
	const validRuntimeState = {
		schemaVersion: '1.0.0',
		runId: '2026-09-07-state-test',
		threadId: 'thread-1',
		runtimeRevision: 1,
		state: 'PLANNING_TASKS',
		goalArtifact: 'a'.repeat(64),
		draftArtifact: 'b'.repeat(64),
		draftHash: 'c'.repeat(64),
		completeness: { complete: true, missingFields: [], ambiguousFields: [] },
		pendingInterruptId: null,
		approvedSpecHash: 'd'.repeat(64),
		modelOperations: [],
		blockedReason: null,
		lastError: null,
		workflowHash: 'e'.repeat(64),
		roleHash: 'f'.repeat(64),
		promptPolicyHash: '1'.repeat(64),
		capabilitySetHash: '2'.repeat(64),
		evaluatorSetHash: '3'.repeat(64),
		completenessHash: null,
		activeModelOperationId: null,
		activeProposalArtifact: null,
		interviewRound: 0,
		activeGeneration: null,
		worktreePath: null,
		semanticRepairsCount: 0,
		approvedPlanPolicyHash: '4'.repeat(64),
		preflightBindingArtifact: null,
		targetTreeSha: null,
		authorVendor: null,
		taskPlanHash: '5'.repeat(64),
		integrationWorktreePath: 'tools/.agent-sdlc/2026-09-07-state-test/worktrees/integration',
		activeTaskId: 'billing-task',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	const minimal = validateRuntimeState({ ...validRuntimeState, executor: 'minimal' });
	assert.equal(minimal.executor, 'minimal');
	assert.throws(
		() => validateRuntimeState({ ...validRuntimeState, executor: 'controlled' }),
		(error) => error.code === 'INVALID_CONTRACT' && /must be minimal/.test(error.message),
	);
	const omitted = validateRuntimeState(validRuntimeState);
	assert.equal(Object.hasOwn(omitted, 'executor'), false);
	assert.throws(
		() => validateRuntimeState({ ...validRuntimeState, executor: 'sideways' }),
		(error) => error.code === 'INVALID_CONTRACT',
	);
	assert.throws(
		() => validateRuntimeState({ ...validRuntimeState, executor: null }),
		(error) => error.code === 'INVALID_CONTRACT',
	);
});

test('EVENT_TYPES contains FALSE_ECONOMY_DETECTED', () => {
	assert.ok(EVENT_TYPES.includes('FALSE_ECONOMY_DETECTED'));
});

test('STORE_SCHEMA_VERSION is 13 and EVENT_TYPES includes friction events', () => {
	assert.equal(STORE_SCHEMA_VERSION, 13);
	assert.ok(EVENT_TYPES.includes('PROMPT_FRICTION_DETECTED'));
	assert.ok(EVENT_TYPES.includes('PROMPT_FRICTION_ANALYZED'));
});
