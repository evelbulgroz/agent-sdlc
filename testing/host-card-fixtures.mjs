import assert from 'node:assert/strict';
import { projectHostInvocation } from '../cli/host-invocation.ts';

export const KEYS = [
	'schemaVersion',
	'executable',
	'packetConsumed',
	'exitCode',
	'argv',
	'forbiddenFlags',
	'retry',
	'responseDocument',
	'responseSlots',
];
export const FLAGS = [
	'--create-branch',
	'--create-local-commits',
	'--hitl-tty',
	'--open-pr',
	'--push',
	'--retry',
];
export const RUN_ID = '2026-09-27-host-card';
export const INTERRUPT_ID = 'approval-interrupt';
export const STATE_HASH = 'a'.repeat(64);
export const APPROVAL_HASH = 'b'.repeat(64);
export const DRAFT_HASH = 'c'.repeat(64);
export const TARGETS = [
	{ field: 'goal', operations: ['set'], valueKind: 'text' },
	{ field: 'nonGoals', operations: ['set', 'append', 'remove'], valueKind: 'text-list' },
	{ field: 'owningContext', operations: ['set'], valueKind: 'text' },
	{ field: 'touchedSurfaces', operations: ['set', 'append', 'remove'], valueKind: 'text-list' },
	{ field: 'invariantsAndConstraints', operations: ['set', 'append', 'remove'], valueKind: 'text-list' },
	{ field: 'publicContractImpact', operations: ['set'], valueKind: 'text' },
	{ field: 'acceptanceCriteria', operations: ['set', 'append', 'remove'], valueKind: 'text-list' },
	{ field: 'failureDefenses', operations: ['set', 'append', 'remove'], valueKind: 'text-list' },
	{ field: 'verificationPlan', operations: ['set', 'append', 'remove'], valueKind: 'text-list' },
	{ field: 'unresolvedQuestions', operations: ['set', 'append', 'remove'], valueKind: 'text-list' },
	{ field: 'assumptions', operations: ['set', 'append', 'remove'], valueKind: 'text-list' },
];

export function resumeArgv(runId = RUN_ID) {
	return ['pnpm', 'run', 'agent:sdlc', '--', 'resume', '--run', runId, '--json'];
}

export function responseArgv(runId = RUN_ID) {
	return [
		'pnpm',
		'run',
		'agent:sdlc',
		'--',
		'resume',
		'--run',
		runId,
		'--response-file',
		'{response-file}',
		'--json',
	];
}

export function assertClosed(card) {
	assert.deepEqual(Object.keys(card), KEYS);
	assert.equal(card.schemaVersion, '1.0.0');
	assert.deepEqual(card.forbiddenFlags, FLAGS);
	assert.equal(card.retry.maxAdditionalInvocations, card.retry.allowed ? 1 : 0);
	assert.equal(card.executable, Array.isArray(card.argv) && card.argv.length > 0);
	const text = JSON.stringify(card);
	assert.equal(text.includes('"lastError"'), false);
	assert.equal(text.includes('"prompt"'), false);
	assert.equal(text.includes('"apiKey"'), false);
}

export function project(state, extras = {}) {
	return projectHostInvocation(
		{ runId: RUN_ID, ...state },
		{
			authorization: null,
			pendingInterrupt: null,
			continuationAttempts: 0,
			...extras,
		},
	);
}
