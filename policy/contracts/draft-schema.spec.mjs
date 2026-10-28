import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyDraft, validateAnswerDocument, validateApprovalResponse, validateDraft, validatePatch, validateQuestionBatch } from './draft-schema.ts';

test('draft and patch validators cover valid, null, empty, duplicate, and unknown input', () => {
	const draft = emptyDraft('Build a durable workflow');
	assert.equal(validateDraft(draft).goal, 'Build a durable workflow');
	assert.throws(() => validateDraft(null), /must be an object/);
	assert.throws(() => emptyDraft(''), /non-empty/);
	assert.throws(
		() => validateDraft({ ...draft, acceptanceCriteria: ['same', 'same'] }),
		/duplicate/,
	);
	assert.throws(
		() => validatePatch([{ field: 'approval', operation: 'set', value: true }]),
		/allowlisted/,
	);
	assert.throws(
		() => validatePatch([{ field: 'goal', operation: 'append', value: 'x' }]),
		/supports only/,
	);
	assert.throws(
		() => validatePatch([{ field: 'owningContext', operation: 'append', value: 'Tooling' }]),
		/not valid/,
	);
	assert.throws(
		() => validatePatch([{ field: 'publicContractImpact', operation: 'set', value: ['None'] }]),
		/non-empty text/,
	);
	assert.throws(
		() => validatePatch([{ field: 'acceptanceCriteria', operation: 'append', value: [true] }]),
		/must contain non-empty text/,
	);
});

test('question and answer contracts reject empty, duplicate, unknown, and stale-shaped data', () => {
	const batch = validateQuestionBatch({
		schemaVersion: '1.0.0',
		questions: [
			{
				questionId: 'q1',
				targets: ['acceptanceCriteria'],
				prompt: 'Outcome?',
				responseKind: 'text',
				options: [],
				required: true,
				rationale: 'Missing.',
			},
		],
	});
	const answer = validateAnswerDocument(
		{
			schemaVersion: '1.0.0',
			interruptId: 'interrupt-1',
			stateHash: 'a'.repeat(64),
			answers: [{ questionId: 'q1', value: 'Approved output exists' }],
		},
		batch,
	);
	assert.equal(answer.answers.length, 1);
	assert.throws(() => validateAnswerDocument({ ...answer, answers: [] }, batch), /omitted/);
	assert.throws(
		() =>
			validateAnswerDocument(
				{ ...answer, answers: [{ questionId: 'unknown', value: 'x' }] },
				batch,
			),
		/Unknown/,
	);
	assert.throws(
		() => validateQuestionBatch({ schemaVersion: '1.0.0', questions: [] }),
		/must contain/,
	);
	assert.throws(
		() =>
			validateQuestionBatch({
				schemaVersion: '1.0.0',
				questions: [{
					questionId: 'q-dup',
					targets: ['goal', 'goal'],
					prompt: 'Outcome?',
					responseKind: 'text',
					options: [],
					required: true,
					rationale: 'Missing.',
				}],
			}),
		/duplicate/,
	);
});

test('approval contracts fail closed', () => {
	assert.throws(
		() =>
			validateApprovalResponse({
				schemaVersion: '1.0.0',
				interruptId: 'approval-1',
				stateHash: 'a'.repeat(64),
				action: 'approve',
				approvalHash: null,
				draftHash: null,
				changes: [],
			}),
		/requires/,
	);
});
