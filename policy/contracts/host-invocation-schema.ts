import { z } from 'zod';
import { ARRAY_DRAFT_FIELDS, DRAFT_FIELDS, DRAFT_RESPONSE_KINDS } from './draft-schema.ts';
import {
	HASH_PATTERN,
	assertClosedContract,
	canonicalJson,
	contractOptionalHash,
	failContract,
	validateOpaqueId,
} from './primitives.ts';

export const CONTINUATION_ACTIONS = Object.freeze([
	'authorize',
	'answer',
	'resume',
	'stop',
] as const);

export const CONTINUATION_REASONS = Object.freeze([
	'AUTHORIZATION_REQUIRED',
	'HUMAN_RESPONSE_REQUIRED',
	'INFRASTRUCTURE_RETRY',
	'GIT_APPROVAL',
	'COMPLETE',
	'HALTED',
] as const);

export const ContinuationActionSchema = z.enum(CONTINUATION_ACTIONS);
export type ContinuationAction = z.infer<typeof ContinuationActionSchema>;

export const ContinuationReasonSchema = z.enum(CONTINUATION_REASONS);
export type ContinuationReason = z.infer<typeof ContinuationReasonSchema>;

export const ContinuationRecordSchema = z.object({
	action: ContinuationActionSchema,
	reason: ContinuationReasonSchema,
});
export type ContinuationRecord = z.infer<typeof ContinuationRecordSchema>;

export function validateContinuation(input: unknown): Readonly<ContinuationRecord> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		failContract('continuation must be an object');
	}
	assertClosedContract(input, ['action', 'reason'], 'continuation');
	if (typeof input.action !== 'string' || !(CONTINUATION_ACTIONS as readonly string[]).includes(input.action)) {
		failContract(`Invalid continuation action: ${String(input.action)}`);
	}
	if (typeof input.reason !== 'string' || !(CONTINUATION_REASONS as readonly string[]).includes(input.reason)) {
		failContract(`Invalid continuation reason: ${String(input.reason)}`);
	}
	return Object.freeze({
		action: input.action as ContinuationAction,
		reason: input.reason as ContinuationReason,
	});
}

export const HOST_INVOCATION_KEYS = Object.freeze([
	'schemaVersion',
	'executable',
	'packetConsumed',
	'exitCode',
	'argv',
	'forbiddenFlags',
	'retry',
	'responseDocument',
	'responseSlots',
] as const);

export const HOST_FORBIDDEN_FLAGS = Object.freeze([
	'--create-branch',
	'--create-local-commits',
	'--hitl-tty',
	'--open-pr',
	'--push',
	'--retry',
] as const);

export const HOST_APPROVAL_CHOICES = Object.freeze(['approve', 'revise', 'reject', 'cancel'] as const);

export const HOST_PLAN_CRITIC_CHOICES = Object.freeze([
	'accept_residual',
	'reauthorize',
	'cancel',
] as const);

export const HOST_RECONCILIATION_CHOICES = Object.freeze(['escalate', 'cancel'] as const);

export const HOST_HIGH_RISK_REVIEW_CHOICES = Object.freeze(['approve', 'cancel'] as const);

const HOST_EXIT_CODES = new Set([0, 2, 3, 4]);

const HOST_DOCUMENT_METADATA_KEYS = new Set([
	'responseKind',
	'options',
	'required',
	'choices',
	'targets',
	'valueKind',
	'itemKeys',
	'requiredWhen',
	'minItems',
	'maxItems',
	'operations',
]);

const HOST_REDACTED_KEYS = new Set(['lastError', 'prompt', 'apiKey']);

export const HostInvocationChangeSlotSchema = z.object({
	field: z.literal('changes'),
	requiredWhen: z.literal('revise'),
	minItems: z.number().int(),
	maxItems: z.number().int(),
	itemKeys: z.array(z.string()),
	targets: z.array(
		z.object({
			field: z.string(),
			operations: z.array(z.string()),
			valueKind: z.enum(['text', 'text-list']),
		}),
	),
});
export type HostInvocationChangeSlot = z.infer<typeof HostInvocationChangeSlotSchema>;

export const ResponseQuestionSlotSchema = z.object({
	questionId: z.string(),
	responseKind: z.string(),
	options: z.array(z.string()).readonly(),
	required: z.boolean(),
});
export type ResponseQuestionSlot = z.infer<typeof ResponseQuestionSlotSchema>;

export const ResponseActionSlotSchema = z.object({
	field: z.literal('action'),
	choices: z.array(z.string()).readonly(),
	changes: HostInvocationChangeSlotSchema.optional(),
});
export type ResponseSlot = z.infer<typeof ResponseActionSlotSchema>;

export const HostInvocationRecordSchema = z.object({
	schemaVersion: z.literal('1.0.0'),
	executable: z.boolean(),
	packetConsumed: z.boolean(),
	exitCode: z.number().int(),
	argv: z.array(z.string()).readonly().nullable(),
	forbiddenFlags: z.array(z.string()).readonly(),
	retry: z.object({
		allowed: z.boolean(),
		maxAdditionalInvocations: z.number().int(),
	}),
	responseDocument: z.record(z.string(), z.unknown()).nullable(),
	responseSlots: z
		.union([z.array(ResponseQuestionSlotSchema).readonly(), ResponseActionSlotSchema])
		.nullable(),
});
export type HostInvocationRecord = z.infer<typeof HostInvocationRecordSchema>;

export function hostInvocationChangeSlots(): HostInvocationChangeSlot {
	return {
		field: 'changes',
		requiredWhen: 'revise',
		minItems: 1,
		maxItems: 64,
		itemKeys: ['field', 'operation', 'value'],
		targets: DRAFT_FIELDS.map((field) => ({
			field,
			operations: (ARRAY_DRAFT_FIELDS as readonly string[]).includes(field)
				? ['set', 'append', 'remove']
				: ['set'],
			valueKind: (ARRAY_DRAFT_FIELDS as readonly string[]).includes(field) ? 'text-list' : 'text',
		})),
	};
}

function rejectKeys(value: unknown, banned: ReadonlySet<string>, label: string): void {
	if (!value || typeof value !== 'object') return;
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (banned.has(key)) failContract(`${label} contains '${key}'`);
		rejectKeys(child, banned, label);
	}
}

function sameJson(left: unknown, right: unknown): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

export function validateHostInvocation(input: unknown): HostInvocationRecord {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		failContract('hostInvocation must be an object');
	}
	assertClosedContract(input, HOST_INVOCATION_KEYS, 'hostInvocation');
	for (const key of HOST_INVOCATION_KEYS) {
		if (!Object.hasOwn(input, key)) failContract(`hostInvocation.${key} is required`);
	}
	rejectKeys(input, HOST_REDACTED_KEYS, 'hostInvocation');
	if (input.schemaVersion !== '1.0.0') failContract('hostInvocation.schemaVersion must be 1.0.0');
	if (typeof input.executable !== 'boolean') failContract('hostInvocation.executable must be boolean');
	if (typeof input.packetConsumed !== 'boolean') failContract('hostInvocation.packetConsumed must be boolean');
	if (typeof input.exitCode !== 'number' || !HOST_EXIT_CODES.has(input.exitCode)) {
		failContract('hostInvocation.exitCode is invalid');
	}
	if (!sameJson(input.forbiddenFlags, HOST_FORBIDDEN_FLAGS)) {
		failContract('hostInvocation.forbiddenFlags is invalid');
	}
	const argvExecutable = Array.isArray(input.argv) && input.argv.length > 0;
	if (input.executable !== argvExecutable) {
		failContract('hostInvocation.executable does not match argv');
	}
	if (input.executable) {
		const argv = input.argv as unknown[];
		if (argv.some((item) => typeof item !== 'string' || item.length === 0)) {
			failContract('hostInvocation.argv must contain non-empty strings');
		}
		if (argv.some((item) => typeof item === 'string' && (HOST_FORBIDDEN_FLAGS as readonly string[]).includes(item))) {
			failContract('hostInvocation.argv contains a forbidden flag');
		}
	} else if (input.argv !== null) {
		failContract('hostInvocation.argv must be null when executable is false');
	}
	assertClosedContract(input.retry, ['allowed', 'maxAdditionalInvocations'], 'hostInvocation.retry');
	if (typeof input.retry.allowed !== 'boolean') failContract('hostInvocation.retry.allowed must be boolean');
	const expectedRetries = input.retry.allowed ? 1 : 0;
	if (input.retry.maxAdditionalInvocations !== expectedRetries) {
		failContract('hostInvocation.retry.maxAdditionalInvocations does not match allowed');
	}
	const documentSet = input.responseDocument !== null;
	const slotsSet = input.responseSlots !== null;
	if (documentSet !== slotsSet) {
		failContract('hostInvocation responseDocument and responseSlots must both be null or both be set');
	}
	if (documentSet) validateHostResponse(input.responseDocument, input.responseSlots);
	const validInput: unknown = input;
	return validInput as HostInvocationRecord;
}

function validateHostResponse(document: unknown, slots: unknown): void {
	if (!document || typeof document !== 'object' || Array.isArray(document)) {
		failContract('hostInvocation.responseDocument must be an object');
	}
	const doc = document as Record<string, unknown>;
	rejectKeys(doc, HOST_DOCUMENT_METADATA_KEYS, 'hostInvocation.responseDocument');
	if (doc.schemaVersion !== '1.0.0') {
		failContract('hostInvocation.responseDocument.schemaVersion must be 1.0.0');
	}
	validateOpaqueId(doc.interruptId, 'hostInvocation.responseDocument.interruptId');
	if (typeof doc.stateHash !== 'string' || !HASH_PATTERN.test(doc.stateHash)) {
		failContract('hostInvocation.responseDocument.stateHash is invalid');
	}
	if (Object.hasOwn(doc, 'answers')) {
		assertClosedContract(
			doc,
			['schemaVersion', 'interruptId', 'stateHash', 'answers'],
			'hostInvocation.responseDocument',
		);
		if (!Array.isArray(doc.answers) || !Array.isArray(slots)) {
			failContract('hostInvocation question response must pair answers with slot array');
		}
		if (doc.answers.length !== slots.length) {
			failContract('hostInvocation question answers and slots differ in length');
		}
		doc.answers.forEach((answer, index) => {
			assertClosedContract(answer, ['questionId', 'value'], `hostInvocation.responseDocument.answers[${index}]`);
			if (answer.value !== null) failContract('hostInvocation question value must be null');
			const slot = slots[index];
			assertClosedContract(
				slot,
				['questionId', 'responseKind', 'options', 'required'],
				`hostInvocation.responseSlots[${index}]`,
			);
			if (answer.questionId !== slot.questionId) {
				failContract('hostInvocation question ids must follow batch order');
			}
			validateOpaqueId(answer.questionId, `hostInvocation.answers[${index}].questionId`);
			if (typeof slot.responseKind !== 'string' || !DRAFT_RESPONSE_KINDS.has(slot.responseKind)) {
				failContract('hostInvocation.responseSlots.responseKind is invalid');
			}
			if (!Array.isArray(slot.options) || slot.options.some((item) => typeof item !== 'string')) {
				failContract('hostInvocation.responseSlots.options must be a string array');
			}
			if (typeof slot.required !== 'boolean') {
				failContract('hostInvocation.responseSlots.required must be boolean');
			}
		});
		return;
	}
	if (
		Object.hasOwn(doc, 'approvalHash') ||
		Object.hasOwn(doc, 'draftHash') ||
		Object.hasOwn(doc, 'changes')
	) {
		assertClosedContract(
			doc,
			['schemaVersion', 'interruptId', 'stateHash', 'action', 'approvalHash', 'draftHash', 'changes'],
			'hostInvocation.responseDocument',
		);
		if (doc.action !== null) failContract('hostInvocation approval action must be null');
		contractOptionalHash(doc.approvalHash, 'hostInvocation.responseDocument.approvalHash');
		contractOptionalHash(doc.draftHash, 'hostInvocation.responseDocument.draftHash');
		if (!Array.isArray(doc.changes) || doc.changes.length !== 0) {
			failContract('hostInvocation approval changes must be an empty array');
		}
		const validatedSlots = validateActionSlots(slots, HOST_APPROVAL_CHOICES);
		if (!sameJson(validatedSlots.changes, hostInvocationChangeSlots())) {
			failContract('hostInvocation approval changes slots are invalid');
		}
		return;
	}
	assertClosedContract(
		doc,
		['schemaVersion', 'interruptId', 'stateHash', 'action', 'taskPlanHash'],
		'hostInvocation.responseDocument',
	);
	if (doc.action !== null) failContract('hostInvocation action must be null');
	if (Object.hasOwn(doc, 'taskPlanHash')) {
		contractOptionalHash(doc.taskPlanHash, 'hostInvocation.responseDocument.taskPlanHash');
	}
	if (!slots || typeof slots !== 'object' || Array.isArray(slots)) {
		failContract('hostInvocation.responseSlots must be an object');
	}
	assertClosedContract(slots, ['field', 'choices'], 'hostInvocation.responseSlots');
	if (
		!sameJson(slots.choices, HOST_PLAN_CRITIC_CHOICES) &&
		!sameJson(slots.choices, HOST_RECONCILIATION_CHOICES) &&
		!sameJson(slots.choices, HOST_HIGH_RISK_REVIEW_CHOICES)
	) {
		failContract('hostInvocation action choices are invalid');
	}
	if (slots.field !== 'action') failContract('hostInvocation.responseSlots.field must be action');
}

function validateActionSlots(slots: unknown, choices: readonly string[]): Record<string, unknown> {
	if (!slots || typeof slots !== 'object' || Array.isArray(slots)) {
		failContract('hostInvocation.responseSlots must be an object');
	}
	assertClosedContract(slots, ['field', 'choices', 'changes'], 'hostInvocation.responseSlots');
	if (slots.field !== 'action') failContract('hostInvocation.responseSlots.field must be action');
	if (!sameJson(slots.choices, choices)) failContract('hostInvocation action choices are invalid');
	return slots;
}
