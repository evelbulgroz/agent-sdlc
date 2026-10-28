import { z } from 'zod';
import {
	HASH_PATTERN,
	RUNTIME_SCHEMA_VERSION,
	assertClosedContract,
	contractNonEmptyString,
	contractOptionalHash,
	contractStringArray,
	failContract,
	normalizeText,
	normalizedValue,
	validateOpaqueId,
} from './primitives.ts';

export const DRAFT_FIELDS = Object.freeze([
	'goal',
	'nonGoals',
	'owningContext',
	'touchedSurfaces',
	'invariantsAndConstraints',
	'publicContractImpact',
	'acceptanceCriteria',
	'failureDefenses',
	'verificationPlan',
	'unresolvedQuestions',
	'assumptions',
] as const);

export const ARRAY_DRAFT_FIELDS = Object.freeze([
	'nonGoals',
	'touchedSurfaces',
	'invariantsAndConstraints',
	'acceptanceCriteria',
	'failureDefenses',
	'verificationPlan',
	'unresolvedQuestions',
	'assumptions',
] as const);

export const DRAFT_RESPONSE_KINDS = new Set(['text', 'boolean', 'single_select', 'multi_select']);

const PATCH_OPERATIONS = new Set(['set', 'append', 'remove']);

const APPROVAL_ACTIONS = new Set(['approve', 'revise', 'reject', 'cancel']);

export const DraftFieldSchema = z.enum(DRAFT_FIELDS);
export type DraftField = z.infer<typeof DraftFieldSchema>;

export const SpecDraftSchema = z.object({
	goal: z.string(),
	nonGoals: z.array(z.string()),
	owningContext: z.string(),
	touchedSurfaces: z.array(z.string()),
	invariantsAndConstraints: z.array(z.string()),
	publicContractImpact: z.string(),
	acceptanceCriteria: z.array(z.string()),
	failureDefenses: z.array(z.string()),
	verificationPlan: z.array(z.string()),
	unresolvedQuestions: z.array(z.string()),
	assumptions: z.array(z.string()),
});
export type SpecDraft = z.infer<typeof SpecDraftSchema>;

export const DraftPatchOperationSchema = z.object({
	field: DraftFieldSchema,
	operation: z.enum(['set', 'append', 'remove']),
	value: z.union([z.string(), z.array(z.string())]),
});
export type DraftPatchOperation = z.infer<typeof DraftPatchOperationSchema>;

export const CompletenessEvaluationSchema = z.object({
	complete: z.boolean(),
	missingFields: z.array(DraftFieldSchema),
	ambiguousFields: z.array(DraftFieldSchema),
});
export type CompletenessEvaluation = z.infer<typeof CompletenessEvaluationSchema>;

export const QuestionItemSchema = z.object({
	questionId: z.string(),
	targets: z.array(DraftFieldSchema),
	prompt: z.string(),
	responseKind: z.enum(['text', 'boolean', 'single_select', 'multi_select']),
	options: z.array(z.string()),
	required: z.boolean(),
	rationale: z.string(),
});
export type QuestionItem = z.infer<typeof QuestionItemSchema>;

export const QuestionBatchSchema = z.object({
	schemaVersion: z.literal(RUNTIME_SCHEMA_VERSION),
	questions: z.array(QuestionItemSchema),
});
export type QuestionBatch = z.infer<typeof QuestionBatchSchema>;

export const AnswerItemSchema = z.object({
	questionId: z.string(),
	value: z.unknown(),
});
export type AnswerItem = z.infer<typeof AnswerItemSchema>;

export const AnswerDocumentSchema = z.object({
	schemaVersion: z.literal(RUNTIME_SCHEMA_VERSION),
	interruptId: z.string(),
	stateHash: z.string(),
	answers: z.array(AnswerItemSchema),
});
export type AnswerDocument = z.infer<typeof AnswerDocumentSchema>;

export const ApprovalResponseSchema = z.object({
	schemaVersion: z.literal(RUNTIME_SCHEMA_VERSION),
	interruptId: z.string(),
	stateHash: z.string().nullable(),
	action: z.enum(['approve', 'revise', 'reject', 'cancel']),
	approvalHash: z.string().nullable(),
	draftHash: z.string().nullable(),
	changes: z.array(DraftPatchOperationSchema),
});
export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>;

export function emptyDraft(goal: unknown): Readonly<SpecDraft> {
	return Object.freeze({
		goal: contractNonEmptyString(goal, 'goal'),
		nonGoals: [],
		owningContext: '',
		touchedSurfaces: [],
		invariantsAndConstraints: [],
		publicContractImpact: '',
		acceptanceCriteria: [],
		failureDefenses: [],
		verificationPlan: [],
		unresolvedQuestions: [],
		assumptions: [],
	});
}

export function validateDraft(
	input: unknown,
	{ requireGoal = true }: { requireGoal?: boolean } = {},
): Readonly<SpecDraft> {
	assertClosedContract(input, DRAFT_FIELDS, 'draft');
	const goal =
		requireGoal || Boolean(input.goal)
			? contractNonEmptyString(input.goal, 'draft.goal')
			: normalizeText(typeof input.goal === 'string' ? input.goal : '').trim();
	const nonGoals = contractStringArray(input.nonGoals, 'draft.nonGoals');
	const owningContext =
		typeof input.owningContext === 'string'
			? normalizeText(input.owningContext).trim()
			: failContract('draft.owningContext must be a string');
	const touchedSurfaces = contractStringArray(input.touchedSurfaces, 'draft.touchedSurfaces');
	const invariantsAndConstraints = contractStringArray(
		input.invariantsAndConstraints,
		'draft.invariantsAndConstraints',
	);
	const publicContractImpact =
		typeof input.publicContractImpact === 'string'
			? normalizeText(input.publicContractImpact).trim()
			: failContract('draft.publicContractImpact must be a string');
	const acceptanceCriteria = contractStringArray(input.acceptanceCriteria, 'draft.acceptanceCriteria');
	const failureDefenses = contractStringArray(input.failureDefenses, 'draft.failureDefenses');
	const verificationPlan = contractStringArray(input.verificationPlan, 'draft.verificationPlan');
	const unresolvedQuestions = contractStringArray(input.unresolvedQuestions, 'draft.unresolvedQuestions');
	const assumptions = contractStringArray(input.assumptions, 'draft.assumptions');
	return Object.freeze({
		goal,
		nonGoals,
		owningContext,
		touchedSurfaces,
		invariantsAndConstraints,
		publicContractImpact,
		acceptanceCriteria,
		failureDefenses,
		verificationPlan,
		unresolvedQuestions,
		assumptions,
	});
}

export function validatePatch(input: unknown): readonly Readonly<DraftPatchOperation>[] {
	if (!Array.isArray(input) || input.length > 64) {
		failContract('patch must be an array with at most 64 operations');
	}
	return Object.freeze(
		input.map((operation, index) => {
			assertClosedContract(operation, ['field', 'operation', 'value'], `patch[${index}]`);
			if (typeof operation.field !== 'string' || !(DRAFT_FIELDS as readonly string[]).includes(operation.field)) {
				failContract(`patch[${index}].field is not allowlisted`);
			}
			if (typeof operation.operation !== 'string' || !PATCH_OPERATIONS.has(operation.operation)) {
				failContract(`patch[${index}].operation is invalid`);
			}
			if (operation.field === 'goal' && operation.operation !== 'set') {
				failContract('goal supports only the set operation');
			}
			const arrayField = (ARRAY_DRAFT_FIELDS as readonly string[]).includes(operation.field);
			if (!arrayField && operation.operation !== 'set') {
				failContract(`patch ${operation.operation} is not valid for ${operation.field}`);
			}
			const value = normalizedValue(operation.value);
			if (value === undefined || value === null || value === '') {
				failContract(`patch[${index}].value is empty`);
			}
			if (arrayField) {
				const values = Array.isArray(value) ? value : [value];
				if (
					values.length === 0 ||
					values.some((item) => typeof item !== 'string' || item.trim().length === 0)
				) {
					failContract(`patch[${index}].value must contain non-empty text`);
				}
			} else if (typeof value !== 'string' || value.trim().length === 0) {
				failContract(`patch[${index}].value must be non-empty text for ${operation.field}`);
			}
			return Object.freeze({
				field: operation.field as DraftField,
				operation: operation.operation as DraftPatchOperation['operation'],
				value: value as string | string[],
			});
		}),
	);
}

export function validateCompleteness(input: unknown): Readonly<CompletenessEvaluation> {
	assertClosedContract(input, ['complete', 'missingFields', 'ambiguousFields'], 'completeness');
	if (typeof input.complete !== 'boolean') failContract('completeness.complete must be boolean');
	const missingFields = contractStringArray(input.missingFields, 'completeness.missingFields');
	const ambiguousFields = contractStringArray(input.ambiguousFields, 'completeness.ambiguousFields');
	for (const field of [...missingFields, ...ambiguousFields]) {
		if (!(DRAFT_FIELDS as readonly string[]).includes(field)) {
			failContract(`Unknown completeness field '${field}'`);
		}
	}
	if (input.complete && (missingFields.length > 0 || ambiguousFields.length > 0)) {
		failContract('A complete result cannot contain missing or ambiguous fields');
	}
	return Object.freeze({
		complete: input.complete,
		missingFields: missingFields as DraftField[],
		ambiguousFields: ambiguousFields as DraftField[],
	});
}

export function validateQuestionBatch(
	input: unknown,
	{ maxQuestions = 5, allowEmpty = false }: { maxQuestions?: number; allowEmpty?: boolean } = {},
): Readonly<QuestionBatch> {
	assertClosedContract(input, ['schemaVersion', 'questions'], 'questionBatch');
	if (input.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
		failContract('Unsupported question batch schemaVersion');
	}
	if (
		!Array.isArray(input.questions) ||
		(!allowEmpty && input.questions.length === 0) ||
		input.questions.length > maxQuestions
	) {
		failContract(`questionBatch.questions must contain ${allowEmpty ? '0' : '1'}-${maxQuestions} questions`);
	}
	const ids = new Set<string>();
	const questions = input.questions.map((question, index) => {
		assertClosedContract(
			question,
			['questionId', 'targets', 'prompt', 'responseKind', 'options', 'required', 'rationale'],
			`question[${index}]`,
		);
		const questionId = validateOpaqueId(question.questionId, `question[${index}].questionId`);
		if (ids.has(questionId)) failContract(`Duplicate questionId '${questionId}'`);
		ids.add(questionId);
		const targets = contractStringArray(question.targets, `question[${index}].targets`, {
			allowEmpty: false,
			maxItems: DRAFT_FIELDS.length,
		});
		for (const target of targets) {
			if (!(DRAFT_FIELDS as readonly string[]).includes(target)) {
				failContract(`Question target '${target}' is not allowlisted`);
			}
		}
		if (typeof question.responseKind !== 'string' || !DRAFT_RESPONSE_KINDS.has(question.responseKind)) {
			failContract('Question responseKind is invalid');
		}
		const options = contractStringArray(question.options, `question[${index}].options`);
		if (['single_select', 'multi_select'].includes(question.responseKind) && options.length === 0) {
			failContract('Select questions require options');
		}
		if (!['single_select', 'multi_select'].includes(question.responseKind) && options.length > 0) {
			failContract('Only select questions may define options');
		}
		if (typeof question.required !== 'boolean') failContract('Question required must be boolean');
		return Object.freeze({
			questionId,
			targets: targets as DraftField[],
			prompt: contractNonEmptyString(question.prompt, `question[${index}].prompt`, 8_192),
			responseKind: question.responseKind as QuestionItem['responseKind'],
			options,
			required: question.required,
			rationale: contractNonEmptyString(question.rationale, `question[${index}].rationale`, 8_192),
		});
	});
	return Object.freeze({
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		questions: [...questions],
	});
}

export function validateAnswerDocument(
	input: unknown,
	questionBatch: Readonly<QuestionBatch>,
): Readonly<AnswerDocument> {
	assertClosedContract(input, ['schemaVersion', 'interruptId', 'stateHash', 'answers'], 'answer');
	if (input.schemaVersion !== RUNTIME_SCHEMA_VERSION) failContract('Unsupported answer schemaVersion');
	const interruptId = validateOpaqueId(input.interruptId, 'answer.interruptId');
	if (typeof input.stateHash !== 'string' || !HASH_PATTERN.test(input.stateHash)) {
		failContract('answer.stateHash is invalid');
	}
	if (!Array.isArray(input.answers)) failContract('answer.answers must be an array');
	const questionById = new Map(
		questionBatch.questions.map((question) => [question.questionId, question]),
	);
	const seen = new Set<string>();
	const answers = input.answers.map((answer, index) => {
		assertClosedContract(answer, ['questionId', 'value'], `answer.answers[${index}]`);
		const questionId = validateOpaqueId(answer.questionId, `answer.answers[${index}].questionId`);
		if (seen.has(questionId)) failContract(`Duplicate answer for '${questionId}'`);
		seen.add(questionId);
		const question = questionById.get(questionId);
		if (!question) failContract(`Unknown questionId '${questionId}'`);
		validateAnswerValue(answer.value, question);
		return Object.freeze({ questionId, value: normalizedValue(answer.value) });
	});
	for (const question of questionBatch.questions) {
		if (question.required && !seen.has(question.questionId)) {
			failContract(`Required question '${question.questionId}' was omitted`);
		}
	}
	return Object.freeze({
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		interruptId,
		stateHash: input.stateHash,
		answers: [...answers],
	});
}

function validateAnswerValue(value: unknown, question: QuestionItem): void {
	if (question.responseKind === 'text') {
		contractNonEmptyString(value, `answer.${question.questionId}`, 16_384);
		return;
	}
	if (question.responseKind === 'boolean') {
		if (typeof value !== 'boolean') failContract(`answer.${question.questionId} must be boolean`);
		return;
	}
	if (question.responseKind === 'single_select') {
		if (typeof value !== 'string' || !question.options.includes(value)) {
			failContract(`answer.${question.questionId} must be one configured option`);
		}
		return;
	}
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		new Set(value).size !== value.length ||
		value.some((item) => typeof item !== 'string' || !question.options.includes(item))
	) {
		failContract(`answer.${question.questionId} must be a non-empty unique option array`);
	}
}

export function validateApprovalResponse(input: unknown): Readonly<ApprovalResponse> {
	assertClosedContract(
		input,
		['schemaVersion', 'interruptId', 'stateHash', 'action', 'approvalHash', 'draftHash', 'changes'],
		'approvalResponse',
	);
	if (input.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
		failContract('Unsupported approval response schemaVersion');
	}
	if (typeof input.action !== 'string' || !APPROVAL_ACTIONS.has(input.action)) {
		failContract('approvalResponse.action is invalid');
	}
	const result: ApprovalResponse = {
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		interruptId: validateOpaqueId(input.interruptId, 'approvalResponse.interruptId'),
		stateHash: contractOptionalHash(input.stateHash, 'approvalResponse.stateHash'),
		action: input.action as ApprovalResponse['action'],
		approvalHash: contractOptionalHash(input.approvalHash ?? null, 'approvalResponse.approvalHash'),
		draftHash: contractOptionalHash(input.draftHash ?? null, 'approvalResponse.draftHash'),
		changes: [...validatePatch(input.changes ?? [])],
	};
	if (input.action === 'approve' && (!result.approvalHash || !result.draftHash)) {
		failContract('Approval requires approvalHash and draftHash');
	}
	if (input.action === 'revise' && result.changes.length === 0) {
		failContract('Revision requires at least one change');
	}
	return Object.freeze(result);
}

export type SpecificationDraft = SpecDraft;

