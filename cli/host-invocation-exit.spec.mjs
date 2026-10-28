import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { validateStatus } from '../agent-status-validate.ts';
import { exitCodeForResult } from './exit-codes.ts';
import { projectHostInvocation } from './host-invocation.ts';
import { computeContinuation } from './continuation.ts';
import { RUN_ID, INTERRUPT_ID, STATE_HASH, APPROVAL_HASH, DRAFT_HASH, assertClosed, project } from '../testing/host-card-fixtures.mjs';

test('card exit matches the process exit for every continuation action', () => {
	const approvalInterrupt = {
		interruptId: INTERRUPT_ID,
		kind: 'approval',
		stateHash: STATE_HASH,
		request: { draftHash: DRAFT_HASH, approval: { approvalHash: APPROVAL_HASH } },
	};
	const cases = [
		{ state: { runId: RUN_ID, state: 'SPEC_APPROVED' } },
		{
			state: { runId: RUN_ID, state: 'WAITING_FOR_APPROVAL', pendingInterruptId: INTERRUPT_ID },
			extras: { pendingInterrupt: approvalInterrupt },
		},
		{ state: { runId: RUN_ID, state: 'PLANNING_TASKS' } },
		{
			state: { runId: RUN_ID, state: 'BLOCKED', blockedReason: 'HYDRATION_FAILED' },
			extras: { continuationAttempts: 0 },
		},
		{
			state: { runId: RUN_ID, state: 'BLOCKED', blockedReason: 'HYDRATION_FAILED' },
			extras: { continuationAttempts: 2 },
		},
		{ state: { runId: RUN_ID, state: 'READY_FOR_GIT_APPROVAL' } },
		{ state: { runId: RUN_ID, state: 'DONE' } },
		{ state: { runId: RUN_ID, state: 'CANCELLED' } },
		{ state: { runId: RUN_ID, state: 'SPEC_REJECTED' } },
		{ state: { runId: RUN_ID, state: 'BUDGET_EXHAUSTED' } },
		{ state: { runId: RUN_ID, state: 'FAILED' } },
		{ state: { runId: RUN_ID, state: 'ESCALATED' } },
		{ state: { runId: RUN_ID, state: 'BLOCKED', blockedReason: 'TASK_EXECUTION_FAILED' } },
	];
	for (const { state, extras } of cases) {
		const continuation = computeContinuation(state, extras);
		const card = projectHostInvocation(state, extras);
		assert.equal(
			card.exitCode,
			exitCodeForResult({ ...state, continuation }),
			`${state.state} attempts=${extras?.continuationAttempts ?? 0}`,
		);
	}
});

test('@ac AC-10 answer authorize and resume cards are consumed with their process exits', () => {
	const answer = project(
		{ state: 'WAITING_FOR_APPROVAL', pendingInterruptId: INTERRUPT_ID },
		{
			pendingInterrupt: {
				interruptId: INTERRUPT_ID,
				kind: 'approval',
				stateHash: STATE_HASH,
				request: { draftHash: DRAFT_HASH, approval: { approvalHash: APPROVAL_HASH } },
			},
		},
	);
	const authorize = project({ state: 'SPEC_APPROVED' });
	const resume = project({ state: 'PLANNING_TASKS' });
	assert.equal(answer.packetConsumed, true);
	assert.equal(answer.exitCode, 2);
	assert.equal(authorize.packetConsumed, true);
	assert.equal(authorize.exitCode, 2);
	assert.equal(resume.packetConsumed, true);
	assert.equal(resume.exitCode, 3);
});

test('@ac AC-13 host documents tell every host to run the card and stop on a consumed null argv', () => {
	const executable = 'The host runs every executable hostInvocation.argv, including the approval response-file resume and a resume whose retry.allowed is false.';
	const finished = 'packetConsumed true with a null argv is a finished packet when the process exit is 0, 2, 3, or 4.';
	const planning = 'Planning and plan critic run after the envelope is stored.';
	for (const relativePath of ['packages/agent-sdlc/README.md', 'packages/agent-sdlc/cli/README.md']) {
		const text = fs.readFileSync(new URL(`../../../${relativePath}`, import.meta.url), 'utf8');
		assert.equal(text.includes(executable), true, relativePath);
		assert.equal(text.includes(finished), true, relativePath);
		assert.equal(text.includes(planning), true, relativePath);
		assert.equal(text.includes('The host does not keep its own retry count.'), true, relativePath);
		assert.equal(text.includes('capped retry policy'), false, relativePath);
		assert.equal(text.includes('--response reject'), false, relativePath);
	}
});

test('@ac AC-16 ordinary stops are consumed and carry the process exit', () => {
	const cases = [
		[{ state: 'DONE' }, 0],
		[{ state: 'CANCELLED' }, 4],
		[{ state: 'BUDGET_EXHAUSTED' }, 3],
		[{ state: 'BLOCKED', blockedReason: 'TASK_EXECUTION_FAILED' }, 3],
	];
	for (const [state, exitCode] of cases) {
		const card = project(state);
		assert.equal(card.executable, false, state.state);
		assert.equal(card.argv, null, state.state);
		assert.equal(card.packetConsumed, true, state.state);
		assert.equal(card.responseDocument, null, state.state);
		assert.equal(card.responseSlots, null, state.state);
		assert.equal(card.exitCode, exitCode, state.state);
		assertClosed(card);
	}
});

test('@ac AC-14 a malformed card fails validation and an older status file may omit it', () => {
	const card = project({ state: 'DONE' });
	const status = {
		schemaVersion: 1,
		runId: RUN_ID,
		revision: 1,
		updatedAt: '2026-09-27T00:00:00.000Z',
		git: { branch: 'main', headSha: 'f'.repeat(40), dirty: false },
		lane: 'agent',
		phase: 'spec',
		activeOwner: 'human',
		changeClass: 'D',
		retry: { count: 0, maxRetries: 2 },
		packages: [],
		tasks: [],
	};
	assert.equal(validateStatus(status).ok, true);
	assert.equal(validateStatus({ ...status, hostInvocation: card }).ok, true);
	const extra = { ...card, prompt: 'hidden' };
	assert.equal(validateStatus({ ...status, hostInvocation: extra }).ok, false);
	const argvMismatch = { ...card, executable: true, argv: null };
	assert.equal(validateStatus({ ...status, hostInvocation: argvMismatch }).ok, false);
	const retryMismatch = {
		...card,
		retry: { allowed: true, maxAdditionalInvocations: 0 },
	};
	assert.equal(validateStatus({ ...status, hostInvocation: retryMismatch }).ok, false);
	const forbidden = {
		...project({ state: 'PLANNING_TASKS' }),
		argv: ['pnpm', 'run', 'agent:sdlc', '--', 'resume', '--run', RUN_ID, '--retry', '--json'],
	};
	assert.equal(validateStatus({ ...status, hostInvocation: forbidden }).ok, false);
});
