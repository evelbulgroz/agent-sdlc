import { z } from 'zod';
import { CompletenessEvaluationSchema, validateCompleteness } from './draft-schema.ts';
import {
	GIT_SHA,
	HASH_PATTERN,
	RUNTIME_SCHEMA_VERSION,
	assertClosedContract,
	assertContractObject,
	contractOptionalHash,
	failContract,
	sha256,
	validateOpaqueId,
	validateRunId,
} from './primitives.ts';

export { RUNTIME_SCHEMA_VERSION };

export const STORE_SCHEMA_VERSION = 13;

export const RUNTIME_STATES = Object.freeze([
	'INITIALIZING',
	'SPEC_DRAFTING',
	'REVIEWING_SPEC',
	'WAITING_FOR_ANSWERS',
	'WAITING_FOR_APPROVAL',
	'SPEC_APPROVED',
	'SPEC_REJECTED',
	'WAITING_FOR_AUTHORIZATION',
	'PLANNING_TASKS',
	'EVALUATING_POLICY',
	'REVIEWING_PLAN',
	'WAITING_FOR_PLAN_ACCEPTANCE',
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
	'DONE',
	'READY_FOR_GIT_APPROVAL',
	'BLOCKED',
	'BUDGET_EXHAUSTED',
	'ESCALATED',
	'CANCELLED',
	'FAILED',
] as const);

export const EVENT_TYPES = Object.freeze([
	'RUN_INITIALIZED',
	'DRAFT_CREATED',
	'COMPLETENESS_EVALUATED',
	'MODEL_OPERATION_REQUESTED',
	'MODEL_OPERATION_COMPLETED',
	'QUESTIONS_PRESENTED',
	'ANSWERS_ACCEPTED',
	'DRAFT_REVISED',
	'APPROVAL_REQUESTED',
	'SPEC_APPROVED',
	'SPEC_REJECTED',
	'AUTHORIZATION_REQUESTED',
	'RUN_AUTHORIZED',
	'WORKTREE_PREPARED',
	'WORKTREE_HYDRATED',
	'TOOL_EXECUTION_REQUESTED',
	'TOOL_EXECUTION_COMPLETED',
	'IMPLEMENTATION_COMPLETED',
	'HIGH_RISK_REVIEW_REQUESTED',
	'HIGH_RISK_REVIEW_APPROVED',
	'GENERATION_MATERIALIZED',
	'REVIEW_EVALUATED',
	'VERIFICATION_PASSED',
	'VERIFICATION_FAILED',
	'AC_COVERAGE_PASSED',
	'AC_COVERAGE_FAILED',
	'REPAIR_STARTED',
	'REPAIR_COMPLETED',
	'GIT_BRANCH_CREATED',
	'GIT_COMMITTED',
	'GIT_PUSHED',
	'GIT_PR_OPENED',
	'PR_BODY_PREPARED',
	'OPTIONAL_ROLE_COMPLETED',
	'CRITIC_REVIEW_COMPLETED',
	'CRITIC_REVIEW_FAILED',
	'SPEC_CRITIC_COMPLETED',
	'PLAN_CRITIC_COMPLETED',
	'PLAN_FROZEN',
	'QA_CRITIC_COMPLETED',
	'TASK_PLAN_GENERATED',
	'POLICY_GATE_EVALUATED',
	'TASK_STARTED',
	'TASK_COMPLETED',
	'TASK_FAILED',
	'RECONCILIATION_STARTED',
	'RECONCILIATION_COMPLETED',
	'RECONCILIATION_CONFLICT_DETECTED',
	'RUN_COMPLETED',
	'RUN_READY_FOR_GIT_APPROVAL',
	'RUN_BLOCKED',
	'RUN_CANCELLED',
	'RUN_FAILED',
	'FALSE_ECONOMY_DETECTED',
	'PROJECTION_WRITTEN',
	'CANDIDATE_LEARNING_STAGED',
	'RESUME_FROM_ESCALATION',
	'PROMPT_FRICTION_DETECTED',
	'PROMPT_FRICTION_ANALYZED',
] as const);

export const RuntimeStateNameSchema = z.enum(RUNTIME_STATES);
export type RuntimeStateName = z.infer<typeof RuntimeStateNameSchema>;

export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

export const RuntimeLastErrorSchema = z
	.object({
		code: z.string().nullable().optional(),
		message: z.string().nullable().optional(),
		executionProvenFalse: z.boolean().nullable().optional(),
		metadata: z.record(z.string(), z.unknown()).nullable().optional(),
	})
	.passthrough();
export type RuntimeLastError = z.infer<typeof RuntimeLastErrorSchema>;

export const RuntimeStateSchema = z.object({
	schemaVersion: z.literal(RUNTIME_SCHEMA_VERSION),
	runId: z.string(),
	threadId: z.string(),
	runtimeRevision: z.number().int().min(0),
	state: RuntimeStateNameSchema,
	goalArtifact: z.string(),
	draftArtifact: z.string().nullable(),
	draftHash: z.string().nullable(),
	taskManifestArtifact: z.string().nullable(),
	taskManifestHash: z.string().nullable(),
	completeness: CompletenessEvaluationSchema,
	pendingInterruptId: z.string().nullable(),
	approvedSpecHash: z.string().nullable(),
	modelOperations: z.array(z.string()),
	blockedReason: z.string().nullable().optional(),
	lastError: RuntimeLastErrorSchema.nullable().optional(),
	workflowHash: z.string(),
	roleHash: z.string(),
	promptPolicyHash: z.string(),
	capabilitySetHash: z.string(),
	evaluatorSetHash: z.string(),
	completenessHash: z.string().nullable(),
	activeModelOperationId: z.string().nullable(),
	activeProposalArtifact: z.string().nullable(),
	interviewRound: z.number().int().min(0),
	activeGeneration: z.number().int().min(0).nullable().optional(),
	worktreePath: z.string().nullable().optional(),
	semanticRepairsCount: z.number().int().min(0).optional(),
	approvedPlanPolicyHash: z.string().nullable().optional(),
	preflightBindingArtifact: z.string().nullable().optional(),
	targetTreeSha: z.string().nullable().optional(),
	authorVendor: z.string().nullable().optional(),
	executor: z.literal('minimal').optional(),
	specApprovalAttempt: z.number().int().min(0),
	specCriticRepairPending: z.boolean(),
	taskPlanFrozen: z.boolean(),
	taskPlanHash: z.string().nullable().optional(),
	integrationWorktreePath: z.string().nullable().optional(),
	activeTaskId: z.string().nullable().optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

export const RuntimeEventSchema = z.object({
	eventId: z.string(),
	eventType: EventTypeSchema,
	runId: z.string(),
	runtimeRevision: z.number().int().min(0),
	stateHash: z.string().nullable(),
	inputHash: z.string().nullable(),
	outputHash: z.string().nullable(),
	timestamp: z.string(),
	causalId: z.string(),
	payload: z.record(z.string(), z.unknown()),
});
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

export function validateRuntimeState(input: unknown): Readonly<RuntimeState> {
	const keys = [
		'schemaVersion',
		'runId',
		'threadId',
		'runtimeRevision',
		'state',
		'goalArtifact',
		'draftArtifact',
		'draftHash',
		'taskManifestArtifact',
		'taskManifestHash',
		'completeness',
		'pendingInterruptId',
		'approvedSpecHash',
		'modelOperations',
		'blockedReason',
		'lastError',
		'workflowHash',
		'roleHash',
		'promptPolicyHash',
		'capabilitySetHash',
		'evaluatorSetHash',
		'completenessHash',
		'activeModelOperationId',
		'activeProposalArtifact',
		'interviewRound',
		'activeGeneration',
		'worktreePath',
		'semanticRepairsCount',
		'approvedPlanPolicyHash',
		'preflightBindingArtifact',
		'targetTreeSha',
		'authorVendor',
		'executor',
		'specApprovalAttempt',
		'specCriticRepairPending',
		'taskPlanFrozen',
		'taskPlanHash',
		'integrationWorktreePath',
		'activeTaskId',
		'createdAt',
		'updatedAt',
	];
	const base = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
	if (!base) failContract('runtimeState must be an object');
	const normalized: Record<string, unknown> = {
		...base,
		specApprovalAttempt: base.specApprovalAttempt != null ? base.specApprovalAttempt : 0,
		specCriticRepairPending: base.specCriticRepairPending === true,
		taskPlanFrozen: base.taskPlanFrozen === true,
		taskManifestArtifact: base.taskManifestArtifact ?? null,
		taskManifestHash: base.taskManifestHash ?? null,
	};
	assertClosedContract(normalized, keys, 'runtimeState');
	if (normalized.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
		failContract('Unsupported runtime state schemaVersion');
	}
	validateRunId(normalized.runId);
	validateOpaqueId(normalized.threadId, 'runtimeState.threadId');
	if (!Number.isSafeInteger(normalized.runtimeRevision) || (normalized.runtimeRevision as number) < 0) {
		failContract('runtimeState.runtimeRevision must be non-negative');
	}
	if (typeof normalized.state !== 'string' || !(RUNTIME_STATES as readonly string[]).includes(normalized.state)) {
		failContract('runtimeState.state is invalid');
	}
	if (typeof normalized.goalArtifact !== 'string' || !HASH_PATTERN.test(normalized.goalArtifact)) {
		failContract('goalArtifact is invalid');
	}
	contractOptionalHash(normalized.draftArtifact, 'draftArtifact');
	contractOptionalHash(normalized.draftHash, 'draftHash');
	contractOptionalHash(normalized.taskManifestArtifact, 'taskManifestArtifact');
	contractOptionalHash(normalized.taskManifestHash, 'taskManifestHash');
	validateCompleteness(normalized.completeness);
	if (normalized.pendingInterruptId !== null) {
		validateOpaqueId(normalized.pendingInterruptId, 'pendingInterruptId');
	}
	contractOptionalHash(normalized.approvedSpecHash, 'approvedSpecHash');
	if (
		!Array.isArray(normalized.modelOperations) ||
		new Set(normalized.modelOperations).size !== normalized.modelOperations.length
	) {
		failContract('modelOperations must be a unique array');
	}
	normalized.modelOperations.forEach((id) => validateOpaqueId(id, 'modelOperationId'));
	if (normalized.activeModelOperationId !== null) {
		validateOpaqueId(normalized.activeModelOperationId, 'activeModelOperationId');
	}
	contractOptionalHash(normalized.activeProposalArtifact, 'activeProposalArtifact');
	if (
		['BLOCKED', 'BUDGET_EXHAUSTED'].includes(normalized.state) &&
		(typeof normalized.blockedReason !== 'string' || normalized.blockedReason.length === 0)
	) {
		failContract('Blocked states require blockedReason');
	}
	if (!Number.isSafeInteger(normalized.interviewRound) || (normalized.interviewRound as number) < 0) {
		failContract('interviewRound must be non-negative');
	}
	for (const field of [
		'workflowHash',
		'roleHash',
		'promptPolicyHash',
		'capabilitySetHash',
		'evaluatorSetHash',
	]) {
		const fieldVal = normalized[field];
		if (typeof fieldVal !== 'string' || !HASH_PATTERN.test(fieldVal)) failContract(`${field} is invalid`);
	}
	contractOptionalHash(normalized.completenessHash, 'completenessHash');
	if (normalized.activeGeneration !== undefined && normalized.activeGeneration !== null) {
		if (!Number.isSafeInteger(normalized.activeGeneration) || (normalized.activeGeneration as number) < 0) {
			failContract('activeGeneration must be a non-negative integer');
		}
	}
	if (normalized.worktreePath !== undefined && normalized.worktreePath !== null) {
		if (typeof normalized.worktreePath !== 'string' || normalized.worktreePath.length === 0) {
			failContract('worktreePath must be a non-empty string');
		}
	}
	if (normalized.semanticRepairsCount !== undefined) {
		if (!Number.isSafeInteger(normalized.semanticRepairsCount) || (normalized.semanticRepairsCount as number) < 0) {
			failContract('semanticRepairsCount must be a non-negative integer');
		}
	}
	if (normalized.approvedPlanPolicyHash !== undefined) {
		contractOptionalHash(normalized.approvedPlanPolicyHash, 'approvedPlanPolicyHash');
	}
	if (normalized.preflightBindingArtifact !== undefined) {
		contractOptionalHash(normalized.preflightBindingArtifact, 'preflightBindingArtifact');
	}
	if (normalized.targetTreeSha !== undefined && normalized.targetTreeSha !== null) {
		if (typeof normalized.targetTreeSha !== 'string' || !GIT_SHA.test(normalized.targetTreeSha)) {
			failContract('targetTreeSha must be a 40-character hex tree SHA');
		}
	}
	if (normalized.authorVendor !== undefined && normalized.authorVendor !== null) {
		if (typeof normalized.authorVendor !== 'string' || normalized.authorVendor.length === 0) {
			failContract('authorVendor must be a non-empty string');
		}
	}
	if (Object.hasOwn(normalized, 'executor') && normalized.executor !== 'minimal') {
		failContract('runtimeState.executor must be minimal');
	}
	if (normalized.specApprovalAttempt !== undefined && normalized.specApprovalAttempt !== null) {
		if (!Number.isSafeInteger(normalized.specApprovalAttempt) || (normalized.specApprovalAttempt as number) < 0) {
			failContract('specApprovalAttempt must be a non-negative integer');
		}
	}
	if (
		normalized.specCriticRepairPending !== undefined &&
		normalized.specCriticRepairPending !== null &&
		typeof normalized.specCriticRepairPending !== 'boolean'
	) {
		failContract('specCriticRepairPending must be a boolean');
	}
	if (
		normalized.taskPlanFrozen !== undefined &&
		normalized.taskPlanFrozen !== null &&
		typeof normalized.taskPlanFrozen !== 'boolean'
	) {
		failContract('taskPlanFrozen must be a boolean');
	}
	if (normalized.taskPlanHash !== undefined && normalized.taskPlanHash !== null) {
		contractOptionalHash(normalized.taskPlanHash, 'taskPlanHash');
	}
	if (normalized.integrationWorktreePath !== undefined && normalized.integrationWorktreePath !== null) {
		if (typeof normalized.integrationWorktreePath !== 'string' || normalized.integrationWorktreePath.length === 0) {
			failContract('integrationWorktreePath must be a non-empty string');
		}
	}
	if (normalized.activeTaskId !== undefined && normalized.activeTaskId !== null) {
		validateOpaqueId(normalized.activeTaskId, 'activeTaskId');
	}
	for (const field of ['createdAt', 'updatedAt']) {
		const tsVal = normalized[field];
		if (typeof tsVal !== 'string' || Number.isNaN(Date.parse(tsVal))) {
			failContract(`${field} must be an ISO timestamp`);
		}
	}
	const cloned: unknown = structuredClone(normalized);
	return Object.freeze(cloned as RuntimeState);
}

export function validateEvent(input: unknown): Readonly<RuntimeEvent> {
	assertClosedContract(
		input,
		[
			'eventId',
			'eventType',
			'runId',
			'runtimeRevision',
			'stateHash',
			'inputHash',
			'outputHash',
			'timestamp',
			'causalId',
			'payload',
		],
		'event',
	);
	validateOpaqueId(input.eventId, 'event.eventId');
	if (typeof input.eventType !== 'string' || !(EVENT_TYPES as readonly string[]).includes(input.eventType)) {
		failContract('event.eventType is invalid');
	}
	validateRunId(input.runId);
	if (!Number.isSafeInteger(input.runtimeRevision) || (input.runtimeRevision as number) < 0) {
		failContract('event.runtimeRevision is invalid');
	}
	for (const field of ['stateHash', 'inputHash', 'outputHash']) {
		contractOptionalHash(input[field], `event.${field}`);
	}
	if (typeof input.timestamp !== 'string' || Number.isNaN(Date.parse(input.timestamp))) {
		failContract('event.timestamp must be ISO');
	}
	validateOpaqueId(input.causalId, 'event.causalId');
	assertContractObject(input.payload, 'event.payload');
	const cloned: unknown = structuredClone(input);
	return Object.freeze(cloned as RuntimeEvent);
}

export function createEvent({
	eventType,
	runId,
	runtimeRevision,
	state,
	input = null,
	output = null,
	causalId,
	payload = {},
	now = new Date(),
}: {
	eventType: string;
	runId: string;
	runtimeRevision: number;
	state?: unknown;
	input?: unknown;
	output?: unknown;
	causalId: string;
	payload?: Record<string, unknown>;
	now?: Date | string | number | (() => Date | string | number);
}): Readonly<RuntimeEvent> {
	const stateHash = state ? sha256(state) : null;
	const inputHash = input === null ? null : sha256(input);
	const outputHash = output === null ? null : sha256(output);
	const eventId = deriveEventId({
		eventType,
		runId,
		runtimeRevision,
		stateHash,
		inputHash,
		outputHash,
		causalId,
	});
	const resolvedNow = typeof now === 'function' ? now() : now;
	const timestamp = (resolvedNow instanceof Date ? resolvedNow : new Date(resolvedNow)).toISOString();
	return validateEvent({
		eventId,
		eventType,
		runId,
		runtimeRevision,
		stateHash,
		inputHash,
		outputHash,
		timestamp,
		causalId,
		payload,
	});
}

export function deriveEventId({
	eventType,
	runId,
	runtimeRevision,
	stateHash,
	inputHash,
	outputHash,
	causalId,
}: {
	eventType: string;
	runId: string;
	runtimeRevision: number;
	stateHash: string | null;
	inputHash: string | null;
	outputHash: string | null;
	causalId: string;
}): string {
	return sha256({
		eventType,
		runId,
		runtimeRevision,
		stateHash,
		inputHash,
		outputHash,
		causalId,
	}).slice(0, 48);
}
