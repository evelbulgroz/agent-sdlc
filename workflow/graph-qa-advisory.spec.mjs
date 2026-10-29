import '../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';
import {
	citingSpecWriteAction,
	createMockExecCli,
	leanWriteAction,
} from '../testing/test-support.mjs';
import {
	conditioningProposal,
	implementerScript,
	makeGraphFixture,
	reachSpecApproved,
	slice4ImplementerScript,
} from '../testing/graph-fixtures.mjs';

test('QA critic runs once after task verification PASS', async () => {
	const execCalls = [];
	const execCli = createMockExecCli();
	const recordingExecCli = (cmd, args = [], opts = {}) => {
		execCalls.push({ cmd, args });
		return execCli(cmd, args, opts);
	};
	const fixture = makeGraphFixture('slice3-qa-once',  implementerScript(), { profile: 'slice3', 
		execCli: recordingExecCli,
	});
	try {
		const approved = await reachSpecApproved(fixture);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['apps/services/conditioning'],
			allowedPathPrefixes: ['apps/services/conditioning'],
		});
		const terminal = await fixture.runtime.authorize(approved, envelope);
		assert.equal(terminal.state, 'READY_FOR_GIT_APPROVAL');
		const qaReviews = fixture.store
			.listCriticReviews(fixture.runId)
			.filter((review) => review.phase === 'qa');
		assert.equal(qaReviews.length, 1);
		assert.equal(
			fixture.governor.calls.filter((call) => call.profile === 'critic-review').length >= 1,
			true,
		);
		assert.equal(
			execCalls.some((call) => call.cmd === 'pnpm' && call.args.includes('test')),
			true,
		);
	} finally {
		fixture.close();
	}
});

test('verifier FAIL does not invoke QA critic', async () => {
	const fixture = makeGraphFixture('slice3-qa-skip-fail',  implementerScript(), { profile: 'slice3', 
		execCli: createMockExecCli({ preflightStatus: 'FAIL' }),
	});
	try {
		const approved = await reachSpecApproved(fixture);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['apps/services/conditioning'],
			allowedPathPrefixes: ['apps/services/conditioning'],
			maxSemanticRepairs: 0,
		});
		const terminal = await fixture.runtime.authorize(approved, envelope);
		assert.equal(terminal.state, 'ESCALATED');
		assert.equal(terminal.blockedReason, 'AUTONOMOUS_REPAIR_RETIRED');
		const repairerCalls = fixture.governor.calls.filter(
			(call) => call.attribution?.roleId === 'repairer',
		);
		assert.equal(repairerCalls.length, 0);
		const qaReviews = fixture.store
			.listCriticReviews(fixture.runId)
			.filter((review) => review.phase === 'qa');
		assert.equal(qaReviews.length, 0);
		assert.equal(
			fixture.store.listEvents(fixture.runId).some((event) => event.eventType === 'QA_CRITIC_COMPLETED'),
			false,
		);
	} finally {
		fixture.close();
	}
});

test('@ac AC-02 reviewer advisory reaches one QA critic without creating a repair generation', async () => {
	const script = [
		conditioningProposal(),
		leanWriteAction(
			'apps/services/conditioning/src/feature.ts',
			'export const bad = true;\n',
		),
		citingSpecWriteAction(),
		{ action: { kind: 'complete', summary: 'Done' } },
		{ action: { kind: 'complete', summary: 'Audit confirmed' } },
		{
			status: 'FAIL',
			summary: 'Missing invariant check',
			findings: [
				{
					findingId: 'f-1',
					severity: 'P1',
					category: 'correctness',
					path: 'apps/services/conditioning/src/feature.ts',
					lineRange: [1, 1],
					evidence: 'export const bad = true;',
					failureMechanism: 'Missing invariant guardrail',
					remediation: 'Add invariant check',
				},
			],
		},
	];
	const fixture = makeGraphFixture('slice3-qa-after-repair', script, { profile: 'slice3' });
	try {
		const approved = await reachSpecApproved(fixture);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['apps/services/conditioning'],
			allowedPathPrefixes: ['apps/services/conditioning'],
			maxSemanticRepairs: 2,
		});
		const terminal = await fixture.runtime.authorize(approved, envelope);
		assert.equal(terminal.state, 'READY_FOR_GIT_APPROVAL');
		assert.equal(terminal.activeGeneration, 0);
		assert.equal(fixture.store.getSemanticRepairsCount(fixture.runId), 0);
		const qaReviews = fixture.store
			.listCriticReviews(fixture.runId)
			.filter((review) => review.phase === 'qa');
		assert.equal(qaReviews.length, 1);
	} finally {
		fixture.close();
	}
});

test('@ac AC-02 QA critic P1 is advisory and does not rewrite green preflight', async () => {
	const fixture = makeGraphFixture('slice3-qa-p1-repair', [
		...implementerScript(),
		{
			__role: 'critic',
			status: 'FAIL',
			findings: [QA_P1_FINDING],
		},
	], { profile: 'slice3' });
	try {
		const approved = await reachSpecApproved(fixture);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['apps/services/conditioning'],
			allowedPathPrefixes: ['apps/services/conditioning'],
			maxSemanticRepairs: 2,
		});
		const terminal = await fixture.runtime.authorize(approved, envelope);
		const qaReviews = fixture.store
			.listCriticReviews(fixture.runId)
			.filter((review) => review.phase === 'qa');
		assert.equal(qaReviews.length, 1);
		assert.equal(qaReviews[0].hasP1, true);
		const events = fixture.store.listEvents(fixture.runId);
		const qaP1Advisory = events.find(
			(event) =>
				event.eventType === 'REVIEW_EVALUATED' &&
				event.payload?.source === 'qa-critic',
		);
		assert.ok(qaP1Advisory);
		assert.equal(qaP1Advisory.payload.repairAuthorized, false);
		assert.equal(qaP1Advisory.payload.semanticAdvisories.length, 1);
		assert.equal(fixture.store.getSemanticRepairsCount(fixture.runId), 0);
		assert.equal(terminal.state, 'READY_FOR_GIT_APPROVAL');
		assert.ok(terminal.preflightBindingArtifact);
		const binding = fixture.artifacts.readJson(terminal.preflightBindingArtifact);
		assert.equal(binding.status, 'OK');
		assert.equal(binding.canonical, true);
	} finally {
		fixture.close();
	}
});

test('@ac AC-02 QA critic P1 on an out-of-scope high-risk path remains advisory', async () => {
	const fixture = makeGraphFixture('slice3-qa-p1-highrisk', [
		...implementerScript(),
		{
			__role: 'critic',
			status: 'FAIL',
			findings: [
				{
					...QA_P1_FINDING,
					file: 'packages/ddd-base/src/index.ts',
				},
			],
		},
	], { profile: 'slice3' });
	try {
		const approved = await reachSpecApproved(fixture);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['apps/services/conditioning'],
			allowedPathPrefixes: ['apps/services/conditioning'],
			maxSemanticRepairs: 2,
		});
		const terminal = await fixture.runtime.authorize(approved, envelope);
		assert.equal(terminal.state, 'READY_FOR_GIT_APPROVAL');
		assert.equal(fixture.store.getSemanticRepairsCount(fixture.runId), 0);
		const advisory = fixture.store
			.listEvents(fixture.runId)
			.find(
				(event) =>
					event.eventType === 'REVIEW_EVALUATED' &&
					event.payload?.source === 'qa-critic',
			);
		assert.ok(advisory);
		assert.equal(
			advisory.payload.semanticAdvisories[0].assessment.reason,
			'OUT_OF_SCOPE_PATH',
		);
		const qaReviews = fixture.store
			.listCriticReviews(fixture.runId)
			.filter((review) => review.phase === 'qa');
		assert.equal(qaReviews.length, 1);
		assert.equal(qaReviews[0].hasP1, true);
	} finally {
		fixture.close();
	}
});

const QA_P1_FINDING = {
	severity: 'P1',
	category: 'testing',
	file: 'apps/services/conditioning/src/main.ts',
	evidence: 'Acceptance criteria are not covered by assertions',
	impact: 'Green preflight can ship unproven behavior',
	remediation: 'Add shadow-path tests for the changed feature',
};

test('@ac AC-02 QA P1 advisory does not dispatch a second model critic or repairer', async () => {
	const fixture = makeGraphFixture('s4-code-from-qa', [
		...slice4ImplementerScript(),
		{
			__role: 'critic',
			status: 'FAIL',
			findings: [QA_P1_FINDING],
		},
	], { profile: 'slice4' });
	try {
		const approved = await reachSpecApproved(fixture);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['apps/services/conditioning'],
			allowedPathPrefixes: ['apps/services/conditioning'],
			maxSemanticRepairs: 2,
		});
		const terminal = await fixture.runtime.authorize(approved, envelope);
		assert.equal(terminal.state, 'READY_FOR_GIT_APPROVAL');
		assert.equal(fixture.store.getSemanticRepairsCount(fixture.runId), 0);
		const codeCalls = fixture.governor.calls.filter((call) =>
			String(call.operationId || '').includes(':critic:code:'),
		);
		assert.equal(codeCalls.length, 0);
		const codeReviews = fixture.store
			.listCriticReviews(fixture.runId)
			.filter((review) => review.phase === 'code');
		assert.equal(codeReviews.length, 0);
		assert.ok(
			fixture.store
				.listEvents(fixture.runId)
				.some(
					(event) =>
						event.eventType === 'REVIEW_EVALUATED' &&
						event.payload?.source === 'qa-critic' &&
						event.payload?.repairAuthorized === false,
				),
		);
	} finally {
		fixture.close();
	}
});

test('@ac AC-02 out-of-scope QA P1 is advisory and cannot trigger high-risk repair escalation', async () => {
	const fixture = makeGraphFixture('s4-code-highrisk', [
		...slice4ImplementerScript(),
		{
			__role: 'critic',
			status: 'FAIL',
			findings: [
				{
					...QA_P1_FINDING,
					file: 'packages/ddd-base/src/index.ts',
				},
			],
		},
	], { profile: 'slice4' });
	try {
		const approved = await reachSpecApproved(fixture);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['apps/services/conditioning'],
			allowedPathPrefixes: ['apps/services/conditioning'],
			maxSemanticRepairs: 2,
		});
		const terminal = await fixture.runtime.authorize(approved, envelope);
		assert.equal(terminal.state, 'READY_FOR_GIT_APPROVAL');
		assert.equal(fixture.store.getSemanticRepairsCount(fixture.runId), 0);
		const codeReviews = fixture.store
			.listCriticReviews(fixture.runId)
			.filter((review) => review.phase === 'code');
		assert.equal(codeReviews.length, 0);
		const advisory = fixture.store
			.listEvents(fixture.runId)
			.find(
				(event) =>
					event.eventType === 'REVIEW_EVALUATED' &&
					event.payload?.source === 'qa-critic',
			);
		assert.ok(advisory);
		assert.equal(
			advisory.payload.semanticAdvisories[0].assessment.reason,
			'OUT_OF_SCOPE_PATH',
		);
	} finally {
		fixture.close();
	}
});
