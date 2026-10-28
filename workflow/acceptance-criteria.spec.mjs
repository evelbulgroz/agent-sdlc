import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { emptyDraft } from '../policy/contracts.ts';
import {
	ACCEPTANCE_CRITERIA_GRAMMAR_QUESTION_ID,
	buildAcceptanceCriteriaGrammarQuestion,
	evaluateAcceptanceCriteriaQuality,
	parseAcceptanceCriterion,
} from './acceptance-criteria.ts';
import { applyAnswers, applyPatch, evaluateCompleteness } from './specification.ts';

const GRAMMAR_AC =
	'AC-01: An exact spec is approved. Given a complete grammatical draft and operator approval. Then approvedSpecHash equals the draft hash.';

function completeDraftExcept(overrides = {}) {
	const draft = emptyDraft('Build the workflow');
	const patch = [
		{ field: 'nonGoals', operation: 'set', value: ['No code execution'] },
		{ field: 'owningContext', operation: 'set', value: 'Tooling' },
		{ field: 'touchedSurfaces', operation: 'set', value: ['tools/workflow.mjs'] },
		{ field: 'invariantsAndConstraints', operation: 'set', value: ['Fail closed'] },
		{ field: 'publicContractImpact', operation: 'set', value: 'None' },
		{ field: 'acceptanceCriteria', operation: 'set', value: ['One outcome'] },
		{ field: 'failureDefenses', operation: 'set', value: ['Reject stale answer'] },
		{ field: 'verificationPlan', operation: 'set', value: ['Run tests'] },
	].filter((operation) => !Object.hasOwn(overrides, operation.field));
	for (const [field, value] of Object.entries(overrides)) {
		if (value !== null && value !== undefined && (!Array.isArray(value) || value.length > 0)) {
			patch.push({
				field,
				operation: 'set',
				value,
			});
		}
	}
	return applyPatch(draft, patch);
}

test('@ac AC-02 @case AC-02.1 parseAcceptanceCriterion accepts a grammatical line and rejects AC-1: x.', () => {
	const parsed = parseAcceptanceCriterion(
		'AC-01: An exact spec is approved. Given a complete grammatical draft and operator approval. Then approvedSpecHash equals the draft hash.',
	);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.id, 'AC-01');
	assert.equal(parsed.outcome, 'An exact spec is approved');
	assert.equal(parseAcceptanceCriterion('AC-1: x.').ok, false);
});

test('@ac AC-02 @case AC-02.2 evaluateAcceptanceCriteriaQuality rejects two criteria with the same id', () => {
	const draft = completeDraftExcept({
		acceptanceCriteria: [
			GRAMMAR_AC,
			'AC-01: Duplicate id is rejected. Given two entries share AC-01. Then quality evaluation fails closed.',
		],
	});
	const quality = evaluateAcceptanceCriteriaQuality(draft);
	assert.equal(quality.complete, false);
	assert.ok(quality.errors.some((error) => error.id === 'AC-01'));
});

test('@ac AC-02 @case AC-02.3 buildAcceptanceCriteriaGrammarQuestion uses the grammar question id', () => {
	const question = buildAcceptanceCriteriaGrammarQuestion(completeDraftExcept());
	assert.equal(question.questionId, ACCEPTANCE_CRITERIA_GRAMMAR_QUESTION_ID);
});

test('@ac AC-02 @case AC-02.4 acceptance-criteria.mjs does not import specification.mjs', () => {
	const source = fs.readFileSync(new URL('./acceptance-criteria.ts', import.meta.url), 'utf8');
	assert.equal(source.includes('specification.ts'), false);
	assert.ok(source.includes('export function parseAcceptanceCriterion'));
});

test('parseAcceptanceCriterion accepts AC-NN Given/Then grammar and optional Evidence', () => {
	const parsed = parseAcceptanceCriterion(GRAMMAR_AC);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.id, 'AC-01');
	assert.equal(parsed.outcome, 'An exact spec is approved');
	assert.match(parsed.given, /complete grammatical draft/);
	assert.match(parsed.then, /approvedSpecHash/);
	assert.equal(parsed.evidence, null);
	const withEvidence = parseAcceptanceCriterion(
		`${GRAMMAR_AC} Evidence: unit test in specification.spec.mjs.`,
	);
	assert.equal(withEvidence.ok, true);
	assert.match(withEvidence.evidence, /specification\.spec\.mjs/);
});

test('@ac AC-01 parses ordered oracle cases and rejects malformed, duplicate, and foreign ids', () => {
	const parsed = parseAcceptanceCriterion(
		'AC-01: Incomplete input is rejected. Given either field is empty. Then submission is disabled. Cases: AC-01.1: username empty; AC-01.2: password empty.',
	);
	assert.equal(parsed.ok, true);
	assert.deepEqual(parsed.cases, [
		{ id: 'AC-01.1', description: 'username empty' },
		{ id: 'AC-01.2', description: 'password empty' },
	]);
	for (const criterion of [
		'AC-01: Invalid case fails. Given input. Then output. Cases: malformed.',
		'AC-01: Zero case fails. Given input. Then output. Cases: AC-01.0: zero.',
		'AC-01: Duplicate case fails. Given input. Then output. Cases: AC-01.1: first; AC-01.1: second.',
		'AC-01: Foreign case fails. Given input. Then output. Cases: AC-02.1: foreign.',
	]) {
		assert.equal(parseAcceptanceCriterion(criterion).ok, false);
	}
});

test('parseAcceptanceCriterion rejects nil, empty, invalid, and ambiguous entries', () => {
	assert.equal(parseAcceptanceCriterion('').ok, false);
	assert.equal(parseAcceptanceCriterion('   ').ok, false);
	assert.equal(parseAcceptanceCriterion('Reject bad input').code, 'INVALID_GRAMMAR');
	assert.equal(parseAcceptanceCriterion('AC-1: Too few digits. Given x. Then y.').ok, false);
	assert.equal(
		parseAcceptanceCriterion(
			'AC-01: It works. Given TBD. Then the system rejects the payload.',
		).code,
		'AMBIGUOUS',
	);
	assert.equal(
		parseAcceptanceCriterion('AC-01: Outcome only without given then clauses').ok,
		false,
	);
});

test('@ac AC-05 the domain word "unknown" is not flagged as an ambiguity placeholder', () => {
	const result = parseAcceptanceCriterion(
		'AC-01: An unresolvable lookup is rejected. Given a request for an unknown user ID. Then the service returns 404.',
	);
	assert.equal(result.ok, true);

	const draft = emptyDraft('Build the workflow');
	const unambiguous = applyPatch(draft, [
		{
			field: 'nonGoals',
			operation: 'set',
			value: ['Does not resolve requests for an unknown user ID'],
		},
	]);
	assert.ok(!evaluateCompleteness(unambiguous).ambiguousFields.includes('nonGoals'));
});

test('@case AC-05 an actual unresolved placeholder marker still fails closed', () => {
	assert.equal(
		parseAcceptanceCriterion(
			'AC-01: It works. Given TBD. Then the system rejects the payload.',
		).code,
		'AMBIGUOUS',
	);
	assert.equal(
		parseAcceptanceCriterion(
			'AC-01: It works. Given an unsure input. Then the system rejects the payload.',
		).code,
		'AMBIGUOUS',
	);
	assert.equal(
		parseAcceptanceCriterion(
			'AC-01: It works. Given an input marker of ??. Then the system rejects the payload.',
		).code,
		'AMBIGUOUS',
	);

	const draft = emptyDraft('Build the workflow');
	const ambiguous = applyPatch(draft, [
		{ field: 'nonGoals', operation: 'set', value: ['TBD'] },
	]);
	assert.ok(evaluateCompleteness(ambiguous).ambiguousFields.includes('nonGoals'));
});

test('evaluateAcceptanceCriteriaQuality is independent of evaluateCompleteness', () => {
	const completeUngrammatical = completeDraftExcept();
	assert.equal(evaluateCompleteness(completeUngrammatical).complete, true);
	assert.equal(evaluateAcceptanceCriteriaQuality(completeUngrammatical).complete, false);

	const grammaticalIncomplete = applyPatch(emptyDraft('Build the workflow'), [
		{ field: 'acceptanceCriteria', operation: 'set', value: [GRAMMAR_AC] },
	]);
	assert.equal(evaluateCompleteness(grammaticalIncomplete).complete, false);
	assert.ok(evaluateCompleteness(grammaticalIncomplete).missingFields.includes('nonGoals'));
	assert.equal(evaluateAcceptanceCriteriaQuality(grammaticalIncomplete).complete, true);

	const both = completeDraftExcept({ acceptanceCriteria: [GRAMMAR_AC] });
	assert.equal(evaluateCompleteness(both).complete, true);
	assert.equal(evaluateAcceptanceCriteriaQuality(both).complete, true);

	const neither = emptyDraft('Build the workflow');
	assert.equal(evaluateCompleteness(neither).complete, false);
	assert.equal(evaluateAcceptanceCriteriaQuality(neither).complete, false);
	assert.equal(evaluateAcceptanceCriteriaQuality(neither).errors[0].code, 'EMPTY');
});

test('evaluateAcceptanceCriteriaQuality rejects duplicate ids and reports index', () => {
	const draft = completeDraftExcept({
		acceptanceCriteria: [
			GRAMMAR_AC,
			'AC-01: Duplicate id is rejected. Given two entries share AC-01. Then quality evaluation fails closed.',
		],
	});
	const quality = evaluateAcceptanceCriteriaQuality(draft);
	assert.equal(quality.complete, false);
	assert.equal(quality.errors[0].code, 'DUPLICATE_ID');
	assert.equal(quality.errors[0].id, 'AC-01');
	assert.equal(quality.errors[0].index, 1);
});

test('evaluateAcceptanceCriteriaQuality fails closed on invalid draft input', () => {
	assert.throws(() => evaluateAcceptanceCriteriaQuality(null), /draft/);
	assert.throws(() => evaluateAcceptanceCriteriaQuality(undefined), /draft/);
});

test('grammar question replaces the acceptanceCriteria list instead of appending', () => {
	const draft = completeDraftExcept();
	const question = buildAcceptanceCriteriaGrammarQuestion(draft);
	assert.equal(question.questionId, ACCEPTANCE_CRITERIA_GRAMMAR_QUESTION_ID);
	const replaced = applyAnswers(
		draft,
		{ questions: [question] },
		{
			answers: [
				{
					questionId: ACCEPTANCE_CRITERIA_GRAMMAR_QUESTION_ID,
					value: `${GRAMMAR_AC}\nAC-02: Second criterion is stored. Given a newline-separated answer. Then both ids are unique.`,
				},
			],
		},
	);
	assert.equal(replaced.acceptanceCriteria.length, 2);
	assert.equal(replaced.acceptanceCriteria[0], GRAMMAR_AC);
	assert.equal(evaluateAcceptanceCriteriaQuality(replaced).complete, true);
});
