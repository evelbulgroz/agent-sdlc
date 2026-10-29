import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';
import { SdlcError } from '../policy/errors.ts';
import { makeFixture } from '../testing/test-support.mjs';
import {
	collectQaBriefAndAdvisories,
	deferUnavailableCritic,
	getAndValidateAuthorization,
} from './node-helpers.ts';

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
			approvedSpecHash,
		};

		const validated = getAndValidateAuthorization(fixture.runtime, snapshot);
		assert.equal(validated.runId, fixture.runId);
		assert.equal(validated.baseCommitSha, baseCommitSha);
		assert.equal(validated.approvedSpecHash, approvedSpecHash);
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
