import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { validateStatus } from '../agent-status-validate.ts';
import { validateAnswerDocument, validateApprovalResponse } from '../policy/contracts.ts';
import { validatePendingResponse } from './hitl.ts';
import { projectHostInvocation } from './host-invocation.ts';
import { computeContinuation, isInfrastructureContinuation } from './continuation.ts';
import { projectTasks } from './status-document.ts';
import { RUN_ID, INTERRUPT_ID, STATE_HASH, APPROVAL_HASH, DRAFT_HASH, TARGETS, resumeArgv, responseArgv, assertClosed, project } from '../testing/host-card-fixtures.mjs';

test('@ac AC-01 @ac AC-14 continuation stays a sibling of the closed host card', () => {
	const pendingInterrupt = {
		interruptId: INTERRUPT_ID,
		kind: 'approval',
		stateHash: STATE_HASH,
		request: {
			draftHash: DRAFT_HASH,
			approval: { approvalHash: APPROVAL_HASH },
		},
	};
	const state = { state: 'WAITING_FOR_APPROVAL', pendingInterruptId: INTERRUPT_ID };
	const continuation = computeContinuation(state, { pendingInterrupt });
	const card = project(state, { pendingInterrupt });
	assert.deepEqual(continuation, { action: 'answer', reason: 'HUMAN_RESPONSE_REQUIRED' });
	assert.equal(Object.hasOwn(continuation, 'argv'), false);
	assertClosed(card);
});

test('@ac AC-02 approval card is one unfilled response file with revision targets', () => {
	const pendingInterrupt = {
		interruptId: INTERRUPT_ID,
		kind: 'approval',
		stateHash: STATE_HASH,
		request: {
			draftHash: DRAFT_HASH,
			approval: { approvalHash: APPROVAL_HASH },
		},
	};
	const card = project(
		{ state: 'WAITING_FOR_APPROVAL', pendingInterruptId: INTERRUPT_ID },
		{ pendingInterrupt },
	);
	assert.deepEqual(card.argv, responseArgv());
	assert.equal(card.executable, true);
	assert.equal(card.packetConsumed, true);
	assert.equal(card.exitCode, 2);
	assert.deepEqual(card.retry, { allowed: false, maxAdditionalInvocations: 0 });
	assert.deepEqual(card.responseDocument, {
		schemaVersion: '1.0.0',
		interruptId: INTERRUPT_ID,
		stateHash: STATE_HASH,
		action: null,
		approvalHash: APPROVAL_HASH,
		draftHash: DRAFT_HASH,
		changes: [],
	});
	assert.deepEqual(card.responseSlots, {
		field: 'action',
		choices: ['approve', 'revise', 'reject', 'cancel'],
		changes: {
			field: 'changes',
			requiredWhen: 'revise',
			minItems: 1,
			maxItems: 64,
			itemKeys: ['field', 'operation', 'value'],
			targets: TARGETS,
		},
	});
	assert.equal(JSON.stringify(card.responseDocument).includes('responseKind'), false);
	const revised = structuredClone(card.responseDocument);
	revised.action = 'revise';
	const target = card.responseSlots.changes.targets[0];
	revised.changes = [
		{
			field: target.field,
			operation: target.operations[0],
			value: 'revised goal',
		},
	];
	assert.equal(validateApprovalResponse(revised).action, 'revise');
	const emptyRevise = structuredClone(card.responseDocument);
	emptyRevise.action = 'revise';
	assert.throws(() => validateApprovalResponse(emptyRevise), /change/i);
	assert.throws(() => validateApprovalResponse(card.responseDocument), /action/i);
	for (const action of ['approve', 'reject', 'cancel']) {
		const filled = structuredClone(card.responseDocument);
		filled.action = action;
		assert.equal(validateApprovalResponse(filled).action, action);
		assert.deepEqual(validateApprovalResponse(filled).changes, []);
	}
	const unknownField = structuredClone(revised);
	unknownField.changes = [{ field: 'not-a-field', operation: 'set', value: 'x' }];
	assert.throws(() => validateApprovalResponse(unknownField), /allowlisted|field/i);
	const blank = structuredClone(revised);
	blank.changes = [{ field: 'goal', operation: 'set', value: '   ' }];
	assert.throws(() => validateApprovalResponse(blank), /empty|non-empty/i);
});

test('@ac AC-03 authorization card is default authorize without git flags', () => {
	for (const stateName of ['SPEC_APPROVED', 'WAITING_FOR_AUTHORIZATION']) {
		const card = project({ state: stateName });
		assert.deepEqual(card.argv, ['pnpm', 'run', 'agent:sdlc', '--', 'authorize', '--run', RUN_ID, '--json']);
		assert.equal(card.executable, true);
		assert.equal(card.packetConsumed, true);
		assert.equal(card.exitCode, 2);
		assert.deepEqual(card.retry, { allowed: false, maxAdditionalInvocations: 0 });
		assert.equal(card.responseDocument, null);
		assert.equal(card.responseSlots, null);
		const joined = card.argv.join(' ');
		for (const flag of ['--envelope-file', '--push', '--open-pr', '--create-branch', '--create-local-commits']) {
			assert.equal(joined.includes(flag), false, flag);
		}
		assertClosed(card);
	}
});

test('@ac AC-04 @ac AC-05 infrastructure attempt 0 and 1 resume and attempt 2 stops', () => {
	const state = { state: 'BLOCKED', blockedReason: 'HYDRATION_FAILED' };
	const first = project(state, { continuationAttempts: 0 });
	const second = project(state, { continuationAttempts: 1 });
	assert.deepEqual(computeContinuation(state, { continuationAttempts: 0 }), {
		action: 'resume',
		reason: 'INFRASTRUCTURE_RETRY',
	});
	assert.deepEqual(first, second);
	assert.deepEqual(first.argv, resumeArgv());
	assert.equal(first.executable, true);
	assert.equal(first.packetConsumed, true);
	assert.equal(first.exitCode, 3);
	assert.deepEqual(first.retry, { allowed: true, maxAdditionalInvocations: 1 });
	assert.equal(first.responseDocument, null);
	assert.equal(first.responseSlots, null);
	for (const attempts of [2, 3]) {
		const stopped = project(state, { continuationAttempts: attempts });
		assert.deepEqual(computeContinuation(state, { continuationAttempts: attempts }), {
			action: 'stop',
			reason: 'HALTED',
		});
		assert.equal(stopped.executable, false);
		assert.equal(stopped.argv, null);
		assert.equal(stopped.packetConsumed, true);
		assert.equal(stopped.exitCode, 3);
		assert.deepEqual(stopped.retry, { allowed: false, maxAdditionalInvocations: 0 });
		assert.equal(stopped.responseDocument, null);
		assert.equal(stopped.responseSlots, null);
		assertClosed(stopped);
	}
});

test('run deadline expiry halts without an infrastructure resume', () => {
	const state = {
		state: 'BLOCKED',
		blockedReason: 'GOVERNOR_RUN_DEADLINE_EXPIRED',
		lastError: {
			code: 'GOVERNOR_RUN_DEADLINE_EXPIRED',
			message: 'Run deadline has expired',
			metadata: { executionProvenFalse: true },
		},
	};
	assert.equal(isInfrastructureContinuation(state), false);
	assert.deepEqual(computeContinuation(state, { continuationAttempts: 0 }), {
		action: 'stop',
		reason: 'HALTED',
	});
	const card = project(state, { continuationAttempts: 0 });
	assert.equal(card.executable, false);
	assert.equal(card.argv, null);
	assert.equal(card.exitCode, 3);
	assert.deepEqual(card.retry, { allowed: false, maxAdditionalInvocations: 0 });
	assertClosed(card);
});

test('@ac AC-06 git approval emits no git command', () => {
	const card = project({ state: 'READY_FOR_GIT_APPROVAL' });
	assert.deepEqual(computeContinuation({ state: 'READY_FOR_GIT_APPROVAL' }), {
		action: 'stop',
		reason: 'GIT_APPROVAL',
	});
	assert.equal(card.executable, false);
	assert.equal(card.argv, null);
	assert.equal(card.packetConsumed, true);
	assert.equal(card.exitCode, 0);
	const text = JSON.stringify(card);
	assert.equal(text.includes('git commit'), false);
	assert.equal(text.includes('git push'), false);
	const outsideDenylist = text.replace(JSON.stringify(card.forbiddenFlags), '');
	assert.equal(outsideDenylist.includes('--open-pr'), false);
	assertClosed(card);
});

test('@ac AC-07 question card keeps answer values null and slot metadata beside the file', () => {
	const pendingInterrupt = {
		interruptId: 'question-batch',
		kind: 'questions',
		stateHash: STATE_HASH,
		request: {
			questions: [
				{
					questionId: 'q1',
					responseKind: 'boolean',
					options: [],
					required: true,
					prompt: 'this prompt must stay off the card',
				},
			],
		},
	};
	const card = project(
		{ state: 'WAITING_FOR_ANSWERS', pendingInterruptId: 'question-batch' },
		{ pendingInterrupt },
	);
	assert.deepEqual(card.argv, [
		'pnpm',
		'run',
		'agent:sdlc',
		'--',
		'answer',
		'--run',
		RUN_ID,
		'--interrupt',
		'question-batch',
		'--response-file',
		'{response-file}',
		'--json',
	]);
	assert.deepEqual(card.responseDocument, {
		schemaVersion: '1.0.0',
		interruptId: 'question-batch',
		stateHash: STATE_HASH,
		answers: [{ questionId: 'q1', value: null }],
	});
	assert.deepEqual(card.responseSlots, [
		{ questionId: 'q1', responseKind: 'boolean', options: [], required: true },
	]);
	assert.equal(JSON.stringify(card.responseDocument).includes('responseKind'), false);
	assert.equal(JSON.stringify(card).includes('this prompt must stay off the card'), false);
	assert.throws(
		() =>
			validateAnswerDocument(card.responseDocument, {
				schemaVersion: '1.0.0',
				questions: pendingInterrupt.request.questions,
			}),
		/boolean/i,
	);
	assertClosed(card);
});

test('@ac AC-08 plan critic and reconciliation cards leave action null', () => {
	const planInterrupt = {
		interruptId: 'plan-critic-1',
		kind: 'plan_critic',
		stateHash: STATE_HASH,
		request: { stateHash: STATE_HASH },
	};
	const reconciliationInterrupt = {
		interruptId: 'reconcile-1',
		kind: 'reconciliation_conflict',
		stateHash: DRAFT_HASH,
		request: { stateHash: DRAFT_HASH },
	};
	const plan = project(
		{ state: 'WAITING_FOR_PLAN_ACCEPTANCE', pendingInterruptId: planInterrupt.interruptId },
		{ pendingInterrupt: planInterrupt },
	);
	const reconciliation = project(
		{ state: 'RECONCILING_INTEGRATION', pendingInterruptId: reconciliationInterrupt.interruptId },
		{ pendingInterrupt: reconciliationInterrupt },
	);
	assert.deepEqual(plan.argv, responseArgv());
	assert.deepEqual(reconciliation.argv, responseArgv());
	assert.deepEqual(plan.responseDocument, {
		schemaVersion: '1.0.0',
		interruptId: 'plan-critic-1',
		stateHash: STATE_HASH,
		action: null,
	});
	assert.deepEqual(plan.responseSlots, {
		field: 'action',
		choices: ['accept_residual', 'reauthorize', 'cancel'],
	});
	assert.deepEqual(reconciliation.responseDocument, {
		schemaVersion: '1.0.0',
		interruptId: 'reconcile-1',
		stateHash: DRAFT_HASH,
		action: null,
	});
	assert.deepEqual(reconciliation.responseSlots, {
		field: 'action',
		choices: ['escalate', 'cancel'],
	});
	assert.throws(
		() =>
			validatePendingResponse({
				state: { draftHash: DRAFT_HASH },
				interrupt: planInterrupt,
				request: planInterrupt.request,
				response: plan.responseDocument,
				draft: null,
			}),
		/action/i,
	);
	assert.throws(
		() =>
			validatePendingResponse({
				state: { draftHash: DRAFT_HASH },
				interrupt: reconciliationInterrupt,
				request: reconciliationInterrupt.request,
				response: reconciliation.responseDocument,
				draft: null,
			}),
		/action/i,
	);
	assertClosed(plan);
	assertClosed(reconciliation);
});

test('@ac AC-09 attempt 2 is the consumed stop card the publish path records', () => {
	const card = project(
		{ state: 'BLOCKED', blockedReason: 'HYDRATION_FAILED' },
		{ continuationAttempts: 2 },
	);
	assert.equal(card.executable, false);
	assert.equal(card.argv, null);
	assert.equal(card.packetConsumed, true);
	assert.equal(card.exitCode, 3);
});

test('@ac AC-11 projection is pure and does not read process.env', () => {
	const state = { runId: RUN_ID, state: 'PLANNING_TASKS' };
	const extras = { authorization: { baseCommitSha: 'd'.repeat(40) }, pendingInterrupt: null, continuationAttempts: 0 };
	const first = projectHostInvocation(structuredClone(state), structuredClone(extras));
	const second = projectHostInvocation(structuredClone(state), structuredClone(extras));
	assert.deepEqual(first, second);
	const source = fs.readFileSync(new URL('./host-invocation.ts', import.meta.url), 'utf8');
	assert.equal(source.includes('process.env'), false);
});

test('@ac AC-12 an unrecognized interrupt kind is not a consumed stop', () => {
	const card = project(
		{ state: 'WAITING_FOR_ANSWERS', pendingInterruptId: 'odd-interrupt' },
		{
			pendingInterrupt: {
				interruptId: 'odd-interrupt',
				kind: 'not-a-gate',
				stateHash: STATE_HASH,
				request: {},
			},
		},
	);
	assert.equal(card.executable, false);
	assert.equal(card.argv, null);
	assert.equal(card.packetConsumed, false);
	assert.equal(card.exitCode, 2);
	assert.deepEqual(card.retry, { allowed: false, maxAdditionalInvocations: 0 });
	assert.equal(card.responseDocument, null);
	assert.equal(card.responseSlots, null);
	assertClosed(card);
});

test('@ac AC-15 in-progress work and an authorized spec keep an uncapped resume argv', () => {
	const states = [
		'INITIALIZING',
		'SPEC_DRAFTING',
		'REVIEWING_SPEC',
		'PLANNING_TASKS',
		'EVALUATING_POLICY',
		'REVIEWING_PLAN',
		'PREPARING_WORKSPACE',
		'HYDRATING_WORKSPACE',
		'EXECUTING_IMPLEMENTATION',
		'RECONCILING_INTEGRATION',
		'SNAPSHOT_GENERATION',
		'REVIEWING_GENERATION',
		'VERIFYING_PREFLIGHT',
		'REVIEWING_QA',
		'REPAIRING_FAILURE',
		'COMMITTING_CHANGES',
		'VERIFYING_COMMITTED_TREE',
	];
	for (const stateName of states) {
		const card = project({ state: stateName });
		assert.deepEqual(computeContinuation({ runId: RUN_ID, state: stateName }), {
			action: 'resume',
			reason: 'INFRASTRUCTURE_RETRY',
		});
		assert.deepEqual(card.argv, resumeArgv());
		assert.equal(card.executable, true);
		assert.equal(card.packetConsumed, true);
		assert.equal(card.exitCode, 3);
		assert.deepEqual(card.retry, { allowed: false, maxAdditionalInvocations: 0 });
		assert.equal(card.responseDocument, null);
		assert.equal(card.responseSlots, null);
		assert.equal(card.argv.join(' ').includes('--retry'), false);
		assertClosed(card);
	}
	const authorized = project(
		{ state: 'SPEC_APPROVED' },
		{ authorization: { baseCommitSha: 'e'.repeat(40) } },
	);
	assert.deepEqual(authorized.argv, resumeArgv());
	assert.deepEqual(authorized.retry, { allowed: false, maxAdditionalInvocations: 0 });
	assertClosed(authorized);
});

test('@ac AC-17 status accepts bounded-slice progress evidence', () => {
	const projectedTasks = projectTasks(
		{
			tasks: [
				{
					taskId: 'task-1',
					title: 'Bounded task',
					status: 'completed',
					targetPackage: 'tools',
					sliceId: 'slice-1',
					complexityScore: 7,
					exceededLimits: [
						{ dimension: 'pathPrefixes', actual: 6, maximum: 5 },
					],
					targetTreeSha: 'a'.repeat(40),
				},
			],
		},
		{ lastError: null },
	);
	const status = {
		schemaVersion: 1,
		runId: RUN_ID,
		revision: 1,
		updatedAt: '2026-09-27T00:00:00.000Z',
		git: { branch: 'main', headSha: 'f'.repeat(40), dirty: false },
		lane: 'agent',
		phase: 'implement',
		activeOwner: 'agent',
		changeClass: 'B',
		retry: { count: 0, maxRetries: 2 },
		packages: ['tools'],
		tasks: projectedTasks,
		taskProgress: {
			slices: [{ sliceId: 'slice-1', taskIds: ['task-1'] }],
			completedCheckpoints: [
				{ taskId: 'task-1', sliceId: 'slice-1', targetTreeSha: 'a'.repeat(40) },
			],
			nextReadyTask: 'task-2',
			featureNonExposed: true,
		},
	};
	assert.equal(validateStatus(status).ok, true);
	assert.equal(status.tasks[0].complexityScore, 7);
	assert.deepEqual(status.tasks[0].exceededLimits, [
		{ dimension: 'pathPrefixes', actual: 6, maximum: 5 },
	]);
	assert.equal(status.taskProgress.completedCheckpoints[0].taskId, 'task-1');
	assert.equal(status.taskProgress.nextReadyTask, 'task-2');
	assert.equal(status.taskProgress.featureNonExposed, true);
});
