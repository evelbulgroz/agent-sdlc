import assert from 'node:assert/strict';
import test from 'node:test';
import { computeContinuation, isInfrastructureContinuation, isRunDeadlineHalt } from './continuation.ts';

function coverageHalt(paths, category = 'coverage_floor_regression', extra = {}) {
	return {
		state: 'ESCALATED',
		blockedReason: 'AUTONOMOUS_REPAIR_RETIRED',
		lastError: {
			metadata: {
				integrationFailure: {
					haltPath: 'AUTONOMOUS_REPAIR_RETIRED',
					classification: 'quality_failure',
					category,
					targetPaths: paths,
					continuation: 'stop',
				},
				correctionOffer: { paths, taskId: 'retire-route', taskIdRequired: false },
				...extra,
			},
		},
	};
}

const authorization = { allowedPathPrefixes: ['pkg/billing'] };

test('a null state returns the HALTED stop', () => {
	assert.deepEqual(computeContinuation(null), { action: 'stop', reason: 'HALTED' });
});

test('a BLOCKED state with no blockedReason stops', () => {
	assert.equal(isInfrastructureContinuation({ state: 'BLOCKED' }), false);
	assert.deepEqual(computeContinuation({ state: 'BLOCKED' }), { action: 'stop', reason: 'HALTED' });
});

test('a run-deadline halt is not an infrastructure continuation', () => {
	const state = { state: 'BLOCKED', blockedReason: 'GOVERNOR_RUN_DEADLINE_EXPIRED' };
	assert.equal(isRunDeadlineHalt(state), true);
	assert.equal(isInfrastructureContinuation(state), false);
	assert.deepEqual(computeContinuation(state), { action: 'stop', reason: 'HALTED' });
});

test('only a durable consumed quality answer permits recovery, and unprovable edits halt it', () => {
	const state = { state: 'BLOCKED', blockedReason: 'QUALITY_REVIEW_BLOCKED', pendingInterruptId: 'quality-a' };
	assert.deepEqual(computeContinuation(state), { action: 'answer', reason: 'HUMAN_RESPONSE_REQUIRED' });
	assert.deepEqual(computeContinuation(state, { qualityAnswerRecorded: true }),
		{ action: 'resume', reason: 'INFRASTRUCTURE_RETRY' });
	assert.deepEqual(computeContinuation({
		...state, lastError: { metadata: { qualityRecoveryAllowed: false } },
	}, { qualityAnswerRecorded: true }), { action: 'stop', reason: 'HALTED' });
	assert.deepEqual(computeContinuation(state, {
		qualityAnswerRecorded: true, qualityRecoveryHalted: true,
	}), { action: 'stop', reason: 'HALTED' });
});

test('@ac AC-01 @case AC-01.4 a high-risk path offers no correction slot', () => {
	const state = coverageHalt(['pkg/billing/src/orphan.ts']);
	assert.deepEqual(computeContinuation(state, {
		authorization,
		highRiskPaths: ['pkg/billing'],
	}), { action: 'stop', reason: 'HALTED' });
});

test('@ac AC-01 @case AC-01.5 an oracle path offers no correction slot', () => {
	const state = coverageHalt(['pkg/billing/src/flow.oracle.spec.ts']);
	assert.deepEqual(computeContinuation(state, { authorization, highRiskPaths: [] }), {
		action: 'stop',
		reason: 'HALTED',
	});
});

test('@ac AC-01 @case AC-01.6 baseline_clone_line_shift offers no correction slot', () => {
	const state = coverageHalt(['pkg/billing/src/orphan.ts'], 'baseline_clone_line_shift');
	assert.deepEqual(computeContinuation(state, { authorization, highRiskPaths: [] }), {
		action: 'stop',
		reason: 'HALTED',
	});
});
