import { z } from 'zod';
import {
	GIT_SHA,
	HASH_PATTERN,
	assertClosedContract,
	contractNonEmptyString,
	failContract,
	validateRunId,
} from './primitives.ts';

export const RELIABILITY_SCHEMA_VERSION = '1.0.0';

export const RELIABILITY_FAILURE_CATEGORIES = Object.freeze([
	'STALE_LITERAL_REPLACEMENT',
	'MISSING_SOURCE_EXTENSION',
	'WRONG_AUTHORIZED_DEPENDENCY_RANGE',
	'TRANSIENT_VERIFICATION_FAILURE',
	'DIRECT_LOCKFILE_MUTATION',
	'MISSING_POST_EDIT_VERIFICATION',
	'IMPLEMENTER_NON_COMPLETED',
	'RUN_DEADLINE_EXPIRED',
	'NONEXISTENT_SOURCE_PATH_REPEATED',
	'UNDECLARED_DEPENDENCY_MUTATION',
	'POLICY_REJECTION',
	'INVALID_EDIT',
	'VERIFICATION_FAILURE',
	'POST_VERIFICATION_MUTATION',
	'REPAIR_INVOKED',
	'QA_ACCEPTANCE_DIVERGENCE',
	'SCOPE_EXPANSION',
	'STALE_BASE_COMMIT',
	'NONCANONICAL_PREFLIGHT',
	'INFRASTRUCTURE_INTERRUPTION',
	'REPAIR_GATE_EXHAUSTED',
	'TASK_PLAN_CONTRACT_VIOLATION',
	'CONFIGURATION_DRIFT',
	'UNSUPPORTED_AUTHOR_VENDOR',
	'IMPLEMENTER_NON_PROGRESS',
	'UNCLASSIFIED',
] as const);

export const ReliabilityFailureCategorySchema = z.enum(RELIABILITY_FAILURE_CATEGORIES);
export type ReliabilityFailureCategory = z.infer<typeof ReliabilityFailureCategorySchema>;

export const FalseEconomyDiagnosticSchema = z.object({
	initialRouteIds: z.array(z.string().min(1)).min(1),
	effectiveStrategy: z.enum(['min-cost', 'balanced', 'quality-first']),
	costInitialMicrousd: z.number().int().min(0),
	repairAttemptCount: z.number().int().positive(),
	costRepairMicrousd: z.number().int().min(0),
	netChurnCostMicrousd: z.number().int().min(0),
	deltaMicrousd: z.number().int(),
	burnedRepairAttempts: z.number().int().positive(),
});
export type FalseEconomyDiagnostic = z.infer<typeof FalseEconomyDiagnosticSchema>;

export const MutationAttemptRecordSchema = z.object({
	schemaVersion: z.literal(RELIABILITY_SCHEMA_VERSION),
	attemptId: z.string(),
	runId: z.string(),
	taskId: z.string(),
	roleId: z.string(),
	stepIndex: z.number().int().min(0),
	toolName: z.enum(['write_file', 'replace_in_file', 'replace_snapshot_range']),
	path: z.string(),
	status: z.enum(['accepted', 'rejected']),
	rejectionCategory: ReliabilityFailureCategorySchema.nullable(),
	routeId: z.string().nullable(),
	modelId: z.string().nullable(),
	occurredAt: z.string(),
});
export type MutationAttemptRecord = z.infer<typeof MutationAttemptRecordSchema>;

export const VerificationAttemptRecordSchema = z.object({
	schemaVersion: z.literal(RELIABILITY_SCHEMA_VERSION),
	attemptId: z.string(),
	runId: z.string(),
	taskId: z.string(),
	command: z.array(z.string().min(1)).min(1),
	attempt: z.number().int().min(1),
	phase: z.enum(['post-implementation', 'confirmation', 'repair']),
	status: z.enum(['passed', 'failed', 'timed_out']),
	exitCode: z.number().int().min(0),
	occurredAt: z.string(),
});
export type VerificationAttemptRecord = z.infer<typeof VerificationAttemptRecordSchema>;

export const RouteAttributionRecordSchema = z.object({
	schemaVersion: z.literal(RELIABILITY_SCHEMA_VERSION),
	operationId: z.string(),
	runId: z.string(),
	taskId: z.string(),
	roleId: z.string(),
	routeId: z.string(),
	modelId: z.string(),
	provider: z.string(),
	sequence: z.number().int().min(1),
	failover: z.boolean(),
	latencyMs: z.number().int().min(0).nullable(),
	inputTokens: z.number().int().min(0).nullable(),
	outputTokens: z.number().int().min(0).nullable(),
	costMicrousd: z.number().int().min(0).nullable(),
	occurredAt: z.string(),
});
export type RouteAttributionRecord = z.infer<typeof RouteAttributionRecordSchema>;

export const CanaryQualificationRecordSchema = z.object({
	schemaVersion: z.literal(RELIABILITY_SCHEMA_VERSION),
	repositoryId: z.string(),
	runId: z.string(),
	status: z.enum(['PASSED', 'FAILED', 'INCONCLUSIVE']),
	failureCategories: z.array(ReliabilityFailureCategorySchema),
	inconclusiveCause: z.string().nullable(),
	baseCommitSha: z.string(),
	workflowHash: z.string(),
	boundedPlanningHash: z.string(),
	implementerRoleHash: z.string(),
	modelPolicyHash: z.string(),
	taskPlanHash: z.string(),
	taskManifestHash: z.string(),
	qualifiedAt: z.string(),
});
export type CanaryQualificationRecord = z.infer<typeof CanaryQualificationRecordSchema>;

export function validateFalseEconomyDiagnostic(input: unknown): Readonly<FalseEconomyDiagnostic> {
	const keys = [
		'initialRouteIds',
		'effectiveStrategy',
		'costInitialMicrousd',
		'repairAttemptCount',
		'costRepairMicrousd',
		'netChurnCostMicrousd',
		'deltaMicrousd',
		'burnedRepairAttempts',
	];
	assertClosedContract(input, keys, 'falseEconomyDiagnostic');
	for (const key of keys) {
		if (input[key] === undefined) failContract(`falseEconomyDiagnostic.${key} is required`);
	}
	if (!Array.isArray(input.initialRouteIds) || input.initialRouteIds.length === 0) {
		failContract('falseEconomyDiagnostic.initialRouteIds must be non-empty array');
	}
	for (const routeId of input.initialRouteIds) {
		if (typeof routeId !== 'string' || routeId.length === 0) {
			failContract('falseEconomyDiagnostic.initialRouteIds contains invalid routeId');
		}
	}
	if (
		typeof input.effectiveStrategy !== 'string' ||
		!['min-cost', 'balanced', 'quality-first'].includes(input.effectiveStrategy)
	) {
		failContract('falseEconomyDiagnostic.effectiveStrategy is invalid');
	}
	for (const key of ['costInitialMicrousd', 'costRepairMicrousd', 'netChurnCostMicrousd']) {
		if (!Number.isSafeInteger(input[key]) || (input[key] as number) < 0) {
			failContract(`falseEconomyDiagnostic.${key} must be non-negative integer`);
		}
	}
	for (const key of ['repairAttemptCount', 'burnedRepairAttempts']) {
		if (!Number.isSafeInteger(input[key]) || (input[key] as number) <= 0) {
			failContract(`falseEconomyDiagnostic.${key} must be positive integer`);
		}
	}
	if (!Number.isSafeInteger(input.deltaMicrousd)) {
		failContract('falseEconomyDiagnostic.deltaMicrousd must be safe integer');
	}
	const cloned: unknown = structuredClone(input);
	return Object.freeze(cloned as FalseEconomyDiagnostic);
}

export function validateMutationAttempt(input: unknown): Readonly<MutationAttemptRecord> {
	const keys = [
		'schemaVersion', 'attemptId', 'runId', 'taskId', 'roleId', 'stepIndex',
		'toolName', 'path', 'status', 'rejectionCategory', 'routeId', 'modelId', 'occurredAt',
	];
	assertClosedContract(input, keys, 'mutationAttempt');
	if (input.schemaVersion !== RELIABILITY_SCHEMA_VERSION) {
		failContract('Unsupported mutationAttempt schemaVersion');
	}
	contractNonEmptyString(input.attemptId, 'mutationAttempt.attemptId');
	validateRunId(input.runId);
	contractNonEmptyString(input.taskId, 'mutationAttempt.taskId');
	contractNonEmptyString(input.roleId, 'mutationAttempt.roleId');
	if (!Number.isSafeInteger(input.stepIndex) || (input.stepIndex as number) < 0) {
		failContract('mutationAttempt.stepIndex must be a non-negative integer');
	}
	if (
		typeof input.toolName !== 'string' ||
		!['write_file', 'replace_in_file', 'replace_snapshot_range'].includes(input.toolName)
	) {
		failContract('mutationAttempt.toolName is invalid');
	}
	contractNonEmptyString(input.path, 'mutationAttempt.path');
	if (typeof input.status !== 'string' || !['accepted', 'rejected'].includes(input.status)) {
		failContract('mutationAttempt.status is invalid');
	}
	if (input.status === 'rejected') {
		if (
			typeof input.rejectionCategory !== 'string' ||
			!(RELIABILITY_FAILURE_CATEGORIES as readonly string[]).includes(input.rejectionCategory)
		) {
			failContract('mutationAttempt.rejectionCategory is invalid');
		}
	} else if (input.rejectionCategory !== null) {
		failContract('Accepted mutationAttempt cannot have rejectionCategory');
	}
	for (const field of ['routeId', 'modelId']) {
		if (input[field] !== null) contractNonEmptyString(input[field], `mutationAttempt.${field}`);
	}
	if (typeof input.occurredAt !== 'string' || Number.isNaN(Date.parse(input.occurredAt))) {
		failContract('mutationAttempt.occurredAt must be an ISO timestamp');
	}
	const cloned: unknown = structuredClone(input);
	return Object.freeze(cloned as MutationAttemptRecord);
}

export function validateVerificationAttempt(input: unknown): Readonly<VerificationAttemptRecord> {
	const keys = [
		'schemaVersion', 'attemptId', 'runId', 'taskId', 'command', 'attempt',
		'phase', 'status', 'exitCode', 'occurredAt',
	];
	assertClosedContract(input, keys, 'verificationAttempt');
	if (input.schemaVersion !== RELIABILITY_SCHEMA_VERSION) {
		failContract('Unsupported verificationAttempt schemaVersion');
	}
	contractNonEmptyString(input.attemptId, 'verificationAttempt.attemptId');
	validateRunId(input.runId);
	contractNonEmptyString(input.taskId, 'verificationAttempt.taskId');
	if (
		!Array.isArray(input.command) ||
		input.command.length === 0 ||
		input.command.some((part) => typeof part !== 'string' || part.length === 0)
	) {
		failContract('verificationAttempt.command must be a non-empty argv array');
	}
	if (!Number.isSafeInteger(input.attempt) || (input.attempt as number) < 1) {
		failContract('verificationAttempt.attempt must be a positive integer');
	}
	if (typeof input.phase !== 'string' || !['post-implementation', 'confirmation', 'repair'].includes(input.phase)) {
		failContract('verificationAttempt.phase is invalid');
	}
	if (typeof input.status !== 'string' || !['passed', 'failed', 'timed_out'].includes(input.status)) {
		failContract('verificationAttempt.status is invalid');
	}
	if (!Number.isSafeInteger(input.exitCode) || (input.exitCode as number) < 0) {
		failContract('verificationAttempt.exitCode must be a non-negative integer');
	}
	if (typeof input.occurredAt !== 'string' || Number.isNaN(Date.parse(input.occurredAt))) {
		failContract('verificationAttempt.occurredAt must be an ISO timestamp');
	}
	const cloned: unknown = structuredClone(input);
	return Object.freeze(cloned as VerificationAttemptRecord);
}

export function validateRouteAttribution(input: unknown): Readonly<RouteAttributionRecord> {
	const keys = [
		'schemaVersion', 'operationId', 'runId', 'taskId', 'roleId', 'routeId',
		'modelId', 'provider', 'sequence', 'failover', 'latencyMs', 'inputTokens',
		'outputTokens', 'costMicrousd', 'occurredAt',
	];
	assertClosedContract(input, keys, 'routeAttribution');
	if (input.schemaVersion !== RELIABILITY_SCHEMA_VERSION) {
		failContract('Unsupported routeAttribution schemaVersion');
	}
	for (const field of ['operationId', 'taskId', 'roleId', 'routeId', 'modelId', 'provider']) {
		contractNonEmptyString(input[field], `routeAttribution.${field}`);
	}
	validateRunId(input.runId);
	if (!Number.isSafeInteger(input.sequence) || (input.sequence as number) < 1) {
		failContract('routeAttribution.sequence must be a positive integer');
	}
	if (typeof input.failover !== 'boolean') failContract('routeAttribution.failover must be a boolean');
	for (const field of ['latencyMs', 'inputTokens', 'outputTokens', 'costMicrousd']) {
		if (input[field] !== null && (!Number.isSafeInteger(input[field]) || (input[field] as number) < 0)) {
			failContract(`routeAttribution.${field} must be null or a non-negative integer`);
		}
	}
	if (typeof input.occurredAt !== 'string' || Number.isNaN(Date.parse(input.occurredAt))) {
		failContract('routeAttribution.occurredAt must be an ISO timestamp');
	}
	const cloned: unknown = structuredClone(input);
	return Object.freeze(cloned as RouteAttributionRecord);
}

export function validateCanaryQualification(input: unknown): Readonly<CanaryQualificationRecord> {
	const keys = [
		'schemaVersion', 'repositoryId', 'runId', 'status', 'failureCategories',
		'inconclusiveCause', 'baseCommitSha', 'workflowHash', 'boundedPlanningHash',
		'implementerRoleHash', 'modelPolicyHash', 'taskPlanHash', 'taskManifestHash',
		'qualifiedAt',
	];
	assertClosedContract(input, keys, 'canaryQualification');
	if (input.schemaVersion !== RELIABILITY_SCHEMA_VERSION) {
		failContract('Unsupported canaryQualification schemaVersion');
	}
	contractNonEmptyString(input.repositoryId, 'canaryQualification.repositoryId');
	validateRunId(input.runId);
	if (typeof input.status !== 'string' || !['PASSED', 'FAILED', 'INCONCLUSIVE'].includes(input.status)) {
		failContract('canaryQualification.status is invalid');
	}
	if (
		!Array.isArray(input.failureCategories) ||
		input.failureCategories.some(
			(category) =>
				typeof category !== 'string' ||
				!(RELIABILITY_FAILURE_CATEGORIES as readonly string[]).includes(category),
		)
	) {
		failContract('canaryQualification.failureCategories is invalid');
	}
	if (input.status === 'FAILED' && input.failureCategories.length === 0) {
		failContract('Failed canary qualification requires a failure category');
	}
	if (input.inconclusiveCause !== null) {
		contractNonEmptyString(input.inconclusiveCause, 'canaryQualification.inconclusiveCause');
	}
	if (input.status === 'INCONCLUSIVE' && input.inconclusiveCause === null) {
		failContract('Inconclusive canary qualification requires a cause');
	}
	if (typeof input.baseCommitSha !== 'string' || !GIT_SHA.test(input.baseCommitSha)) {
		failContract('canaryQualification.baseCommitSha is invalid');
	}
	for (const field of [
		'workflowHash', 'boundedPlanningHash', 'implementerRoleHash',
		'modelPolicyHash', 'taskPlanHash', 'taskManifestHash',
	]) {
		const fieldVal = input[field];
		if (typeof fieldVal !== 'string' || !HASH_PATTERN.test(fieldVal)) {
			failContract(`canaryQualification.${field} is invalid`);
		}
	}
	if (typeof input.qualifiedAt !== 'string' || Number.isNaN(Date.parse(input.qualifiedAt))) {
		failContract('canaryQualification.qualifiedAt must be an ISO timestamp');
	}
	const cloned: unknown = structuredClone(input);
	return Object.freeze(cloned as CanaryQualificationRecord);
}

export type MutationAttempt = MutationAttemptRecord;
export type VerificationAttempt = VerificationAttemptRecord;
export type RouteAttribution = RouteAttributionRecord;
export type CanaryQualification = CanaryQualificationRecord;

