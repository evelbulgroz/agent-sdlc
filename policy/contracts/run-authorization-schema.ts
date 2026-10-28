import { z } from 'zod';
import {
	GIT_SHA,
	HASH_PATTERN,
	assertClosedContract,
	assertContractObject,
	contractNonEmptyString,
	contractOptionalHash,
	contractStringArray,
	failContract,
	validateRunId,
} from './primitives.ts';
import { RUNTIME_SCHEMA_VERSION } from './runtime-vocabulary.ts';

export const AllowedOperationsSchema = z.object({
	editIsolatedWorktree: z.boolean(),
	runAllowlistedCommands: z.boolean(),
	createDetachedWorktree: z.boolean(),
	createBranch: z.boolean(),
	createLocalCommits: z.boolean(),
	push: z.boolean(),
	openPullRequest: z.boolean(),
	merge: z.boolean(),
	deploy: z.boolean(),
});
export type AllowedOperations = z.infer<typeof AllowedOperationsSchema>;

export const RunAuthorizationRecordSchema = z.object({
	schemaVersion: z.literal(RUNTIME_SCHEMA_VERSION),
	runId: z.string(),
	approvedSpecHash: z.string(),
	taskManifestHash: z.string().nullable(),
	approvedPlanPolicyHash: z.string(),
	repositoryId: z.string(),
	baseCommitSha: z.string(),
	allowedPackages: z.array(z.string()).readonly(),
	allowedPathPrefixes: z.array(z.string()).readonly(),
	allowedOperations: AllowedOperationsSchema,
	targetBranch: z.string().nullable(),
	maxSemanticRepairs: z.number().int().min(0).max(2),
	modelUsageProfile: z.string(),
	expiresAt: z.string(),
	approvedAt: z.string(),
	approvalMethod: z.string(),
});
export type RunAuthorizationRecord = z.infer<typeof RunAuthorizationRecordSchema>;
export type RunAuthorization = RunAuthorizationRecord;

export function validateRunAuthorization(input: unknown): Readonly<RunAuthorizationRecord> {
	const keys = [
		'schemaVersion',
		'runId',
		'approvedSpecHash',
		'approvedPlanPolicyHash',
		'taskManifestHash',
		'repositoryId',
		'baseCommitSha',
		'allowedPackages',
		'allowedPathPrefixes',
		'allowedOperations',
		'maxSemanticRepairs',
		'modelUsageProfile',
		'expiresAt',
		'approvedAt',
		'approvalMethod',
		'targetBranch',
	];
	assertClosedContract(input, keys, 'runAuthorization');
	if (input.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
		failContract('Unsupported runAuthorization schemaVersion');
	}
	const runId = validateRunId(input.runId);
	if (typeof input.approvedSpecHash !== 'string' || !HASH_PATTERN.test(input.approvedSpecHash)) {
		failContract('runAuthorization.approvedSpecHash is invalid');
	}
	const taskManifestHash = contractOptionalHash(
		input.taskManifestHash ?? null,
		'runAuthorization.taskManifestHash',
	);
	if (typeof input.approvedPlanPolicyHash !== 'string' || !HASH_PATTERN.test(input.approvedPlanPolicyHash)) {
		failContract('runAuthorization.approvedPlanPolicyHash is invalid');
	}
	const repositoryId = contractNonEmptyString(input.repositoryId, 'runAuthorization.repositoryId');
	if (typeof input.baseCommitSha !== 'string' || !GIT_SHA.test(input.baseCommitSha)) {
		failContract('runAuthorization.baseCommitSha must be a 40-character hex commit SHA');
	}
	const allowedPackages = contractStringArray(input.allowedPackages, 'runAuthorization.allowedPackages', {
		allowEmpty: false,
		maxItems: 64,
	});
	const allowedPathPrefixes = contractStringArray(
		input.allowedPathPrefixes,
		'runAuthorization.allowedPathPrefixes',
		{
			allowEmpty: false,
			maxItems: 64,
		},
	);
	const rawOps = assertContractObject(input.allowedOperations, 'runAuthorization.allowedOperations');
	const opKeys = [
		'editIsolatedWorktree',
		'runAllowlistedCommands',
		'createDetachedWorktree',
		'createBranch',
		'createLocalCommits',
		'push',
		'openPullRequest',
		'merge',
		'deploy',
	] as const;
	assertClosedContract(rawOps, opKeys, 'runAuthorization.allowedOperations');
	const allowedOpsRecord: Record<string, boolean> = {};
	for (const key of opKeys) {
		if (rawOps[key] !== undefined && typeof rawOps[key] !== 'boolean') {
			failContract(`runAuthorization.allowedOperations.${key} must be a boolean`);
		}
		allowedOpsRecord[key] = Boolean(rawOps[key]);
	}
	for (const forbidden of ['merge', 'deploy'] as const) {
		if (allowedOpsRecord[forbidden] === true) {
			failContract(`runAuthorization.allowedOperations.${forbidden} is forbidden`);
		}
	}
	for (const required of [
		'editIsolatedWorktree',
		'runAllowlistedCommands',
		'createDetachedWorktree',
	] as const) {
		if (allowedOpsRecord[required] !== true) {
			failContract(`runAuthorization.allowedOperations.${required} must be true`);
		}
	}
	if (allowedOpsRecord.createLocalCommits === true && allowedOpsRecord.createBranch !== true) {
		failContract('runAuthorization.allowedOperations.createLocalCommits requires createBranch: true');
	}
	if (allowedOpsRecord.push === true && allowedOpsRecord.createLocalCommits !== true) {
		failContract('runAuthorization.allowedOperations.push requires createLocalCommits: true');
	}
	if (allowedOpsRecord.openPullRequest === true && allowedOpsRecord.push !== true) {
		failContract('runAuthorization.allowedOperations.openPullRequest requires push: true');
	}
	let resolvedTargetBranch: string | null = null;
	if (input.targetBranch !== undefined && input.targetBranch !== null) {
		if (allowedOpsRecord.createBranch !== true) {
			failContract('runAuthorization.targetBranch requires allowedOperations.createBranch: true');
		}
		if (
			typeof input.targetBranch !== 'string' ||
			input.targetBranch.length === 0 ||
			input.targetBranch.length > 128 ||
			input.targetBranch.includes('..') ||
			input.targetBranch.startsWith('/') ||
			input.targetBranch.endsWith('/') ||
			input.targetBranch.endsWith('.lock')
		) {
			failContract('runAuthorization.targetBranch is not a valid branch name');
		}
		resolvedTargetBranch = input.targetBranch;
	} else if (allowedOpsRecord.createBranch === true) {
		resolvedTargetBranch = `agent-sdlc/${runId}`;
	}
	if (
		!Number.isSafeInteger(input.maxSemanticRepairs) ||
		(input.maxSemanticRepairs as number) < 0 ||
		(input.maxSemanticRepairs as number) > 2
	) {
		failContract('runAuthorization.maxSemanticRepairs must be an integer between 0 and 2');
	}
	const modelUsageProfile = contractNonEmptyString(
		input.modelUsageProfile,
		'runAuthorization.modelUsageProfile',
	);
	for (const field of ['expiresAt', 'approvedAt'] as const) {
		const tsVal = input[field];
		if (typeof tsVal !== 'string' || Number.isNaN(Date.parse(tsVal))) {
			failContract(`runAuthorization.${field} must be an ISO timestamp`);
		}
	}
	const approvalMethod = contractNonEmptyString(input.approvalMethod, 'runAuthorization.approvalMethod');
	const opsUnknown: unknown = allowedOpsRecord;
	return Object.freeze({
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		runId,
		approvedSpecHash: input.approvedSpecHash,
		taskManifestHash,
		approvedPlanPolicyHash: input.approvedPlanPolicyHash,
		repositoryId,
		baseCommitSha: input.baseCommitSha,
		allowedPackages: Object.freeze([...allowedPackages]),
		allowedPathPrefixes: Object.freeze([...allowedPathPrefixes]),
		allowedOperations: Object.freeze(opsUnknown as AllowedOperations),
		targetBranch: resolvedTargetBranch,
		maxSemanticRepairs: input.maxSemanticRepairs as number,
		modelUsageProfile,
		expiresAt: input.expiresAt as string,
		approvedAt: input.approvedAt as string,
		approvalMethod,
	});
}
