import assert from 'node:assert/strict';
import test from 'node:test';
import { projectHostInvocation } from './host-invocation.ts';
import { SdlcError } from '../policy/errors.ts';

const RUN_ID = 'quality-run';
const INTERRUPT_ID = 'quality-interrupt';
const BINDING_HASH = 'ab'.repeat(32);
const ACTIONS = ['refute', 'confirm', 'approve-correction'];

function project(allowedActions, request = {}) {
	return projectHostInvocation(
		{ runId: RUN_ID, state: 'BLOCKED', pendingInterruptId: INTERRUPT_ID, blockedReason: 'QUALITY_REVIEW_BLOCKED' },
		{
			pendingInterrupt: {
				interruptId: INTERRUPT_ID,
				kind: 'quality_review',
				request: { bindingHash: BINDING_HASH, allowedActions, findings: [{ findingId: 'finding-a' }], ...request },
			},
		},
	);
}

test('@ac AC-01 @case AC-01.1 @case AC-01.2 a quality-review card answers with the listed actions', () => {
	const card = project(ACTIONS);
	assert.equal(card.executable, true);
	assert.equal(card.argv.includes('answer'), true);
	assert.equal(card.argv.includes('resume'), false);
	assert.equal(card.argv.includes('reply'), false);
	assert.equal(card.argv[card.argv.indexOf('--run') + 1], RUN_ID);
	assert.equal(card.argv.includes('--response-file'), true);
	assert.equal(card.argv[card.argv.indexOf('--response-file') + 1], '{response-file}');
	assert.equal(card.argv.includes('--interrupt'), true);
	assert.deepEqual(card.responseSlots.choices, ACTIONS);
	assert.equal(card.responseDocument.stateHash, undefined);
	assert.equal(card.responseDocument.bindingHash, BINDING_HASH);
	assert.equal(card.responseDocument.answerId, null);
	assert.equal(card.responseDocument.correction, null);
	assert.deepEqual(card.responseDocument.findingIds, ['finding-a']);
	const withoutCorrection = project(['refute', 'confirm']);
	assert.deepEqual(withoutCorrection.responseSlots.choices, ['refute', 'confirm']);
	assert.equal(withoutCorrection.responseSlots.choices.includes('approve-correction'), false);
});

test('a quality card with no allowed actions publishes an empty slot', () => {
	const missing = project(undefined);
	assert.equal(missing.executable, true);
	assert.deepEqual(missing.responseSlots.choices, []);
	const empty = project([]);
	assert.deepEqual(empty.responseSlots.choices, []);
	const unknown = project(['resume', 'confirm']);
	assert.deepEqual(unknown.responseSlots.choices, ['confirm']);
});

test('a quality card without a binding hash is not executable', () => {
	const card = projectHostInvocation(
		{ runId: RUN_ID, state: 'BLOCKED', pendingInterruptId: INTERRUPT_ID },
		{ pendingInterrupt: { interruptId: INTERRUPT_ID, kind: 'quality_review', request: { allowedActions: ACTIONS } } },
	);
	assert.equal(card.executable, false);
	assert.equal(card.argv, null);
	assert.equal(card.responseDocument, null);
});

test('a quality card with an empty interrupt id is rejected', () => {
	assert.throws(
		() => projectHostInvocation(
			{ runId: RUN_ID, state: 'BLOCKED', pendingInterruptId: INTERRUPT_ID },
			{
				pendingInterrupt: {
					interruptId: '',
					kind: 'quality_review',
					request: { bindingHash: BINDING_HASH, allowedActions: ['confirm'] },
				},
			},
		),
		(error) => error instanceof SdlcError && error.code === 'INVALID_CONTRACT',
	);
});
