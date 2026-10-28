import assert from 'node:assert/strict';
import test from 'node:test';
import { answersForPending, completeProposal, makeFixture } from '../testing/test-support.mjs';

const P1_FINDING = {
	severity: 'P1',
	category: 'correctness',
	file: 'specification',
	evidence: 'Acceptance criteria are not observable',
	impact: 'The run can ship the wrong thing',
	remediation: 'State a measurable outcome',
};

async function reachQuestions(fixture) {
	const initial = fixture.runtime.initialize({
		runId: fixture.runId,
		goal: 'Build a durable local specification workflow',
	});
	const waiting = await fixture.runtime.start(initial);
	assert.equal(waiting.state, 'WAITING_FOR_ANSWERS');
	return waiting;
}

async function recordAndResume(fixture, state, response) {
	const artifact = fixture.artifacts.writeJson('human-response', response);
	fixture.store.recordInterruptResponse(state.pendingInterruptId, artifact);
	return fixture.runtime.resume(state, response);
}

async function answerQuestions(fixture, state) {
	const pendingQuestions = fixture.store.getPendingInterrupt(fixture.runId);
	const answers = answersForPending(pendingQuestions);
	return recordAndResume(fixture, state, answers);
}

function approveResponse(fixture, state) {
	const pendingApproval = fixture.store.getPendingInterrupt(fixture.runId);
	const approvalRequest = fixture.artifacts.readJson(pendingApproval.requestArtifact);
	return {
		schemaVersion: '1.0.0',
		interruptId: pendingApproval.interruptId,
		stateHash: pendingApproval.stateHash,
		action: 'approve',
		approvalHash: approvalRequest.approval.approvalHash,
		draftHash: state.draftHash,
		changes: [],
		pending: pendingApproval,
		approvalRequest,
	};
}

test('spec critic runs before approval and freezes approvedSpecHash from the presented draft', async () => {
	const fixture = makeFixture('graph-spec-critic-pass', [completeProposal()]);
	try {
		let state = await reachQuestions(fixture);
		state = await answerQuestions(fixture, state);
		assert.equal(state.state, 'WAITING_FOR_APPROVAL');
		assert.equal(state.completeness.complete, true);
		assert.equal(state.authorVendor, 'google');
		const specReviews = fixture.store
			.listCriticReviews(fixture.runId)
			.filter((review) => review.phase === 'spec');
		assert.equal(specReviews.length, 1);
		assert.equal(specReviews[0].artifactHash, state.draftHash);
		assert.equal(specReviews[0].attemptKey, 'spec:0');
		const pending = fixture.store.getPendingInterrupt(fixture.runId);
		const request = fixture.artifacts.readJson(pending.requestArtifact);
		assert.equal(request.criticReport.hasP1, false);
		assert.equal(request.criticReport.artifactHash, state.draftHash);

		const approval = approveResponse(fixture, state);
		state = await recordAndResume(fixture, state, {
			schemaVersion: '1.0.0',
			interruptId: approval.interruptId,
			stateHash: approval.stateHash,
			action: 'approve',
			approvalHash: approval.approvalHash,
			draftHash: approval.draftHash,
			changes: [],
		});
		assert.equal(state.state, 'SPEC_APPROVED');
		assert.equal(state.approvedSpecHash, state.draftHash);
		assert.equal(
			fixture.governor.calls.filter((call) => call.profile === 'critic-review').length,
			1,
		);
	} finally {
		fixture.close();
	}
});

test('spec critic P1 is presented to the human when autonomous repair cap is reached and round 2 uses a new draftHash after revise', async () => {
	const fixture = makeFixture('graph-spec-critic-p1', [
		completeProposal(),
		{
			__role: 'critic',
			status: 'FAIL',
			findings: [P1_FINDING],
		},
		{
			patch: [
				{
					field: 'assumptions',
					operation: 'append',
					value: 'Specifier repair attempt 1',
				},
			],
			questions: [],
		},
		{
			__role: 'critic',
			status: 'FAIL',
			findings: [P1_FINDING],
		},
		{
			__role: 'critic',
			status: 'PASS',
			findings: [],
		},
	]);
	try {
		let state = await reachQuestions(fixture);
		state = await answerQuestions(fixture, state);
		assert.equal(state.state, 'WAITING_FOR_APPROVAL');
		const pending = fixture.store.getPendingInterrupt(fixture.runId);
		const request = fixture.artifacts.readJson(pending.requestArtifact);
		assert.equal(request.criticReport.hasP1, true);
		const specReviews = fixture.store
			.listCriticReviews(fixture.runId)
			.filter((review) => review.phase === 'spec');
		assert.equal(specReviews.length, 2);
		assert.equal(specReviews[0].attemptKey, 'spec:0');
		assert.equal(specReviews[1].attemptKey, 'spec:0');
		assert.equal(specReviews[0].hasP1, true);
		assert.equal(specReviews[1].hasP1, true);

		state = await recordAndResume(fixture, state, {
			schemaVersion: '1.0.0',
			interruptId: pending.interruptId,
			stateHash: pending.stateHash,
			action: 'revise',
			approvalHash: null,
			draftHash: null,
			changes: [
				{
					field: 'assumptions',
					operation: 'append',
					value: 'Human addressed critic P1',
				},
			],
		});
		assert.equal(state.state, 'WAITING_FOR_APPROVAL');
		assert.equal(state.specApprovalAttempt, 1);
		const afterRevise = fixture.store
			.listCriticReviews(fixture.runId)
			.filter((review) => review.phase === 'spec');
		assert.equal(afterRevise.length, 3);
		assert.notEqual(afterRevise[0].artifactHash, afterRevise[2].artifactHash);
		assert.equal(afterRevise[2].attemptKey, 'spec:1');
		assert.equal(afterRevise[0].generation, 0);
		assert.equal(afterRevise[1].generation, 1);
		assert.equal(afterRevise[2].generation, 2);
		assert.equal(
			fixture.governor.calls.filter((call) => call.profile === 'critic-review').length,
			3,
		);
	} finally {
		fixture.close();
	}
});

test('spec critic P1 is autonomously repaired by specifier role before human approval (AC-02)', async () => {
	const fixture = makeFixture('graph-spec-critic-auto-repair', [
		completeProposal(),
		{
			__role: 'critic',
			status: 'FAIL',
			findings: [P1_FINDING],
		},
		{
			patch: [
				{
					field: 'assumptions',
					operation: 'append',
					value: 'Specifier addressed critic P1 autonomously',
				},
			],
			questions: [],
		},
		{
			__role: 'critic',
			status: 'PASS',
			findings: [],
		},
	]);
	try {
		let state = await reachQuestions(fixture);
		state = await answerQuestions(fixture, state);
		assert.equal(state.state, 'WAITING_FOR_APPROVAL');
		const pending = fixture.store.getPendingInterrupt(fixture.runId);
		const request = fixture.artifacts.readJson(pending.requestArtifact);
		assert.equal(request.criticReport.hasP1, false);
		const specReviews = fixture.store
			.listCriticReviews(fixture.runId)
			.filter((review) => review.phase === 'spec');
		assert.equal(specReviews.length, 2);
		assert.equal(specReviews[0].attemptKey, 'spec:0');
		assert.equal(specReviews[1].attemptKey, 'spec:0');
		assert.equal(specReviews[0].hasP1, true);
		assert.equal(specReviews[1].hasP1, false);
		assert.notEqual(specReviews[0].artifactHash, specReviews[1].artifactHash);
		assert.equal(
			fixture.governor.calls.filter((call) => call.profile === 'critic-review').length,
			2,
		);
	} finally {
		fixture.close();
	}
});

test('human revise increments specApprovalAttempt and allows a new critic budget', async () => {
	const fixture = makeFixture('graph-spec-critic-revise', [completeProposal()]);
	try {
		let state = await reachQuestions(fixture);
		state = await answerQuestions(fixture, state);
		assert.equal(state.state, 'WAITING_FOR_APPROVAL');
		const pending = fixture.store.getPendingInterrupt(fixture.runId);
		const request = fixture.artifacts.readJson(pending.requestArtifact);
		state = await recordAndResume(fixture, state, {
			schemaVersion: '1.0.0',
			interruptId: pending.interruptId,
			stateHash: pending.stateHash,
			action: 'revise',
			approvalHash: null,
			draftHash: null,
			changes: [
				{
					field: 'assumptions',
					operation: 'append',
					value: 'Human revision',
				},
			],
		});
		assert.equal(state.state, 'WAITING_FOR_APPROVAL');
		assert.equal(state.specApprovalAttempt, 1);
		assert.equal(state.approvedSpecHash, null);
		const specReviews = fixture.store
			.listCriticReviews(fixture.runId)
			.filter((review) => review.phase === 'spec');
		assert.equal(specReviews.length, 2);
		assert.equal(specReviews[1].attemptKey, 'spec:1');
		assert.equal(request.criticReport.attemptKey, 'spec:0');
	} finally {
		fixture.close();
	}
});

test('spec critic operations do not consume specifier maxModelOperations', async () => {
	const fixture = makeFixture('graph-spec-critic-budget', [completeProposal()]);
	try {
		const originalLoad = fixture.registry.load.bind(fixture.registry);
		fixture.registry.load = function load() {
			const loaded = originalLoad();
			return {
				...loaded,
				workflow: {
					...loaded.workflow,
					limits: { ...loaded.workflow.limits, maxModelOperations: 1 },
				},
			};
		};
		let state = await reachQuestions(fixture);
		state = await answerQuestions(fixture, state);
		assert.equal(state.state, 'WAITING_FOR_APPROVAL');
		assert.equal(state.modelOperations.length, 1);
		assert.equal(
			fixture.governor.calls.filter((call) => call.profile === 'critic-review').length,
			1,
		);
	} finally {
		fixture.close();
	}
});

test('spec critic P1 with exhausted model operations bypasses auto-repair and presents directly to human in WAITING_FOR_APPROVAL', async () => {
	const fixture = makeFixture('graph-spec-critic-p1-exhausted-ops', [
		completeProposal(),
		{
			__role: 'critic',
			status: 'FAIL',
			findings: [P1_FINDING],
		},
	]);
	try {
		const originalLoad = fixture.registry.load.bind(fixture.registry);
		fixture.registry.load = function load() {
			const loaded = originalLoad();
			return {
				...loaded,
				workflow: {
					...loaded.workflow,
					limits: { ...loaded.workflow.limits, maxModelOperations: 1 },
				},
			};
		};
		let state = await reachQuestions(fixture);
		state = await answerQuestions(fixture, state);
		assert.equal(state.state, 'WAITING_FOR_APPROVAL');
		assert.equal(state.modelOperations.length, 1);
		const pending = fixture.store.getPendingInterrupt(fixture.runId);
		const request = fixture.artifacts.readJson(pending.requestArtifact);
		assert.equal(request.criticReport.hasP1, true);
		assert.equal(request.criticReport.artifactHash, state.draftHash);
	} finally {
		fixture.close();
	}
});
