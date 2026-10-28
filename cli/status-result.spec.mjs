import assert from 'node:assert/strict';
import test from 'node:test';
import { SdlcError } from '../policy/errors.ts';
import { assembleStatusResult } from './status-result.ts';

test('a missing run fails with the store error', () => {
	const error = new SdlcError('RUN_NOT_FOUND', 'Run not found: missing');
	assert.throws(
		() => assembleStatusResult({
			paths: { runId: 'missing' },
			runtimeStore: {
				getRun() {
					throw error;
				},
			},
		}),
		(caught) => caught === error,
	);
});

test('a run with no pull request reports null', () => {
	const state = {
		runId: 'run-1',
		state: 'PLANNING_TASKS',
		runtimeRevision: 1,
		draftHash: null,
		approvedSpecHash: null,
		completeness: null,
		blockedReason: null,
		lastError: null,
		semanticRepairsCount: 0,
		pendingInterruptId: null,
	};
	const result = assembleStatusResult({
		rootDir: '/tmp',
		paths: { runId: 'run-1', runtimeDir: '/tmp/missing-runtime' },
		runtimeStore: {
			getRun() { return state; },
			getMaxRecordedGeneration() { return 0; },
			getGeneration() { return null; },
			listEvents() { return []; },
			listCriticReviews() { return []; },
			getGitCommit() { return null; },
			getPullRequest() { return null; },
			getTaskPlan() { return null; },
			listDiagnostics() { return []; },
			listOptionalRoleExecutions() { return []; },
			getAuthorization() { return null; },
		},
		continuationInputs() {
			return { authorization: null, pendingInterrupt: null, continuationAttempts: 0 };
		},
	});
	assert.equal(result.pullRequest, null);
	assert.equal(result.candidateLearnings, undefined);
	assert.equal(result.state, 'PLANNING_TASKS');
});
