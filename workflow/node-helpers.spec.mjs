import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { taskQualityFixture } from '../testing/task-quality-fixture.ts';
import { qaCheckpointAttemptKey } from '../review/critic-budget.ts';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';
import { sha256 } from '../policy/contracts.ts';
import { hashTaskPlanProjection } from '../policy/contracts/dag-schema.ts';
import { SdlcError } from '../policy/errors.ts';
import { policy } from '../testing/quality-test-support.ts';
import { makeFixture } from '../testing/test-support.mjs';
import {
	collectQaBriefAndAdvisories,
	deferUnavailableCritic,
	getAndValidateAuthorization,
} from './node-helpers.ts';
import { commandRegistrationFixture } from '../testing/command-registration-fixture.ts';

test('@ac AC-03 @case AC-03.1 graph getAndValidateAuthorization allows in-flight execution when repository HEAD moves after authorization', () => {
	const fixture = makeFixture('graph-head-drift');
	try {
		fixture.runtime.initialize({ runId: fixture.runId, goal: 'Test drift' });
		const baseCommitSha = '1'.repeat(40);
		const approvedSpecHash = '2'.repeat(64);
		const auth = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash,
			baseCommitSha,
			allowedPackages: ['services/billing'],
			allowedPathPrefixes: ['services/billing/'],
		});
		fixture.store.saveAuthorization(auth);

		// Git HEAD returns a newer commit different from baseCommitSha
		fixture.runtime.gitCli = (cmd, args) => {
			if (args?.[0] === 'rev-parse' && args?.[1] === 'HEAD') {
				return '9'.repeat(40);
			}
			return '';
		};

		const snapshot = {
			runId: fixture.runId,
			state: 'PLANNING_TASKS',
			approvedSpecHash,
			approvedPlanPolicyHash: auth.approvedPlanPolicyHash,
		};

		const validated = getAndValidateAuthorization(fixture.runtime, snapshot);
		assert.equal(validated.runId, fixture.runId);
		assert.equal(validated.baseCommitSha, baseCommitSha);
		assert.equal(validated.approvedSpecHash, approvedSpecHash);
	} finally {
		fixture.close();
	}
});

test('getAndValidateAuthorization rejects a policy changed outside explicit reauthorization', () => {
	const fixture = makeFixture('node-helpers-policy-swap');
	try {
		fixture.runtime.initialize({ runId: fixture.runId, goal: 'Reject policy swap' });
		const adapter = commandRegistrationFixture({ adapterId: 'policy-swap-test', limits: { timeoutMs: 1000, maxReportBytes: 10000, maxArtifactBytes: 1000, maxArtifacts: 1 } });
		const qualityPlan = {
			qualityPolicy: policy,
			adapterBindings: [adapter],
			evidenceObligations: [{
				obligationId: 'obligation-a',
				criterionId: 'AC-01',
				caseId: null,
				owner: { kind: 'slice', id: 'slice-a' },
				observableOutcome: 'The result is visible.',
				setupAction: 'Read the result.',
				expectedResult: 'The result is displayed.',
				layer: 'unit',
				requiredCapabilities: [],
				implementationPaths: ['services/billing'],
				testCases: [{ file: 'services/billing/result.spec.mjs', caseKey: 'visible' }],
				adapterBindingHash: sha256(adapter),
				profileId: 'unit',
			}],
		};
		const auth = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: '2'.repeat(64),
			baseCommitSha: '1'.repeat(40),
			allowedPackages: ['services/billing'],
			allowedPathPrefixes: ['services/billing/'],
			qualityPlan,
		});
		fixture.store.saveAuthorization(auth);
		const plan = {
			schemaVersion: '2.0.0',
			runId: fixture.runId,
			planPolicyHash: 'd'.repeat(64),
			baseCommitSha: auth.baseCommitSha,
			slices: [{
				sliceId: 'slice-a',
				kind: 'vertical',
				goal: 'Expose the result.',
				acceptanceCriteria: ['AC-01'],
				dependsOn: [],
			}],
			tasks: [{
				taskId: 'task-a',
				sliceId: 'slice-a',
				title: 'Expose result',
				targetPackage: 'services/billing',
				pathPrefixes: ['services/billing'],
				dependsOn: [],
				integrationOrder: 0,
			}],
			integrationOrder: ['task-a'],
			isParallel: false,
			createdAt: '2026-11-02T10:00:00.000Z',
			qualityPolicy: policy,
			qualityPolicyHash: sha256(policy),
			adapterBindings: [adapter],
			evidenceObligations: qualityPlan.evidenceObligations,
		};
		fixture.store.saveTaskPlan(plan, auth.approvedPlanPolicyHash);

		assert.throws(
			() => getAndValidateAuthorization(fixture.runtime, {
				runId: fixture.runId,
				state: 'PLANNING_TASKS',
				approvedSpecHash: auth.approvedSpecHash,
				taskPlanHash: hashTaskPlanProjection(plan),
				approvedPlanPolicyHash: 'f'.repeat(64),
			}),
			(error) => error.code === 'AUTHORIZATION_INVALID' && /policy hash approved in runtime state/.test(error.message),
		);
	} finally {
		fixture.close();
	}
});

test('@ac AC-03 @case AC-03.2 deferUnavailableCritic leaves GOVERNOR_BUDGET_DENIED for the budget halt', () => {
	const runtime = {
		transition: (snapshot, { to, eventType, causalId, payload }) => ({
			...snapshot,
			state: to,
			deferredEvent: eventType,
			causalId,
			payload,
		}),
	};
	const snapshot = { runId: 'run-1', runtimeRevision: 1, state: 'REVIEWING_QA' };
	const budgetErr = new SdlcError('GOVERNOR_BUDGET_DENIED', 'Budget exceeded');

	assert.equal(deferUnavailableCritic(runtime, snapshot, 'spec', budgetErr), null);
	assert.equal(deferUnavailableCritic(runtime, snapshot, 'qa', budgetErr), null);

	const routes = deferUnavailableCritic(
		runtime,
		snapshot,
		'qa',
		new SdlcError('GOVERNOR_ROUTES_EXHAUSTED', 'routes'),
	);
	assert.equal(routes.deferredEvent, 'CRITIC_REVIEW_FAILED');
	assert.equal(routes.payload.code, 'GOVERNOR_ROUTES_EXHAUSTED');
	assert.equal(routes.payload.phase, 'qa');
	assert.equal(
		routes.payload.message,
		'Critic unavailable after all configured provider routes failed',
	);
});

test('@ac AC-03 @case AC-03.1 getAndValidateAuthorization rejects a missing envelope', () => {
	const fixture = makeFixture('node-helpers-missing-envelope');
	try {
		fixture.runtime.initialize({ runId: fixture.runId, goal: 'Missing envelope' });
		assert.throws(
			() => getAndValidateAuthorization(fixture.runtime, {
				runId: fixture.runId,
				approvedSpecHash: 'a'.repeat(64),
			}),
			/No authorization envelope/,
		);
	} finally {
		fixture.close();
	}
});

test('@ac AC-03 collectQaBriefAndAdvisories returns empty advisories when no QA review exists', () => {
	const fixture = makeFixture('node-helpers-empty-qa');
	try {
		const snapshot = fixture.runtime.initialize({ runId: fixture.runId, goal: 'Empty QA' });
		const advisories = collectQaBriefAndAdvisories(fixture.runtime, snapshot);
		assert.deepEqual(advisories.qaDivergences, []);
		assert.equal(advisories.coverageAdvisories, null);
		assert.deepEqual(advisories.semanticReviewAdvisories, []);
	} finally {
		fixture.close();
	}
});

test('delivery brief uses the clearing follow-up or dispatch review instead of the base-key P1', t => {
	const f = taskQualityFixture(t);
	const snapshot = { ...f.snapshot, qualityCheckpointKind: 'final', qualityCheckpointTreeSha: f.tree };
	const attemptKey = qaCheckpointAttemptKey({
		approvedSpecHash: snapshot.approvedSpecHash, taskPlanHash: snapshot.taskPlanHash,
		checkpointKind: 'final', treeSha: f.tree,
	});
	const manifestPath = path.join(f.rootDir, 'qa-manifest.json');
	const failedPath = path.join(f.rootDir, 'failed-review.json');
	const passedPath = path.join(f.rootDir, 'passed-review.json');
	const findings = [{ severity: 'P1', evidence: 'Superseded concern' }];
	fs.writeFileSync(failedPath, JSON.stringify({ findings }));
	fs.writeFileSync(passedPath, JSON.stringify({ findings: [] }));
	fs.writeFileSync(manifestPath, JSON.stringify({ reviews: [
		{ reviewId: 'base', reportPath: failedPath }, { reviewId: 'cleared', reportPath: passedPath },
	] }));
	const reviews = [{ phase: 'qa', reviewId: 'base', attemptKey, manifestPath }];
	f.store.listCriticReviews = () => reviews;
	assert.deepEqual(collectQaBriefAndAdvisories(f.runtime, snapshot).qaDivergences, findings);
	for (const suffix of [':follow-up:retrieval', ':dispatch:1']) {
		reviews.push({ phase: 'qa', reviewId: 'cleared', attemptKey: `${attemptKey}${suffix}`, manifestPath });
		assert.deepEqual(collectQaBriefAndAdvisories(f.runtime, snapshot).qaDivergences, []);
		reviews.pop();
	}
});
