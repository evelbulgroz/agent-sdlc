import { z } from 'zod';
import {
	GIT_SHA,
	HASH_PATTERN,
	RUNTIME_SCHEMA_VERSION,
	assertClosedContract,
	contractNonEmptyString,
	contractStringArray,
	failContract,
	validateOpaqueId,
	validateRunId,
} from './primitives.ts';
import { InsertionPointSchema, validateRoleId } from './role-schema.ts';

export const SEVERITIES = Object.freeze(['P1', 'P2', 'P3'] as const);

export const FAILURE_CLASSIFICATIONS = Object.freeze([
	'test_failure',
	'quality_failure',
	'build_failure',
	'review_finding',
	'infrastructure_failure',
	'unknown',
] as const);

export const SeveritySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof SeveritySchema>;

export const FailureClassificationSchema = z.enum(FAILURE_CLASSIFICATIONS);
export type FailureClassification = z.infer<typeof FailureClassificationSchema>;

export const ReviewFindingItemSchema = z.object({
	findingId: z.string(),
	severity: SeveritySchema,
	category: z.string(),
	path: z.string(),
	lineRange: z.tuple([z.number().int().min(1), z.number().int().min(1)]).readonly(),
	evidence: z.string(),
	failureMechanism: z.string(),
	remediation: z.string(),
});
export type ReviewFindingItem = z.infer<typeof ReviewFindingItemSchema>;

export const ReviewFindingsRecordSchema = z.object({
	schemaVersion: z.literal(RUNTIME_SCHEMA_VERSION),
	runId: z.string(),
	generation: z.number().int().min(0),
	status: z.enum(['PASS', 'FAIL']),
	findings: z.array(ReviewFindingItemSchema).readonly(),
});
export type ReviewFindingsRecord = z.infer<typeof ReviewFindingsRecordSchema>;

export const FailurePacketRecordSchema = z.object({
	schemaVersion: z.literal(RUNTIME_SCHEMA_VERSION),
	runId: z.string(),
	generation: z.number().int().min(0),
	failedCommand: z.string(),
	exitCode: z.number().int(),
	sanitizedOutput: z.string(),
	classification: FailureClassificationSchema,
	targetPaths: z.array(z.string()).readonly(),
	baseCommitSha: z.string(),
	timestamp: z.string(),
});
export type FailurePacketRecord = z.infer<typeof FailurePacketRecordSchema>;

export const PreflightBindingRecordSchema = z.object({
	baseCommitSha: z.string(),
	targetTreeSha: z.string(),
	command: z.string(),
	preflightResultHash: z.string(),
	status: z.literal('OK'),
	canonical: z.literal(true),
});
export type PreflightBindingRecord = z.infer<typeof PreflightBindingRecordSchema>;

export const CriticReviewRecordSchema = z.object({
	schemaVersion: z.literal(RUNTIME_SCHEMA_VERSION),
	reviewId: z.string(),
	runId: z.string(),
	generation: z.number().int().min(0),
	phase: z.enum(['spec', 'plan', 'code', 'qa']),
	reviewerVendor: z.string(),
	reviewerModel: z.string(),
	artifactHash: z.string(),
	attemptKey: z.string(),
	manifestPath: z.string(),
	findingsCount: z.number().int().min(0),
	hasP1: z.boolean(),
	reviewedAt: z.string(),
	operationId: z.string().optional(),
	usageRecordIds: z.array(z.string()).optional(),
	findingsJson: z.string().nullable().optional(),
	reportArtifact: z.string().nullable().optional(),
});
export type CriticReviewRecord = z.infer<typeof CriticReviewRecordSchema>;

export const OptionalRoleRecordSchema = z.object({
	schemaVersion: z.literal(RUNTIME_SCHEMA_VERSION),
	runId: z.string(),
	taskId: z.string(),
	roleId: z.string(),
	insertionPoint: InsertionPointSchema,
	generation: z.number().int().min(0),
	status: z.enum(['passed', 'modified', 'failed']),
	summary: z.string(),
	executedAt: z.string(),
	outputArtifact: z.string().nullable().optional(),
	structuredFindingsJson: z.string().nullable().optional(),
});
export type OptionalRoleRecord = z.infer<typeof OptionalRoleRecordSchema>;

export function validateReviewFindings(input: unknown): Readonly<ReviewFindingsRecord> {
	const keys = ['schemaVersion', 'runId', 'generation', 'status', 'findings'];
	assertClosedContract(input, keys, 'reviewFindings');
	if (input.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
		failContract('Unsupported reviewFindings schemaVersion');
	}
	const runId = validateRunId(input.runId);
	if (!Number.isSafeInteger(input.generation) || (input.generation as number) < 0) {
		failContract('reviewFindings.generation must be a non-negative integer');
	}
	if (typeof input.status !== 'string' || !['PASS', 'FAIL'].includes(input.status)) {
		failContract("reviewFindings.status must be 'PASS' or 'FAIL'");
	}
	if (!Array.isArray(input.findings)) {
		failContract('reviewFindings.findings must be an array');
	}
	const findingKeys = [
		'findingId',
		'severity',
		'category',
		'path',
		'lineRange',
		'evidence',
		'failureMechanism',
		'remediation',
	];
	let hasP1 = false;
	const validatedFindings = input.findings.map((f, i) => {
		assertClosedContract(f, findingKeys, `reviewFindings.findings[${i}]`);
		const findingId = validateOpaqueId(f.findingId, `findings[${i}].findingId`);
		if (typeof f.severity !== 'string' || !(SEVERITIES as readonly string[]).includes(f.severity)) {
			failContract(`findings[${i}].severity must be P1, P2, or P3`);
		}
		if (f.severity === 'P1') hasP1 = true;
		const category = contractNonEmptyString(f.category, `findings[${i}].category`);
		const findingPath = contractNonEmptyString(f.path, `findings[${i}].path`);
		if (
			!Array.isArray(f.lineRange) ||
			f.lineRange.length !== 2 ||
			!Number.isInteger(f.lineRange[0]) ||
			!Number.isInteger(f.lineRange[1]) ||
			(f.lineRange[0] as number) < 1 ||
			(f.lineRange[1] as number) < (f.lineRange[0] as number)
		) {
			failContract(`findings[${i}].lineRange must be [startLine, endLine] with 1 <= start <= end`);
		}
		const evidence = contractNonEmptyString(f.evidence, `findings[${i}].evidence`);
		const failureMechanism = contractNonEmptyString(f.failureMechanism, `findings[${i}].failureMechanism`);
		const remediation = contractNonEmptyString(f.remediation, `findings[${i}].remediation`);
		const range: readonly [number, number] = Object.freeze([
			f.lineRange[0] as number,
			f.lineRange[1] as number,
		]);
		return Object.freeze({
			findingId,
			severity: f.severity as Severity,
			category,
			path: findingPath,
			lineRange: range,
			evidence,
			failureMechanism,
			remediation,
		});
	});
	if (hasP1 && input.status !== 'FAIL') {
		failContract("reviewFindings status must be 'FAIL' when P1 findings exist");
	}
	if (!hasP1 && input.status === 'FAIL') {
		failContract("reviewFindings status cannot be 'FAIL' without P1 findings");
	}
	return Object.freeze({
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		runId,
		generation: input.generation as number,
		status: input.status as 'PASS' | 'FAIL',
		findings: Object.freeze(validatedFindings),
	});
}

export function validateFailurePacket(input: unknown): Readonly<FailurePacketRecord> {
	const keys = [
		'schemaVersion',
		'runId',
		'generation',
		'failedCommand',
		'exitCode',
		'sanitizedOutput',
		'classification',
		'targetPaths',
		'baseCommitSha',
		'timestamp',
	];
	assertClosedContract(input, keys, 'failurePacket');
	if (input.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
		failContract('Unsupported failurePacket schemaVersion');
	}
	const runId = validateRunId(input.runId);
	if (!Number.isSafeInteger(input.generation) || (input.generation as number) < 0) {
		failContract('failurePacket.generation must be a non-negative integer');
	}
	const failedCommand = contractNonEmptyString(input.failedCommand, 'failurePacket.failedCommand');
	if (!Number.isInteger(input.exitCode)) {
		failContract('failurePacket.exitCode must be an integer');
	}
	if (typeof input.sanitizedOutput !== 'string') {
		failContract('failurePacket.sanitizedOutput must be a string');
	}
	if (
		typeof input.classification !== 'string' ||
		!(FAILURE_CLASSIFICATIONS as readonly string[]).includes(input.classification)
	) {
		failContract(`failurePacket.classification '${String(input.classification)}' is invalid`);
	}
	const targetPaths = contractStringArray(input.targetPaths, 'failurePacket.targetPaths', {
		allowEmpty: false,
		maxItems: 64,
	});
	if (typeof input.baseCommitSha !== 'string' || !GIT_SHA.test(input.baseCommitSha)) {
		failContract('failurePacket.baseCommitSha must be a 40-character hex commit SHA');
	}
	if (typeof input.timestamp !== 'string' || Number.isNaN(Date.parse(input.timestamp))) {
		failContract('failurePacket.timestamp must be an ISO timestamp');
	}
	return Object.freeze({
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		runId,
		generation: input.generation as number,
		failedCommand,
		exitCode: input.exitCode as number,
		sanitizedOutput: input.sanitizedOutput,
		classification: input.classification as FailureClassification,
		targetPaths: Object.freeze([...targetPaths]),
		baseCommitSha: input.baseCommitSha,
		timestamp: input.timestamp,
	});
}

export function validatePreflightBinding(input: unknown): Readonly<PreflightBindingRecord> {
	const keys = [
		'baseCommitSha',
		'targetTreeSha',
		'command',
		'preflightResultHash',
		'status',
		'canonical',
	];
	assertClosedContract(input, keys, 'preflightBinding');
	if (typeof input.baseCommitSha !== 'string' || !GIT_SHA.test(input.baseCommitSha)) {
		failContract('preflightBinding.baseCommitSha must be a 40-character hex commit SHA');
	}
	if (typeof input.targetTreeSha !== 'string' || !GIT_SHA.test(input.targetTreeSha)) {
		failContract('preflightBinding.targetTreeSha must be a 40-character hex tree SHA');
	}
	const command = contractNonEmptyString(input.command, 'preflightBinding.command');
	if (typeof input.preflightResultHash !== 'string' || !HASH_PATTERN.test(input.preflightResultHash)) {
		failContract('preflightBinding.preflightResultHash must be a SHA-256 hash');
	}
	if (input.status !== 'OK') {
		failContract("preflightBinding.status must be 'OK'");
	}
	if (input.canonical !== true) {
		failContract('preflightBinding.canonical must be true');
	}
	return Object.freeze({
		baseCommitSha: input.baseCommitSha,
		targetTreeSha: input.targetTreeSha,
		command,
		preflightResultHash: input.preflightResultHash,
		status: 'OK',
		canonical: true,
	});
}

export function validateCriticReviewRecord(input: unknown): Readonly<CriticReviewRecord> {
	const keys = [
		'schemaVersion',
		'reviewId',
		'runId',
		'generation',
		'phase',
		'reviewerVendor',
		'reviewerModel',
		'artifactHash',
		'attemptKey',
		'manifestPath',
		'findingsCount',
		'hasP1',
		'reviewedAt',
		'operationId',
		'usageRecordIds',
		'findingsJson',
		'reportArtifact',
	];
	assertClosedContract(input, keys, 'criticReviewRecord');
	if (input.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
		failContract('Unsupported criticReviewRecord schemaVersion');
	}
	validateOpaqueId(input.reviewId, 'criticReviewRecord.reviewId');
	validateRunId(input.runId);
	if (!Number.isSafeInteger(input.generation) || (input.generation as number) < 0) {
		failContract('criticReviewRecord.generation must be a non-negative integer');
	}
	if (typeof input.phase !== 'string' || !['spec', 'plan', 'code', 'qa'].includes(input.phase)) {
		failContract("criticReviewRecord.phase must be 'spec', 'plan', 'code', or 'qa'");
	}
	contractNonEmptyString(input.reviewerVendor, 'criticReviewRecord.reviewerVendor');
	contractNonEmptyString(input.reviewerModel, 'criticReviewRecord.reviewerModel');
	if (typeof input.artifactHash !== 'string' || !HASH_PATTERN.test(input.artifactHash)) {
		failContract('criticReviewRecord.artifactHash is invalid');
	}
	contractNonEmptyString(input.attemptKey, 'criticReviewRecord.attemptKey');
	contractNonEmptyString(input.manifestPath, 'criticReviewRecord.manifestPath');
	if (!Number.isSafeInteger(input.findingsCount) || (input.findingsCount as number) < 0) {
		failContract('criticReviewRecord.findingsCount must be a non-negative integer');
	}
	if (typeof input.hasP1 !== 'boolean') {
		failContract('criticReviewRecord.hasP1 must be a boolean');
	}
	if (typeof input.reviewedAt !== 'string' || Number.isNaN(Date.parse(input.reviewedAt))) {
		failContract('criticReviewRecord.reviewedAt must be an ISO timestamp');
	}
	if (input.operationId !== undefined) {
		contractNonEmptyString(input.operationId, 'criticReviewRecord.operationId');
	}
	if (input.findingsJson !== undefined && input.findingsJson !== null) {
		contractNonEmptyString(input.findingsJson, 'criticReviewRecord.findingsJson');
	}
	if (input.reportArtifact !== undefined && input.reportArtifact !== null) {
		contractNonEmptyString(input.reportArtifact, 'criticReviewRecord.reportArtifact');
	}
	if (input.usageRecordIds !== undefined) {
		if (!Array.isArray(input.usageRecordIds)) {
			failContract('criticReviewRecord.usageRecordIds must be an array of strings');
		}
		for (const id of input.usageRecordIds) {
			contractNonEmptyString(id, 'criticReviewRecord.usageRecordIds item');
		}
	}
	const cloned: unknown = structuredClone(input);
	return Object.freeze(cloned as CriticReviewRecord);
}

export function validateOptionalRoleRecord(input: unknown): Readonly<OptionalRoleRecord> {
	const keys = [
		'schemaVersion',
		'runId',
		'taskId',
		'roleId',
		'insertionPoint',
		'generation',
		'status',
		'summary',
		'executedAt',
		'outputArtifact',
		'structuredFindingsJson',
	];
	assertClosedContract(input, keys, 'optionalRoleRecord');
	if (input.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
		failContract('Unsupported optionalRoleRecord schemaVersion');
	}
	validateRunId(input.runId);
	const taskId = input.taskId !== undefined && input.taskId !== null ? input.taskId : 'task-0';
	validateOpaqueId(taskId, 'optionalRoleRecord.taskId');
	validateRoleId(input.roleId);
	if (
		input.insertionPoint !== 'post_implement' &&
		input.insertionPoint !== 'pre_review' &&
		input.insertionPoint !== 'review'
	) {
		failContract("optionalRoleRecord.insertionPoint must be 'post_implement', 'pre_review', or 'review'");
	}
	if (!Number.isSafeInteger(input.generation) || (input.generation as number) < 0) {
		failContract('optionalRoleRecord.generation must be a non-negative integer');
	}
	if (input.status !== 'passed' && input.status !== 'modified' && input.status !== 'failed') {
		failContract("optionalRoleRecord.status must be 'passed', 'modified', or 'failed'");
	}
	if (typeof input.summary !== 'string') {
		failContract('optionalRoleRecord.summary must be a string');
	}
	if (typeof input.executedAt !== 'string' || Number.isNaN(Date.parse(input.executedAt))) {
		failContract('optionalRoleRecord.executedAt must be an ISO timestamp');
	}
	if (input.outputArtifact !== undefined && input.outputArtifact !== null) {
		contractNonEmptyString(input.outputArtifact, 'optionalRoleRecord.outputArtifact');
	}
	if (input.structuredFindingsJson !== undefined && input.structuredFindingsJson !== null) {
		contractNonEmptyString(input.structuredFindingsJson, 'optionalRoleRecord.structuredFindingsJson');
	}
	const cloned: unknown = {
		...structuredClone(input),
		taskId,
	};
	return Object.freeze(cloned as OptionalRoleRecord);
}
