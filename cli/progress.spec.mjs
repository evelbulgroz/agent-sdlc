import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvent, validateRuntimeState } from '../policy/contracts.ts';
import { makeFixture } from '../testing/test-support.mjs';
import {
	clearProgressSink,
	emitModelCallProgress,
	emitRuntimeTransitionProgress,
	emitToolFinishedProgress,
	installProgressSink,
	PROGRESS_MAX_LINE_BYTES,
	toolActivity,
} from './progress.ts';









// Forces the stored runtime state to `to` without going through the graph,
// so tests can stage a run at an arbitrary reachable state cheaply. Uses
// the real store so `assertTransition` still rejects an illegal edge.
function forceTransition(store, runId, to) {
	const current = store.getRun(runId);
	const next = validateRuntimeState({
		...current,
		state: to,
		runtimeRevision: current.runtimeRevision + 1,
		updatedAt: new Date().toISOString(),
	});
	const event = createEvent({
		eventType: 'RUN_BLOCKED',
		runId,
		runtimeRevision: next.runtimeRevision,
		state: next,
		input: current,
		output: {},
		causalId: `force-${runId}-${next.runtimeRevision}`,
		payload: {},
	});
	return store.saveTransition(current.runtimeRevision, next, event);
}

function driveToState(store, runId, states) {
	let current;
	for (const to of states) {
		current = forceTransition(store, runId, to);
	}
	return current;
}

test.afterEach(() => {
	clearProgressSink();
});


test('@ac AC-02 a finished tool outside ALLOWED_TOOLS is reported as tool:other', () => {
	const fakeRuntimeStore = { getRun: () => ({ state: 'EXECUTING_IMPLEMENTATION', runtimeRevision: 5 }) };
	const lines = [];
	installProgressSink((line) => lines.push(line));

	// @case AC-02.3: a disallowed tool name is rendered as 'tool:other' and
	// the raw tool name is omitted from the line.
	emitToolFinishedProgress({
		runtimeStore: fakeRuntimeStore,
		runId: 'fake-run',
		taskId: null,
		roleId: 'implementer',
		step: 7,
		toolName: 'not-allowlisted',
	});

	assert.equal(lines.length, 1);
	assert.equal(lines[0].includes('activity=tool:other'), true);
	assert.equal(lines[0].includes('not-allowlisted'), false);
	assert.equal(toolActivity('not-allowlisted'), 'tool:other');
	assert.equal(toolActivity('read_file'), 'tool:read_file');
});

test('@ac AC-02 an over-long task id is dropped while role, step, and activity remain', () => {
	const fakeRuntimeStore = { getRun: () => ({ state: 'EXECUTING_IMPLEMENTATION', runtimeRevision: 9 }) };
	const lines = [];
	installProgressSink((line) => lines.push(line));

	// @case AC-02.4: a 300-character task id would push the line past 240
	// bytes; it is omitted and the remaining fields stay.
	emitModelCallProgress({
		runtimeStore: fakeRuntimeStore,
		runId: 'fake-run',
		taskId: 'x'.repeat(300),
		roleId: 'implementer',
		step: 2,
	});

	assert.equal(lines.length, 1);
	const line = lines[0];
	assert.equal(Buffer.byteLength(line, 'utf8') <= PROGRESS_MAX_LINE_BYTES, true);
	assert.equal(line.includes('task='), false);
	assert.equal(line.includes('role=implementer'), true);
	assert.equal(line.includes('step=2'), true);
	assert.equal(line.includes('activity=model'), true);
});

test('@ac AC-03 the same activity is not repeated while the slot stays installed', () => {
	const lines = [];
	installProgressSink((line) => lines.push(line));

	emitRuntimeTransitionProgress({ state: 'EXECUTING_IMPLEMENTATION', runtimeRevision: 4, activeTaskId: null });
	emitRuntimeTransitionProgress({ state: 'EXECUTING_IMPLEMENTATION', runtimeRevision: 7, activeTaskId: null });

	assert.equal(lines.length, 1);
	assert.equal(lines[0].includes('revision=4'), true);
	assert.equal(lines[0].includes('revision=7'), false);
});

test('@ac AC-04 a throwing sink does not change the stored state, and the slot lifetime is scoped per installation', async () => {
	const fixture = makeFixture('progress-ac04-sink-failure');
	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Verify a throwing sink cannot corrupt the stored run',
		});
		driveToState(fixture.store, fixture.runId, [
			'WAITING_FOR_APPROVAL',
			'SPEC_APPROVED',
			'PLANNING_TASKS',
			'EVALUATING_POLICY',
			'REVIEWING_PLAN',
			'PREPARING_WORKSPACE',
			'HYDRATING_WORKSPACE',
		]);
		const beforeTransition = fixture.store.getRun(fixture.runId);

		// @case AC-04.1: a throwing sink still leaves EXECUTING_IMPLEMENTATION
		// durably stored with a null blockedReason.
		installProgressSink(() => {
			throw new Error('sink boom');
		});
		const stored = fixture.runtime.transition(beforeTransition, {
			to: 'EXECUTING_IMPLEMENTATION',
			eventType: 'WORKTREE_HYDRATED',
			causalId: 'ac04-hydrate',
			updates: { activeGeneration: 0 },
			payload: {},
		});
		assert.equal(stored.state, 'EXECUTING_IMPLEMENTATION');
		assert.equal(stored.blockedReason, null);

		// @case AC-04.2: after the command returns, a clear slot writes
		// nothing, and a sink installed again prints one new line for that
		// same state.
		clearProgressSink();
		emitRuntimeTransitionProgress(stored); // no sink installed: must be silent and must not throw

		const lines = [];
		installProgressSink((line) => lines.push(line));
		emitRuntimeTransitionProgress(stored);
		assert.equal(lines.length, 1);
		assert.equal(lines[0].includes('state=EXECUTING_IMPLEMENTATION'), true);
	} finally {
		fixture.close();
	}
});
