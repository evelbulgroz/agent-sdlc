import assert from 'node:assert/strict';
import test from 'node:test';
import { SdlcError } from '../policy/errors.ts';
import { assembleStatusResult } from './status-result.ts';
import { qaCheckpointAttemptKey } from '../review/critic-budget.ts';
import { sha256 } from '../policy/contracts.ts';

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

test('new-policy status uses current failed coverage and current QA instead of historical passes', () => {
	const state = {
		runId: 'run-1', state: 'REVIEWING_QA', runtimeRevision: 3, pendingInterruptId: null,
		approvedSpecHash: 'a'.repeat(64), taskPlanHash: 'b'.repeat(64),
		qualityCheckpointKind: 'final', qualityCheckpointTreeSha: 'c'.repeat(40),
		qualityCheckpointBindingHash: 'd'.repeat(64),
	};
	const attemptKey = qaCheckpointAttemptKey({
		approvedSpecHash: state.approvedSpecHash, taskPlanHash: state.taskPlanHash,
		checkpointKind: 'final', treeSha: state.qualityCheckpointTreeSha,
	});
	const binding = { qualityPolicyHash: 'e'.repeat(64), candidateRevision: 0 };
	state.qualityCheckpointBindingHash = sha256(binding);
	const receiptHashes = ['f'.repeat(64)];
	const artifactHash = sha256({ attemptKey, bindingHash: sha256(binding),
		qualityPolicyHash: binding.qualityPolicyHash, receiptHashes });
	const events = [
		{ eventType: 'AC_COVERAGE_PASSED', payload: { coveragePass: true } },
		{ eventType: 'AC_COVERAGE_FAILED', payload: { coveragePass: false,
			qualityCheckpointBindingHash: state.qualityCheckpointBindingHash,
			qualityCheckpointTreeSha: state.qualityCheckpointTreeSha } },
	];
	const findings = [{ severity: 'P1', evidence: 'Current candidate fails.' }];
	const reviews = [
		{ phase: 'qa', attemptKey: 'historical', findingsJson: '[]' },
		{ phase: 'qa', attemptKey, artifactHash, findingsJson: JSON.stringify(findings) },
	];
	const projection = {
		rootDir: '/tmp', paths: { runId: state.runId, runtimeDir: '/tmp/missing-runtime' },
		runtimeStore: {
			getRun: () => state, getGeneration: () => null, listEvents: () => events,
			listCriticReviews: () => reviews,
			getGitCommit: () => null, getPullRequest: () => null,
			getTaskPlan: () => ({ schemaVersion: '2.0.0', tasks: [] }),
			quality: { listClosures: () => [{ binding, receiptHashes }] },
			listDiagnostics: () => [], listOptionalRoleExecutions: () => [],
		},
		continuationInputs: () => ({ authorization: null, pendingInterrupt: null }),
	};
	const result = assembleStatusResult(projection);
	assert.equal(result.coverageAdvisories.coveragePass, false);
	assert.deepEqual(result.qaDivergences, findings);
	for (const suffix of [':follow-up:retrieval', ':dispatch:1']) {
		reviews.push({ phase: 'qa', attemptKey: `${attemptKey}${suffix}`, artifactHash, findingsJson: '[]' });
		events.push({ eventType: 'RUN_READY_FOR_GIT_APPROVAL', payload: { qaDivergences: findings } });
		assert.deepEqual(assembleStatusResult(projection).qaDivergences, []);
		events.pop();
		reviews.pop();
	}
	events.pop();
	assert.equal(assembleStatusResult(projection).coverageAdvisories, null);
	binding.candidateRevision = 1;
	state.qualityCheckpointBindingHash = sha256(binding);
	assert.deepEqual(assembleStatusResult(projection).qaDivergences, []);
});
