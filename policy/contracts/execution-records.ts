import { z } from 'zod';
import {
	GIT_SHA,
	HASH_PATTERN,
	RUNTIME_SCHEMA_VERSION,
	assertClosedContract,
	assertContractObject,
	contractNonEmptyString,
	contractOptionalHash,
	contractStringArray,
	failContract,
	validateOpaqueId,
	validateRunId,
} from './primitives.ts';
import { validateRoleId } from './role-schema.ts';

export const ALLOWED_TOOLS = Object.freeze([
	'read_file',
	'replace_in_file',
	'replace_snapshot_range',
	'write_file',
	'delete_file',
	'list_dir',
	'find_files',
	'grep',
	'run_allowlisted_command',
] as const);

export const AllowedToolNameSchema = z.enum(ALLOWED_TOOLS);
export type AllowedToolName = z.infer<typeof AllowedToolNameSchema>;

export const OracleSnapshotItemSchema = z.object({
	path: z.string(),
	sha256: z.string(),
});
export type OracleSnapshotItem = z.infer<typeof OracleSnapshotItemSchema>;

export const GenerationRecordSchema = z.object({
	schemaVersion: z.literal(RUNTIME_SCHEMA_VERSION),
	runId: z.string(),
	generation: z.number().int().min(0),
	baseCommitSha: z.string(),
	targetTreeSha: z.string(),
	scopeFingerprints: z.record(z.string(), z.string()),
	taskOwnedPaths: z.array(z.string()).readonly(),
	materializedAt: z.string(),
	reviewReportHash: z.string().nullable(),
	findingCount: z.number().int().min(0),
	hasP1: z.boolean(),
	oracleSnapshot: z.array(OracleSnapshotItemSchema).readonly().optional(),
});
export type GenerationRecord = z.infer<typeof GenerationRecordSchema>;

export const ToolExecutionRecordSchema = z.object({
	schemaVersion: z.literal(RUNTIME_SCHEMA_VERSION),
	executionId: z.string(),
	runId: z.string(),
	taskId: z.string(),
	roleId: z.string(),
	generation: z.number().int().min(0),
	stepIndex: z.number().int().min(0),
	toolName: AllowedToolNameSchema,
	inputHash: z.string(),
	outputArtifact: z.string().nullable(),
	exitCode: z.number().int().nullable(),
	createdAt: z.string(),
});
export type ToolExecutionRecord = z.infer<typeof ToolExecutionRecordSchema>;

export const GitCommitRecordSchema = z.object({
	schemaVersion: z.literal(RUNTIME_SCHEMA_VERSION),
	runId: z.string(),
	targetBranch: z.string(),
	commitSha: z.string(),
	treeSha: z.string(),
	parentSha: z.string(),
	message: z.string(),
	authorName: z.string(),
	authorEmail: z.string(),
	committedAt: z.string(),
});
export type GitCommitRecord = z.infer<typeof GitCommitRecordSchema>;

export const PullRequestRecordSchema = z.object({
	schemaVersion: z.literal(RUNTIME_SCHEMA_VERSION),
	runId: z.string(),
	prUrl: z.string(),
	prNumber: z.number().int().positive(),
	draft: z.boolean(),
	branchName: z.string(),
	baseBranch: z.string(),
	createdAt: z.string(),
});
export type PullRequestRecord = z.infer<typeof PullRequestRecordSchema>;

export function validateGeneration(input: unknown): Readonly<GenerationRecord> {
	const keys = [
		'schemaVersion',
		'runId',
		'generation',
		'baseCommitSha',
		'targetTreeSha',
		'scopeFingerprints',
		'taskOwnedPaths',
		'materializedAt',
		'reviewReportHash',
		'findingCount',
		'hasP1',
		'oracleSnapshot',
	];
	assertClosedContract(input, keys, 'generation');
	if (input.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
		failContract('Unsupported generation schemaVersion');
	}
	const runId = validateRunId(input.runId);
	if (!Number.isSafeInteger(input.generation) || (input.generation as number) < 0) {
		failContract('generation.generation must be a non-negative integer');
	}
	if (typeof input.baseCommitSha !== 'string' || !GIT_SHA.test(input.baseCommitSha)) {
		failContract('generation.baseCommitSha must be a 40-character hex commit SHA');
	}
	if (typeof input.targetTreeSha !== 'string' || !GIT_SHA.test(input.targetTreeSha)) {
		failContract('generation.targetTreeSha must be a 40-character hex tree SHA');
	}
	const rawFingerprints = assertContractObject(input.scopeFingerprints, 'generation.scopeFingerprints');
	const fingerprints: Record<string, string> = {};
	for (const [scope, fp] of Object.entries(rawFingerprints)) {
		contractNonEmptyString(scope, 'generation.scopeFingerprints key');
		if (typeof fp !== 'string' || !HASH_PATTERN.test(fp)) {
			failContract(`generation.scopeFingerprints[${scope}] must be a SHA-256 hash`);
		}
		fingerprints[scope] = fp;
	}
	const taskOwnedPaths = contractStringArray(input.taskOwnedPaths, 'generation.taskOwnedPaths', {
		allowEmpty: false,
		maxItems: 64,
	});
	if (typeof input.materializedAt !== 'string' || Number.isNaN(Date.parse(input.materializedAt))) {
		failContract('generation.materializedAt must be an ISO timestamp');
	}
	if (input.reviewReportHash !== undefined && input.reviewReportHash !== null) {
		if (typeof input.reviewReportHash !== 'string' || !HASH_PATTERN.test(input.reviewReportHash)) {
			failContract('generation.reviewReportHash is invalid');
		}
	}
	let oracleSnapshot: readonly Readonly<OracleSnapshotItem>[] | null = null;
	if (input.oracleSnapshot !== undefined && input.oracleSnapshot !== null) {
		if (!Array.isArray(input.oracleSnapshot)) {
			failContract('generation.oracleSnapshot must be an array');
		}
		const items: Readonly<OracleSnapshotItem>[] = [];
		for (const item of input.oracleSnapshot) {
			if (!item || typeof item !== 'object') {
				failContract('generation.oracleSnapshot item must be an object');
			}
			const rec = item as Record<string, unknown>;
			const itemPath = contractNonEmptyString(rec.path, 'generation.oracleSnapshot item path');
			const hash = rec.sha256 ?? rec.contentHash;
			if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
				failContract(`generation.oracleSnapshot item for '${itemPath}' must have a valid SHA-256 hash`);
			}
			items.push(Object.freeze({ path: itemPath, sha256: hash }));
		}
		oracleSnapshot = Object.freeze(items);
	}
	return Object.freeze({
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		runId,
		generation: input.generation as number,
		baseCommitSha: input.baseCommitSha,
		targetTreeSha: input.targetTreeSha,
		scopeFingerprints: Object.freeze({ ...fingerprints }),
		taskOwnedPaths: Object.freeze([...taskOwnedPaths]),
		materializedAt: input.materializedAt,
		reviewReportHash: (input.reviewReportHash as string | null | undefined) ?? null,
		findingCount: typeof input.findingCount === 'number' ? input.findingCount : 0,
		hasP1: Boolean(input.hasP1),
		oracleSnapshot: oracleSnapshot ?? undefined,
	});
}

export function validateToolExecution(input: unknown): Readonly<ToolExecutionRecord> {
	const keys = [
		'schemaVersion',
		'executionId',
		'runId',
		'taskId',
		'roleId',
		'generation',
		'stepIndex',
		'toolName',
		'inputHash',
		'outputArtifact',
		'exitCode',
		'createdAt',
	];
	assertClosedContract(input, keys, 'toolExecution');
	if (input.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
		failContract('Unsupported toolExecution schemaVersion');
	}
	const executionId = validateOpaqueId(input.executionId, 'toolExecution.executionId');
	const runId = validateRunId(input.runId);
	const rawTaskId = input.taskId !== undefined && input.taskId !== null ? input.taskId : 'task-0';
	const taskId = validateOpaqueId(rawTaskId, 'toolExecution.taskId');
	const roleId = validateRoleId(input.roleId);
	if (!Number.isSafeInteger(input.generation) || (input.generation as number) < 0) {
		failContract('toolExecution.generation must be a non-negative integer');
	}
	if (!Number.isSafeInteger(input.stepIndex) || (input.stepIndex as number) < 0) {
		failContract('toolExecution.stepIndex must be a non-negative integer');
	}
	if (typeof input.toolName !== 'string' || !(ALLOWED_TOOLS as readonly string[]).includes(input.toolName)) {
		failContract(`toolExecution.toolName '${String(input.toolName)}' is not an allowlisted tool`);
	}
	if (typeof input.inputHash !== 'string' || !HASH_PATTERN.test(input.inputHash)) {
		failContract('toolExecution.inputHash must be a SHA-256 hash');
	}
	const outputArtifact = contractOptionalHash(input.outputArtifact ?? null, 'toolExecution.outputArtifact');
	if (
		input.exitCode !== null &&
		input.exitCode !== undefined &&
		!Number.isInteger(input.exitCode)
	) {
		failContract('toolExecution.exitCode must be null or an integer');
	}
	if (typeof input.createdAt !== 'string' || Number.isNaN(Date.parse(input.createdAt))) {
		failContract('toolExecution.createdAt must be an ISO timestamp');
	}
	return Object.freeze({
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		executionId,
		runId,
		taskId,
		roleId,
		generation: input.generation as number,
		stepIndex: input.stepIndex as number,
		toolName: input.toolName as AllowedToolName,
		inputHash: input.inputHash,
		outputArtifact,
		exitCode: (input.exitCode as number | null | undefined) ?? null,
		createdAt: input.createdAt,
	});
}

export function validateGitCommitRecord(input: unknown): Readonly<GitCommitRecord> {
	const keys = [
		'schemaVersion',
		'runId',
		'targetBranch',
		'commitSha',
		'treeSha',
		'parentSha',
		'message',
		'authorName',
		'authorEmail',
		'committedAt',
	];
	assertClosedContract(input, keys, 'gitCommitRecord');
	if (input.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
		failContract('Unsupported gitCommitRecord schemaVersion');
	}
	validateRunId(input.runId);
	contractNonEmptyString(input.targetBranch, 'gitCommitRecord.targetBranch');
	if (typeof input.commitSha !== 'string' || !GIT_SHA.test(input.commitSha)) {
		failContract('gitCommitRecord.commitSha must be a 40-character hex commit SHA');
	}
	if (typeof input.treeSha !== 'string' || !GIT_SHA.test(input.treeSha)) {
		failContract('gitCommitRecord.treeSha must be a 40-character hex tree SHA');
	}
	if (typeof input.parentSha !== 'string' || !GIT_SHA.test(input.parentSha)) {
		failContract('gitCommitRecord.parentSha must be a 40-character hex parent SHA');
	}
	contractNonEmptyString(input.message, 'gitCommitRecord.message');
	contractNonEmptyString(input.authorName, 'gitCommitRecord.authorName');
	contractNonEmptyString(input.authorEmail, 'gitCommitRecord.authorEmail');
	if (typeof input.committedAt !== 'string' || Number.isNaN(Date.parse(input.committedAt))) {
		failContract('gitCommitRecord.committedAt must be an ISO timestamp');
	}
	const cloned: unknown = structuredClone(input);
	return Object.freeze(cloned as GitCommitRecord);
}

export function validatePullRequestRecord(input: unknown): Readonly<PullRequestRecord> {
	const keys = [
		'schemaVersion',
		'runId',
		'prUrl',
		'prNumber',
		'draft',
		'branchName',
		'baseBranch',
		'createdAt',
	];
	assertClosedContract(input, keys, 'pullRequestRecord');
	if (input.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
		failContract('Unsupported pullRequestRecord schemaVersion');
	}
	validateRunId(input.runId);
	const prUrl = contractNonEmptyString(input.prUrl, 'pullRequestRecord.prUrl');
	if (!prUrl.startsWith('http://') && !prUrl.startsWith('https://')) {
		failContract('pullRequestRecord.prUrl must be a valid HTTP or HTTPS URL');
	}
	if (!Number.isSafeInteger(input.prNumber) || (input.prNumber as number) <= 0) {
		failContract('pullRequestRecord.prNumber must be a positive integer');
	}
	if (typeof input.draft !== 'boolean') {
		failContract('pullRequestRecord.draft must be a boolean');
	}
	contractNonEmptyString(input.branchName, 'pullRequestRecord.branchName');
	contractNonEmptyString(input.baseBranch, 'pullRequestRecord.baseBranch');
	if (typeof input.createdAt !== 'string' || Number.isNaN(Date.parse(input.createdAt))) {
		failContract('pullRequestRecord.createdAt must be an ISO timestamp');
	}
	const cloned: unknown = structuredClone(input);
	return Object.freeze(cloned as PullRequestRecord);
}
