import assert from 'node:assert/strict';
import test from 'node:test';
import { exitCodeForState } from '../cli/cli.ts';

import {
	EXAMPLE_ACCEPTANCE_CRITERION,
	answersForPending,
	completeProposal,
	makeFixture,
} from '../testing/test-support.mjs';
import { ACCEPTANCE_CRITERIA_GRAMMAR_QUESTION_ID } from './acceptance-criteria.ts';

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

test('ungrammatical acceptance criteria stay complete but cannot be approved until rewritten', async () => {
	const fixture = makeFixture('graph-ac-quality', [completeProposal()]);
	try {
		let state = await reachQuestions(fixture);
		const pendingQuestions = fixture.store.getPendingInterrupt(fixture.runId);
		state = await recordAndResume(
			fixture,
			state,
			answersForPending(pendingQuestions, { acceptance: 'An exact spec is approved' }),
		);
		assert.equal(state.state, 'WAITING_FOR_ANSWERS');
		assert.equal(state.completeness.complete, true);
		assert.equal(state.approvedSpecHash, null);
		const grammarPending = fixture.store.getPendingInterrupt(fixture.runId);
		const grammarRequest = fixture.artifacts.readJson(grammarPending.requestArtifact);
		assert.equal(grammarRequest.questions[0].questionId, ACCEPTANCE_CRITERIA_GRAMMAR_QUESTION_ID);
		state = await recordAndResume(fixture, state, {
			schemaVersion: '1.0.0',
			interruptId: grammarPending.interruptId,
			stateHash: grammarPending.stateHash,
			answers: [
				{
					questionId: ACCEPTANCE_CRITERIA_GRAMMAR_QUESTION_ID,
					value: EXAMPLE_ACCEPTANCE_CRITERION,
				},
			],
		});
		assert.equal(state.state, 'WAITING_FOR_APPROVAL');
		const pendingApproval = fixture.store.getPendingInterrupt(fixture.runId);
		const approvalRequest = fixture.artifacts.readJson(pendingApproval.requestArtifact);
		state = await recordAndResume(fixture, state, {
			schemaVersion: '1.0.0',
			interruptId: pendingApproval.interruptId,
			stateHash: pendingApproval.stateHash,
			action: 'approve',
			approvalHash: approvalRequest.approval.approvalHash,
			draftHash: state.draftHash,
			changes: [],
		});
		assert.equal(state.state, 'SPEC_APPROVED');
		assert.equal(state.approvedSpecHash, state.draftHash);
	} finally {
		fixture.close();
	}
});

test('workflow rejects empty, unknown, stale, and replayed question responses without draft changes', async () => {
	const fixture = makeFixture('graph-invalid', [completeProposal()]);
	try {
		const state = await reachQuestions(fixture);
		const pending = fixture.store.getPendingInterrupt(fixture.runId);
		const request = fixture.artifacts.readJson(pending.requestArtifact);
		const originalDraftHash = state.draftHash;
		const invalid = [
			{ ...answersForPending(pending), answers: [] },
			{
				...answersForPending(pending),
				answers: [{ questionId: 'unknown', value: 'x' }],
			},
			{ ...answersForPending(pending), stateHash: 'f'.repeat(64) },
		];
		for (const response of invalid) {
			await assert.rejects(
				fixture.runtime.resume(state, response),
				(error) =>
					error.code === 'INVALID_CONTRACT' ||
					error.code === 'STALE_RESPONSE' ||
					error.code === 'INVALID_TRANSITION',
			);
			assert.equal(fixture.store.getRun(fixture.runId).draftHash, originalDraftHash);
		}
		assert.equal(request.questions.length, 3);
	} finally {
		fixture.close();
	}
});

test('approval supports revision, rejection, and cancellation as distinct terminal paths', async (t) => {
	for (const action of ['revise', 'reject', 'cancel']) {
		await t.test(action, async () => {
			const fixture = makeFixture(`graph-${action}`, [completeProposal()]);
			try {
				let state = await reachQuestions(fixture);
				const questions = fixture.store.getPendingInterrupt(fixture.runId);
				state = await recordAndResume(fixture, state, answersForPending(questions));
				const pending = fixture.store.getPendingInterrupt(fixture.runId);
				const request = fixture.artifacts.readJson(pending.requestArtifact);
				const response = {
					schemaVersion: '1.0.0',
					interruptId: pending.interruptId,
					stateHash: pending.stateHash,
					action,
					approvalHash: action === 'revise' ? null : request.approval.approvalHash,
					draftHash: action === 'revise' ? null : state.draftHash,
					changes:
						action === 'revise'
							? [
									{
										field: 'assumptions',
										operation: 'append',
										value: 'Human revision',
									},
								]
							: [],
				};
				state = await recordAndResume(fixture, state, response);
				if (action === 'revise') {
					assert.equal(state.state, 'WAITING_FOR_APPROVAL');
					assert.notEqual(fixture.artifacts.readJson(state.draftArtifact).assumptions.length, 0);
				} else {
					assert.equal(state.state, action === 'reject' ? 'SPEC_REJECTED' : 'CANCELLED');
				}
			} finally {
				fixture.close();
			}
		});
	}
});

test('configuration hash changes invalidate pending approval and escalate', async () => {
	const fixture = makeFixture('graph-config-change', [completeProposal()]);
	try {
		let state = await reachQuestions(fixture);
		const questions = fixture.store.getPendingInterrupt(fixture.runId);
		state = await recordAndResume(fixture, state, answersForPending(questions));
		assert.equal(state.state, 'WAITING_FOR_APPROVAL');
		const originalLoad = fixture.registry.load.bind(fixture.registry);
		fixture.runtime.registry = {
			load() {
				const loaded = originalLoad();
				return {
					...loaded,
					hashes: { ...loaded.hashes, promptPolicyHash: 'f'.repeat(64) },
				};
			},
		};
		state = await fixture.runtime.start(state);
		assert.equal(state.state, 'ESCALATED');
		assert.equal(state.approvedSpecHash, null);
		assert.equal(state.pendingInterruptId, null);
		assert.equal(state.blockedReason, 'CONFIGURATION_CHANGED');
		assert.equal(fixture.store.getPendingInterrupt(fixture.runId), null);
	} finally {
		fixture.close();
	}
});

test('interview and model operation limits escalate without dispatching or reusing an operation', async (t) => {
	const partialProposal = {
		patch: completeProposal().patch,
		questions: [completeProposal().questions[0]],
	};
	for (const [label, limits] of [
		['max interview round', { maxInterviewRounds: 1, maxModelOperations: 3 }],
		['max model operation', { maxInterviewRounds: 3, maxModelOperations: 1 }],
	]) {
		await t.test(label, async () => {
			const fixture = makeFixture(`graph-${label}`, [partialProposal]);
			try {
				const originalLoad = fixture.registry.load.bind(fixture.registry);
				fixture.runtime.registry = {
					load() {
						const loaded = originalLoad();
						return {
							...loaded,
							workflow: {
								...loaded.workflow,
								limits: { ...loaded.workflow.limits, ...limits },
							},
						};
					},
				};
				let state = await reachQuestions(fixture);
				const pending = fixture.store.getPendingInterrupt(fixture.runId);
				state = await recordAndResume(fixture, state, {
					schemaVersion: '1.0.0',
					interruptId: pending.interruptId,
					stateHash: pending.stateHash,
					answers: [{ questionId: 'acceptance', value: 'A bounded outcome exists' }],
				});
				assert.equal(state.state, 'ESCALATED');
				assert.equal(exitCodeForState(state.state), 3);
				assert.equal(state.blockedReason, 'INTERVIEW_LIMIT_REACHED');
				assert.equal(fixture.governor.calls.length, 1);
				assert.equal(state.modelOperations.length, 1);
				assert.equal(new Set(state.modelOperations).size, 1);
				assert.equal(
					fixture.store
						.listEvents(fixture.runId)
						.filter((event) => event.eventType === 'MODEL_OPERATION_REQUESTED').length,
					1,
				);
				const reconciled = fixture.store.reconcile(fixture.runId);
				assert.equal(reconciled.state.state, 'ESCALATED');
			} finally {
				fixture.close();
			}
		});
	}
});
