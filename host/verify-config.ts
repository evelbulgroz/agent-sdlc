import { z } from 'zod';
import { SdlcError } from '../policy/errors.ts';

export const DEFAULT_VERIFY_ARGV: readonly string[] = Object.freeze(['npm', 'test']);
export const DEFAULT_VERIFY_REQUIRE: Readonly<{ status: 'OK'; canonical: true }> = Object.freeze({
	status: 'OK',
	canonical: true,
});
export const DEFAULT_VERIFY_HEAD_FIELD = 'gitHeadSha';

const NonEmptyTokenSchema = z.string().min(1);

export const VerifySchema = z.strictObject({
	argv: z.array(NonEmptyTokenSchema).min(1),
	resultPath: NonEmptyTokenSchema.optional(),
	require: z.strictObject({ status: z.literal('OK'), canonical: z.literal(true) }).optional(),
	headField: NonEmptyTokenSchema.optional(),
});

export type HostVerifyConfig = {
	argv: string[];
	resultPath?: string;
	require?: { status: 'OK'; canonical: true };
	headField?: string;
};

function invalidVerifyConfig(detail: string, metadata: Record<string, unknown> = {}): never {
	throw new SdlcError('INVALID_INPUT', `HOST_PROFILE_INVALID: ${detail}`, metadata);
}

/**
 * Validates and normalizes the host profile `verify` block across schema versions.
 *
 * - `1.2.0` requires an explicit `verify` block with `{baseSha}` in `argv`,
 *   `resultPath`, `require`, and `headField`.
 * - `1.3.0` allows omitting `verify` (defaulting to `["npm", "test"]`), allows
 *   `0` or `1` discrete `{baseSha}` placeholder in `argv`, and makes `resultPath`
 *   opt-in (defaulting `require` and `headField` when `resultPath` is provided,
 *   and rejecting `require`/`headField` when `resultPath` is omitted).
 */
export function resolveHostVerifyConfig(
	rawVerify: unknown,
	schemaVersion: string,
	checkRel?: (candidate: string | undefined, field: string, allowDot?: boolean) => void,
): HostVerifyConfig {
	if (rawVerify === undefined) {
		if (schemaVersion === '1.2.0') {
			invalidVerifyConfig("Field 'verify' is required at schemaVersion '1.2.0'", {
				fieldName: 'verify',
				schemaVersion,
			});
		}
		return { argv: [...DEFAULT_VERIFY_ARGV] };
	}

	const parsed = VerifySchema.safeParse(rawVerify);
	if (!parsed.success) {
		const issueSummary = parsed.error.issues
			.map((issue) => `verify.${issue.path.join('.') || '<root>'}: ${issue.message}`)
			.join('; ');
		invalidVerifyConfig(issueSummary);
	}

	const verify = parsed.data;
	const placeholderCount = verify.argv.filter((token) => token === '{baseSha}').length;
	const partialPlaceholder = verify.argv.some(
		(token) => token !== '{baseSha}' && token.includes('{baseSha}'),
	);

	if (schemaVersion === '1.2.0') {
		if (placeholderCount !== 1 || partialPlaceholder) {
			invalidVerifyConfig("verify.argv must contain the element '{baseSha}' exactly once", {
				argv: [...verify.argv],
			});
		}
		if (
			verify.resultPath === undefined ||
			verify.require === undefined ||
			verify.headField === undefined
		) {
			invalidVerifyConfig(
				"verify.resultPath, verify.require, and verify.headField are required at schemaVersion '1.2.0'",
				{ schemaVersion },
			);
		}
	} else if (placeholderCount > 1 || partialPlaceholder) {
		invalidVerifyConfig(
			"verify.argv may contain at most one discrete '{baseSha}' element and no partial '{baseSha}' tokens",
			{ argv: [...verify.argv] },
		);
	}

	if (verify.resultPath === undefined) {
		if (verify.require !== undefined || verify.headField !== undefined) {
			invalidVerifyConfig(
				'verify.require and verify.headField require verify.resultPath to be specified',
			);
		}
		return { argv: [...verify.argv] };
	}

	checkRel?.(verify.resultPath, 'verify.resultPath');
	return {
		argv: [...verify.argv],
		resultPath: verify.resultPath,
		require: verify.require
			? { status: verify.require.status, canonical: verify.require.canonical }
			: { ...DEFAULT_VERIFY_REQUIRE },
		headField: verify.headField ?? DEFAULT_VERIFY_HEAD_FIELD,
	};
}
