import { z } from 'zod';
import { HASH_PATTERN, GIT_SHA, IDENTIFIER_PATTERN, RUN_ID_PATTERN } from './primitives.ts';

export const QUALITY_POLICY_SCHEMA_VERSION = '1.0.0';
export const QUALITY_RECORD_SCHEMA_VERSION = '1.0.0';
export const QUALITY_POLICY_ID = 'checkpoint-evidence-v1';

export const Id = z.string().regex(IDENTIFIER_PATTERN);
export const Hash = z.string().regex(HASH_PATTERN);
export const Tree = z.string().regex(GIT_SHA);
export const Time = z.string().datetime();
export const PosInt = z.number().int().positive();
export const NonNegativeInt = z.number().int().nonnegative();
export const Layer = z.enum(['unit', 'integration', 'browser', 'static']);
export const Capability = z.enum(['native-browser', 'native-file-picker', 'focus-navigation', 'static-check']);
export const Outcome = z.enum(['passed', 'failed', 'skipped', 'incomplete']);
export const RelPath = z.string().min(1).refine((value) =>
	!value.startsWith('/') && !value.includes('\\') && !value.includes('\0') &&
	! /^[A-Za-z]:/.test(value) && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'));
export const UniqueStrings = <T extends z.ZodType>(schema: T) => z.array(schema).superRefine((items, ctx) => {
	if (new Set(items).size !== items.length) ctx.addIssue({ code: 'custom', message: 'items must be unique' });
});
export const FileHash = z.strictObject({ path: RelPath, sha256: Hash });
export const RetrievalPolicySchema = z.strictObject({
	maxPacketBytes: z.literal(24_576),
	maxPacketLines: z.literal(1_000),
	maxTotalBytesPerCandidate: z.literal(49_152),
	maxTotalLinesPerCandidate: z.literal(2_000),
});

export const QualityPolicySchema = z.strictObject({
	schemaVersion: z.literal(QUALITY_POLICY_SCHEMA_VERSION),
	policyId: z.literal(QUALITY_POLICY_ID),
	additionalCandidateReviews: z.number().int().min(0).max(2),
	followUpDispatches: NonNegativeInt,
	testRetryPolicy: z.literal('clean-success'),
	retrieval: RetrievalPolicySchema,
	execution: z.strictObject({ maxInvocations: PosInt, maxTotalDurationMs: PosInt }),
	review: z.strictObject({
		maxLogicalDispatches: PosInt, maxPhysicalCalls: PosInt, maxInputTokens: PosInt, maxOutputTokens: PosInt,
	}),
});
export type QualityPolicy = z.infer<typeof QualityPolicySchema>;
