import {
	ARRAY_DRAFT_FIELDS,
	type AnswerDocument,
	type CompletenessEvaluation,
	DRAFT_FIELDS,
	type DraftField,
	type QuestionBatch,
	type QuestionItem,
	RUNTIME_SCHEMA_VERSION,
	type SpecDraft,
	type TaskManifest,
	emptyDraft,
	sha256,
	validateCompleteness,
	validateDraft,
	validatePatch,
	validateTaskManifest,
} from '../policy/contracts.ts';
import { assertProjectionSafe } from '../persistence/artifacts.ts';
import { SdlcError } from '../policy/errors.ts';
import {
	ACCEPTANCE_CRITERIA_GRAMMAR_QUESTION_ID,
	AMBIGUOUS,
} from './acceptance-criteria.ts';

type ArrayDraftField = (typeof ARRAY_DRAFT_FIELDS)[number];
type ScalarDraftField = Exclude<DraftField, ArrayDraftField>;

function isArrayDraftField(field: DraftField): field is ArrayDraftField {
	return (ARRAY_DRAFT_FIELDS as readonly string[]).includes(field);
}

const REQUIRED_FIELDS: readonly DraftField[] = [
	'goal',
	'owningContext',
	'touchedSurfaces',
	'acceptanceCriteria',
	'invariantsAndConstraints',
	'nonGoals',
	'publicContractImpact',
	'failureDefenses',
	'verificationPlan',
];

/** Lowercased `##` heading → canonical display name used in error messages. */
const MARKDOWN_HEADING_ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({
	goal: 'Goal',
	'non-goals': 'Non-goals',
	'non goals': 'Non-goals',
	'owning context': 'Owning context',
	'touched surfaces': 'Touched surfaces',
	'invariants and constraints': 'Invariants and constraints',
	'invariants & constraints': 'Invariants and constraints',
	'public contract impact': 'Public contract impact',
	'acceptance criteria': 'Acceptance criteria',
	'failure defenses': 'Failure defenses',
	'verification plan': 'Verification plan',
	'unresolved questions': 'Unresolved questions',
	assumptions: 'Assumptions',
});
const ALLOWED_MARKDOWN_HEADING_NAMES = Object.freeze([
	...new Set(Object.values(MARKDOWN_HEADING_ALLOWLIST)),
]);
const MARKDOWN_HEADING_ALIASES = Object.freeze(['Non goals', 'Invariants & constraints']);

export interface SpecificationProposalInput {
	readonly patch: unknown;
	readonly questions: readonly QuestionItem[];
}

export interface CreateApprovalBindingOptions {
	readonly runId: string;
	readonly draftHash: string;
	readonly runtimeRevision: number | string;
	readonly workflowHash: string;
	readonly roleHash: string | null;
	readonly promptPolicyHash: string;
	readonly completenessResultHash: string;
	readonly timestamp: string;
	readonly method?: string;
}

export interface ApprovalBinding extends Required<CreateApprovalBindingOptions> {
	readonly schemaVersion: typeof RUNTIME_SCHEMA_VERSION;
	readonly approvalHash: string;
}

export function evaluateCompleteness(draftInput: unknown): Readonly<CompletenessEvaluation> {
	const draft = validateDraft(draftInput);
	const missingFields: DraftField[] = [];
	const ambiguousFields: DraftField[] = [];
	for (const field of REQUIRED_FIELDS) {
		const value = draft[field];
		if ((Array.isArray(value) && value.length === 0) || (!Array.isArray(value) && !value)) {
			missingFields.push(field);
			continue;
		}
		const values = Array.isArray(value) ? value : [value];
		if (values.some((item) => AMBIGUOUS.test(item))) ambiguousFields.push(field);
	}
	if (draft.unresolvedQuestions.length > 0) ambiguousFields.push('unresolvedQuestions');
	return validateCompleteness({
		complete: missingFields.length === 0 && ambiguousFields.length === 0,
		missingFields,
		ambiguousFields: [...new Set(ambiguousFields)],
	});
}

export function applyPatch(draftInput: unknown, patchInput: unknown): Readonly<SpecDraft> {
	const draft: SpecDraft = structuredClone(validateDraft(draftInput));
	const patch = validatePatch(patchInput);
	for (const operation of patch) {
		const field = operation.field;
		if (operation.operation === 'set') {
			if (isArrayDraftField(field)) {
				const values = Array.isArray(operation.value) ? operation.value : [operation.value];
				draft[field] = normalizedStringValues(values, field);
			} else {
				if (typeof operation.value !== 'string') {
					throw new SdlcError(
						'INVALID_CONTRACT',
						`Patch value for '${field}' must be text`,
					);
				}
				const scalarField: ScalarDraftField = field;
				draft[scalarField] = operation.value;
			}
		} else if (operation.operation === 'append') {
			if (!isArrayDraftField(field)) {
				throw new SdlcError('INVALID_CONTRACT', `Append is not valid for '${field}'`);
			}
			const current = draft[field];
			const values = Array.isArray(operation.value) ? operation.value : [operation.value];
			draft[field] = [...current, ...normalizedStringValues(values, field)];
		} else {
			if (!isArrayDraftField(field)) {
				throw new SdlcError('INVALID_CONTRACT', `Remove is not valid for '${field}'`);
			}
			const current = draft[field];
			const values = Array.isArray(operation.value) ? operation.value : [operation.value];
			draft[field] = current.filter((item) => !values.includes(item));
		}
	}
	return validateDraft(draft);
}

function normalizedStringValues(values: readonly unknown[], field: string): string[] {
	const result: string[] = [];
	for (const value of values) {
		if (typeof value !== 'string' || value.trim().length === 0) {
			throw new SdlcError('INVALID_CONTRACT', `Patch values for '${field}' must be non-empty text`);
		}
		result.push(value.trim());
	}
	return result;
}

export function applyAnswers(
	draftInput: unknown,
	questionBatch: Readonly<QuestionBatch>,
	answerDocument: Readonly<AnswerDocument>,
): Readonly<SpecDraft> {
	const operations: Array<{
		field: DraftField;
		operation: 'set' | 'append';
		value: unknown;
	}> = [];
	const questions = new Map(
		questionBatch.questions.map((question) => [question.questionId, question]),
	);
	for (const answer of answerDocument.answers) {
		const question = questions.get(answer.questionId);
		if (!question) {
			throw new SdlcError('INVALID_CONTRACT', `Unknown questionId '${answer.questionId}'`);
		}
		const replaceArray =
			question.questionId === ACCEPTANCE_CRITERIA_GRAMMAR_QUESTION_ID;
		for (const target of question.targets) {
			let value: unknown =
				typeof answer.value === 'boolean' ? (answer.value ? 'Yes' : 'No') : answer.value;
			if (
				isArrayDraftField(target) &&
				typeof value === 'string' &&
				(replaceArray || value.includes('\n'))
			) {
				value = value
					.split('\n')
					.map((line) => line.trim())
					.filter((line) => line.length > 0);
			}
			operations.push({
				field: target,
				operation: replaceArray || !isArrayDraftField(target) ? 'set' : 'append',
				value,
			});
		}
	}
	return applyPatch(draftInput, operations);
}

export function validateProposalCompatibility(
	draftInput: unknown,
	proposal: SpecificationProposalInput,
): Readonly<{ revisedDraft: Readonly<SpecDraft>; completeness: Readonly<CompletenessEvaluation> }> {
	const draft = validateDraft(draftInput);
	const revised = applyPatch(draft, proposal.patch);
	const completeness = evaluateCompleteness(revised);
	const draftCompleteness = evaluateCompleteness(draft);
	const unresolvedInDraft = new Set<string>([
		...draftCompleteness.missingFields,
		...draftCompleteness.ambiguousFields,
	]);
	for (const question of proposal.questions) {
		for (const target of question.targets) {
			if (!unresolvedInDraft.has(target)) {
				throw new SdlcError(
					'MODEL_OUTPUT_INVALID',
					`Question '${question.questionId}' targets resolved field '${target}'`,
				);
			}
			if (question.responseKind === 'multi_select' && !isArrayDraftField(target)) {
				throw new SdlcError(
					'MODEL_OUTPUT_INVALID',
					`Question '${question.questionId}' responseKind is incompatible with '${target}'`,
				);
			}
		}
	}
	return Object.freeze({ revisedDraft: revised, completeness });
}

export function renderSpecification(draftInput: unknown): string {
	const draft = validateDraft(draftInput);
	const sections = [
		'# Intent',
		'',
		'## Goal',
		'',
		draft.goal,
		'',
		'## Non-goals',
		'',
		renderList(draft.nonGoals),
		'',
		'## Owning context',
		'',
		draft.owningContext || '_Unresolved_',
		'',
		'## Touched surfaces',
		'',
		renderList(draft.touchedSurfaces),
		'',
		'## Invariants and constraints',
		'',
		renderList(draft.invariantsAndConstraints),
		'',
		'## Public contract impact',
		'',
		draft.publicContractImpact || '_Unresolved_',
		'',
		'## Acceptance criteria',
		'',
		renderNumbered(draft.acceptanceCriteria),
		'',
		'## Failure defenses',
		'',
		renderList(draft.failureDefenses),
		'',
		'## Verification plan',
		'',
		renderList(draft.verificationPlan),
		'',
		'## Unresolved questions',
		'',
		renderList(draft.unresolvedQuestions, '_None_'),
		'',
		'## Assumptions',
		'',
		renderList(draft.assumptions, '_None_'),
		'',
	].join('\n');
	return assertProjectionSafe(sections);
}

function renderList(values: readonly string[], empty = '_Unresolved_'): string {
	return values.length > 0 ? values.map((value) => `- ${value}`).join('\n') : empty;
}

function renderNumbered(values: readonly string[]): string {
	return values.length > 0
		? values.map((value, index) => `${index + 1}. ${value}`).join('\n')
		: '_Unresolved_';
}

export function parseSpecification(text: unknown): Readonly<SpecDraft> {
	if (typeof text !== 'string') {
		throw new SdlcError('INVALID_INPUT', 'Specification input must be text');
	}
	const trimmed = text.trim();
	if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			return validateDraft(parsed);
		} catch (error: unknown) {
			if (error instanceof SdlcError) throw error;
		}
	}

	const headingPattern = /^##\s+([^\n]+)$/gm;
	const matches = [...trimmed.matchAll(headingPattern)];
	if (matches.length === 0) {
		return emptyDraft(trimmed);
	}

	const sections = new Map<string, string>();
	const unknownHeadings: string[] = [];
	for (let i = 0; i < matches.length; i++) {
		const match = matches[i];
		if (!match) continue;
		const headerRaw = (match[1] ?? '').trim();
		const header = headerRaw.toLowerCase();
		if (!Object.hasOwn(MARKDOWN_HEADING_ALLOWLIST, header)) {
			if (!unknownHeadings.includes(headerRaw)) unknownHeadings.push(headerRaw);
		}
		const startIdx = (match.index ?? 0) + match[0].length;
		const nextMatch = matches[i + 1];
		const endIdx = nextMatch ? (nextMatch.index ?? trimmed.length) : trimmed.length;
		const content = trimmed.slice(startIdx, endIdx).trim();
		sections.set(header, content);
	}
	if (unknownHeadings.length > 0) {
		throw new SdlcError(
			'INVALID_INPUT',
			`Specification contains unknown ## heading(s): ${unknownHeadings
				.map((heading) => `'${heading}'`)
				.join(', ')}. Allowed headings: ${ALLOWED_MARKDOWN_HEADING_NAMES.join(
				', ',
			)}. Aliases: ${MARKDOWN_HEADING_ALIASES.join('; ')}.`,
		);
	}

	const parseList = (content: string | undefined): string[] => {
		if (!content || content === '_Unresolved_' || content === '_None_') return [];
		return content
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => line.replace(/^[-*]\s+|\d+\.\s+/, '').trim())
			.filter((line) => line.length > 0 && line !== '_Unresolved_' && line !== '_None_');
	};

	const parseScalar = (content: string | undefined): string => {
		if (!content || content === '_Unresolved_' || content === '_None_') return '';
		return content;
	};

	const draft = {
		goal: parseScalar(sections.get('goal')) || trimmed,
		nonGoals: parseList(sections.get('non-goals') ?? sections.get('non goals')),
		owningContext: parseScalar(sections.get('owning context')),
		touchedSurfaces: parseList(sections.get('touched surfaces')),
		invariantsAndConstraints: parseList(
			sections.get('invariants and constraints') ?? sections.get('invariants & constraints'),
		),
		publicContractImpact: parseScalar(sections.get('public contract impact')),
		acceptanceCriteria: parseList(sections.get('acceptance criteria')),
		failureDefenses: parseList(sections.get('failure defenses')),
		verificationPlan: parseList(sections.get('verification plan')),
		unresolvedQuestions: parseList(sections.get('unresolved questions')),
		assumptions: parseList(sections.get('assumptions')),
	};

	return validateDraft(draft);
}

export function specificationHash(draft: unknown): string {
	return sha256(validateDraft(draft));
}

export function approvedInputHash(draft: unknown, manifestHash: unknown = null): string {
	const draftHash = specificationHash(draft);
	if (manifestHash === null) return draftHash;
	if (typeof manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(manifestHash)) {
		throw new SdlcError('INVALID_CONTRACT', 'taskManifestHash must be a SHA-256 hash');
	}
	return sha256({ draft: validateDraft(draft), taskManifestHash: manifestHash });
}

export function parseTaskManifest(text: unknown): Readonly<TaskManifest> {
	if (typeof text !== 'string' || text.trim().length === 0) {
		throw new SdlcError('INVALID_INPUT', 'Task manifest input must be non-empty JSON text');
	}
	try {
		return validateTaskManifest(JSON.parse(text));
	} catch (error: unknown) {
		if (error instanceof SdlcError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new SdlcError('INVALID_INPUT', `Task manifest must be valid JSON: ${message}`, {}, {
			cause: error,
		});
	}
}

export function taskManifestHash(manifest: unknown): string {
	return sha256(validateTaskManifest(manifest));
}

export function completenessHash(completeness: unknown): string {
	return sha256(validateCompleteness(completeness));
}

export function createApprovalBinding({
	runId,
	draftHash,
	runtimeRevision,
	workflowHash,
	roleHash,
	promptPolicyHash,
	completenessResultHash,
	timestamp,
	method = 'local-hitl',
}: CreateApprovalBindingOptions): Readonly<ApprovalBinding> {
	const binding = Object.freeze({
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		runId,
		draftHash,
		runtimeRevision,
		workflowHash,
		roleHash,
		promptPolicyHash,
		completenessResultHash,
		timestamp,
		method,
	});
	return Object.freeze({ ...binding, approvalHash: sha256(binding) });
}

export function assertDraftFields(fields: readonly string[]): void {
	for (const field of fields) {
		if (!(DRAFT_FIELDS as readonly string[]).includes(field)) {
			throw new SdlcError('INVALID_CONTRACT', `Unknown draft field '${field}'`);
		}
	}
}
