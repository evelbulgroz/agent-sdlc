// Acceptance-criteria grammar, parser, and grammar question.

import { type QuestionItem, validateDraft } from '../policy/contracts.ts';

export const AMBIGUOUS = /(?:\bTBD\b|\bunsure\b|\?{2,})/i;

export const ACCEPTANCE_CRITERIA_GRAMMAR_QUESTION_ID = 'acceptance-criteria-grammar';

const AC_GRAMMAR =
	/^AC-(\d{2,}):\s*(.+?)\.\s*Given\s+(.+?)\.\s*Then\s+(.+?)\.(?:\s*Cases:\s*(.+?)\.)?(?:\s*Evidence:\s*(.+?))?\s*$/is;

const AC_CASE_GRAMMAR = /^(AC-\d{2,}\.[1-9]\d*):\s*(.+)$/;

export type AcceptanceCriterionErrorCode =
	| 'EMPTY'
	| 'INVALID_GRAMMAR'
	| 'AMBIGUOUS'
	| 'INVALID_CASE'
	| 'DUPLICATE_CASE'
	| 'DUPLICATE_ID';

export interface AcceptanceCriterionCase {
	readonly id: string;
	readonly description: string;
}

export interface ParsedAcceptanceCriterionFailure {
	readonly ok: false;
	readonly code: Exclude<AcceptanceCriterionErrorCode, 'DUPLICATE_ID'>;
	readonly index: number;
	readonly id: string | null;
	readonly message: string;
}

export interface ParsedAcceptanceCriterionSuccess {
	readonly ok: true;
	readonly code: null;
	readonly index: number;
	readonly id: string;
	readonly outcome: string;
	readonly given: string;
	readonly then: string;
	readonly cases: readonly Readonly<AcceptanceCriterionCase>[];
	readonly evidence: string | null;
	readonly message: null;
}

export type ParsedAcceptanceCriterion =
	| ParsedAcceptanceCriterionFailure
	| ParsedAcceptanceCriterionSuccess;

export interface AcceptanceCriterionError {
	readonly code: AcceptanceCriterionErrorCode;
	readonly index: number;
	readonly id: string | null;
	readonly message: string;
}

export interface AcceptanceCriteriaQuality {
	readonly complete: boolean;
	readonly errors: readonly Readonly<AcceptanceCriterionError>[];
	readonly parsed: readonly Readonly<ParsedAcceptanceCriterionSuccess>[];
}

export function parseAcceptanceCriterion(
	text: unknown,
	index = 0,
): Readonly<ParsedAcceptanceCriterion> {
	if (typeof text !== 'string' || text.trim().length === 0) {
		return Object.freeze({
			ok: false,
			code: 'EMPTY',
			index,
			id: null,
			message: `acceptanceCriteria[${index}] is empty`,
		});
	}
	const trimmed = text.trim();
	const match = trimmed.match(AC_GRAMMAR);
	if (!match) {
		return Object.freeze({
			ok: false,
			code: 'INVALID_GRAMMAR',
			index,
			id: null,
			message: `acceptanceCriteria[${index}] must match 'AC-NN: <outcome>. Given <input>. Then <result>.'`,
		});
	}
	const id = `AC-${match[1] ?? ''}`;
	const outcome = (match[2] ?? '').trim();
	const given = (match[3] ?? '').trim();
	const then = (match[4] ?? '').trim();
	const casesText = match[5] ? match[5].trim() : '';
	const evidence = match[6] ? match[6].trim() : '';
	if (!outcome || !given || !then) {
		return Object.freeze({
			ok: false,
			code: 'INVALID_GRAMMAR',
			index,
			id,
			message: `acceptanceCriteria[${index}] (${id}) is missing outcome, Given, or Then`,
		});
	}
	const ambiguousPart = [outcome, given, then, casesText, evidence, trimmed].find((part) =>
		AMBIGUOUS.test(part),
	);
	if (ambiguousPart) {
		return Object.freeze({
			ok: false,
			code: 'AMBIGUOUS',
			index,
			id,
			message: `acceptanceCriteria[${index}] (${id}) contains an ambiguous token`,
		});
	}
	const cases: Readonly<AcceptanceCriterionCase>[] = [];
	const seenCases = new Set<string>();
	for (const rawCase of casesText ? casesText.split(';') : []) {
		const caseMatch = rawCase.trim().match(AC_CASE_GRAMMAR);
		const caseId = caseMatch?.[1];
		const caseDesc = caseMatch?.[2];
		if (!caseMatch || !caseId || !caseDesc || !caseId.startsWith(`${id}.`)) {
			return Object.freeze({
				ok: false,
				code: 'INVALID_CASE',
				index,
				id,
				message: `acceptanceCriteria[${index}] (${id}) has a malformed or foreign oracle case`,
			});
		}
		if (seenCases.has(caseId)) {
			return Object.freeze({
				ok: false,
				code: 'DUPLICATE_CASE',
				index,
				id,
				message: `acceptanceCriteria[${index}] (${id}) reuses oracle case ${caseId}`,
			});
		}
		seenCases.add(caseId);
		cases.push(
			Object.freeze({
				id: caseId,
				description: caseDesc.trim(),
			}),
		);
	}
	return Object.freeze({
		ok: true,
		code: null,
		index,
		id,
		outcome,
		given,
		then,
		cases: Object.freeze(cases),
		evidence: evidence || null,
		message: null,
	});
}

export function evaluateAcceptanceCriteriaQuality(
	draftInput: unknown,
): Readonly<AcceptanceCriteriaQuality> {
	const draft = validateDraft(draftInput);
	const parsed: Readonly<ParsedAcceptanceCriterionSuccess>[] = [];
	const errors: Readonly<AcceptanceCriterionError>[] = [];
	if (draft.acceptanceCriteria.length === 0) {
		errors.push(
			Object.freeze({
				code: 'EMPTY',
				index: -1,
				id: null,
				message: 'acceptanceCriteria is empty',
			}),
		);
		return freezeAcQuality({ complete: false, errors, parsed });
	}
	const seen = new Map<string, number>();
	draft.acceptanceCriteria.forEach((entry, index) => {
		const result = parseAcceptanceCriterion(entry, index);
		if (!result.ok) {
			errors.push(
				Object.freeze({
					code: result.code,
					index,
					id: result.id,
					message: result.message,
				}),
			);
			return;
		}
		const previous = seen.get(result.id);
		if (previous !== undefined) {
			errors.push(
				Object.freeze({
					code: 'DUPLICATE_ID',
					index,
					id: result.id,
					message: `acceptanceCriteria[${index}] reuses ${result.id} from index ${previous}`,
				}),
			);
			return;
		}
		seen.set(result.id, index);
		parsed.push(result);
	});
	return freezeAcQuality({ complete: errors.length === 0, errors, parsed });
}

function freezeAcQuality({
	complete,
	errors,
	parsed,
}: {
	complete: boolean;
	errors: readonly Readonly<AcceptanceCriterionError>[];
	parsed: readonly Readonly<ParsedAcceptanceCriterionSuccess>[];
}): Readonly<AcceptanceCriteriaQuality> {
	return Object.freeze({
		complete,
		errors: Object.freeze(errors.map((error) => Object.freeze(error))),
		parsed: Object.freeze(parsed),
	});
}

export function buildAcceptanceCriteriaGrammarQuestion(
	draftInput: unknown,
	qualityInput?: AcceptanceCriteriaQuality,
): Readonly<QuestionItem> {
	const draft = validateDraft(draftInput);
	const quality = qualityInput ?? evaluateAcceptanceCriteriaQuality(draft);
	const errorLines =
		quality.errors.length > 0
			? quality.errors.map((error) => `- ${error.message}`).join('\n')
			: '- acceptanceCriteria must use AC-NN Given/Then grammar';
	const current =
		draft.acceptanceCriteria.length > 0
			? draft.acceptanceCriteria.map((entry, index) => `${index + 1}. ${entry}`).join('\n')
			: '(none)';
	return Object.freeze({
		questionId: ACCEPTANCE_CRITERIA_GRAMMAR_QUESTION_ID,
		targets: ['acceptanceCriteria' as const],
		prompt: [
			'Rewrite every acceptance criterion using this grammar (one criterion per line):',
			'AC-NN: <observable outcome>. Given <precondition or input>. Then <observable result>.',
			'This answer replaces the current list.',
			'',
			'Problems:',
			errorLines,
			'',
			'Current acceptance criteria:',
			current,
		].join('\n'),
		responseKind: 'text',
		options: [],
		required: true,
		rationale:
			'Production specification approval requires unique AC-NN identifiers and Given/Then examples.',
	});
}
