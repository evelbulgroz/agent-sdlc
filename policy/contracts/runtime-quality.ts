import { z } from 'zod';
import { QualityPolicySchema } from './quality-schema.ts';
import { GIT_SHA, HASH_PATTERN, validateOpaqueId } from './primitives.ts';

export const RuntimeQualityFieldsSchema = z.object({
	qualityPolicy: QualityPolicySchema.optional(),
	qualityCheckpointId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).optional(),
	qualityCheckpointKind: z.enum(['slice', 'final']).optional(),
	qualityCheckpointSliceId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).nullable().optional(),
	qualityCheckpointTreeSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
	qualityCheckpointBindingHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export function validateRuntimeQualityFields(
	normalized: Record<string, unknown>,
	failContract: (message: string) => never,
): void {
	if (normalized.qualityCheckpointId !== undefined) {
		validateOpaqueId(normalized.qualityCheckpointId, 'qualityCheckpointId');
	}
	if (
		normalized.qualityCheckpointKind !== undefined &&
		!['slice', 'final'].includes(String(normalized.qualityCheckpointKind))
	) {
		failContract('qualityCheckpointKind must be slice or final');
	}
	if (
		normalized.qualityCheckpointSliceId !== undefined &&
		normalized.qualityCheckpointSliceId !== null
	) {
		validateOpaqueId(normalized.qualityCheckpointSliceId, 'qualityCheckpointSliceId');
	}
	if (
		normalized.qualityCheckpointTreeSha !== undefined &&
		!GIT_SHA.test(String(normalized.qualityCheckpointTreeSha))
	) {
		failContract('qualityCheckpointTreeSha must be a 40-character tree SHA');
	}
	if (
		normalized.qualityCheckpointBindingHash !== undefined &&
		!HASH_PATTERN.test(String(normalized.qualityCheckpointBindingHash))
	) {
		failContract('qualityCheckpointBindingHash must be a SHA-256 hash');
	}
	if (normalized.qualityPolicy !== undefined) {
		const parsedPolicy = QualityPolicySchema.safeParse(normalized.qualityPolicy);
		if (!parsedPolicy.success) failContract('qualityPolicy is invalid');
		normalized.qualityPolicy = parsedPolicy.data;
	}
	const checkpointFields = [
		'qualityCheckpointId',
		'qualityCheckpointKind',
		'qualityCheckpointTreeSha',
		'qualityCheckpointBindingHash',
	] as const;
	if (checkpointFields.some((field) => normalized[field] !== undefined)) {
		if (checkpointFields.some((field) => normalized[field] === undefined)) {
			failContract('Quality checkpoint identity, kind, tree, and binding must be provided together');
		}
		if (!normalized.qualityPolicy) {
			failContract('Quality checkpoints require an explicit quality policy');
		}
		if (
			normalized.qualityCheckpointKind === 'slice' &&
			typeof normalized.qualityCheckpointSliceId !== 'string'
		) {
			failContract('Slice quality checkpoints require qualityCheckpointSliceId');
		}
		if (
			normalized.qualityCheckpointKind === 'final' &&
			normalized.qualityCheckpointSliceId != null
		) {
			failContract('Final quality checkpoints cannot name a slice');
		}
	}
}
