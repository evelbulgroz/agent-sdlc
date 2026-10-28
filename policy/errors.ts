export const SDLC_ERROR_CODES = Object.freeze([
	'INVALID_INPUT',
	'INVALID_CONTRACT',
	'INVALID_TRANSITION',
	'PATH_OUTSIDE_ROOT',
	'RUN_NOT_FOUND',
	'RUN_ALREADY_EXISTS',
	'STALE_RESPONSE',
	'STALE_FILE_SNAPSHOT',
	'INTERRUPT_RESOLVED',
	'GOVERNOR_UNAVAILABLE',
	'GOVERNOR_BUDGET_DENIED',
	'GOVERNOR_CONCURRENCY_DENIED',
	'GOVERNOR_ROUTES_EXHAUSTED',
	'GOVERNOR_RUN_DEADLINE_EXPIRED',
	'MODEL_OUTPUT_INVALID',
	'AUTHORIZATION_INVALID',
	'AUTHORIZATION_EXPIRED',
	'PATH_CONTAINMENT_VIOLATION',
	'WORKTREE_DIRTY',
	'WORKTREE_FAILED',
	'HYDRATION_FAILED',
	'PREFLIGHT_FAILED',
	'REPAIR_BUDGET_EXCEEDED',
	'HIGH_RISK_PATH_VIOLATION',
	'STORE_BUSY',
	'STORE_CORRUPT',
	'STORE_VERSION_UNSUPPORTED',
	'STORE_RECONCILIATION_FAILED',
	'ARTIFACT_CORRUPT',
	'PROJECTION_DRIFT',
	'RUN_CANCELLED',
	'RUN_REJECTED',
	'INVALID_DECISION_RULE',
	'BRANCH_ALREADY_EXISTS',
	'BRANCH_ALREADY_CHECKED_OUT',
	'AUTHOR_VENDOR_UNKNOWN',
	'IDENTICAL_REVIEWER_VENDOR',
	'CRITIC_REVIEW_FAILED',
	'INPUT_OVERSIZED',
	'ROLE_EXECUTION_FAILED',
	'GIT_COMMIT_FAILED',
	'POLICY_VIOLATION',
	'TASK_PLAN_INVALID',
	'TASK_DECOMPOSITION_REQUIRED',
	'CANARY_REQUIRED',
	'CANARY_STALE',
	'RECONCILIATION_CONFLICT',
	'TASK_EXECUTION_FAILED',
	'OPERATION_NOT_PERMITTED',
	'BUDGET_EXHAUSTED',
	'SDLC_CONTAINMENT_VIOLATION',
	'ORACLE_PATH_MODIFICATION_PROHIBITED',
	'INTERRUPTED',
	'CAPACITY_LIMIT_EXCEEDED',
	'INTERNAL_ERROR',
] as const);

export type SdlcErrorCode = (typeof SDLC_ERROR_CODES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(SDLC_ERROR_CODES);

function isSdlcErrorCode(code: unknown): code is SdlcErrorCode {
	return typeof code === 'string' && ERROR_CODE_SET.has(code);
}

export const GOVERNOR_RECOVERABLE_CODES = Object.freeze([
	'GOVERNOR_UNAVAILABLE',
	'GOVERNOR_BUDGET_DENIED',
	'GOVERNOR_CONCURRENCY_DENIED',
	'GOVERNOR_ROUTES_EXHAUSTED',
	'GOVERNOR_RUN_DEADLINE_EXPIRED',
	'BUDGET_EXHAUSTED',
] as const);

export type GovernorRecoverableCode = (typeof GOVERNOR_RECOVERABLE_CODES)[number];

const GOVERNOR_RECOVERABLE_SET: ReadonlySet<string> = new Set<string>(GOVERNOR_RECOVERABLE_CODES);

export function isGovernorRecoverableError(error: unknown): boolean {
	if (!error || typeof error !== 'object' || !('code' in error)) return false;
	return typeof error.code === 'string' && GOVERNOR_RECOVERABLE_SET.has(error.code);
}

export type SafeMetadataValue =
	| null
	| string
	| boolean
	| number
	| SafeMetadataValue[]
	| { [key: string]: SafeMetadataValue };

export type SafeMetadata = Record<string, SafeMetadataValue>;

export interface SdlcErrorJson {
	schemaVersion: '1.0.0';
	name: string;
	code: SdlcErrorCode;
	message: string;
	metadata: SafeMetadata;
}

export class SdlcError extends Error {
	readonly code: SdlcErrorCode;
	readonly metadata: Readonly<SafeMetadata>;

	constructor(
		code: SdlcErrorCode | string,
		message?: unknown,
		metadata: unknown = {},
		options: ErrorOptions = {},
	) {
		if (!isSdlcErrorCode(code)) {
			throw new TypeError(`Unsupported SDLC error code: ${String(code)}`);
		}
		super(String(message || code), options);
		this.name = 'SdlcError';
		this.code = code;
		this.metadata = Object.freeze(copySafeMetadata(metadata));
	}

	toJSON(): SdlcErrorJson {
		return {
			schemaVersion: '1.0.0',
			name: this.name,
			code: this.code,
			message: this.message,
			metadata: { ...this.metadata },
		};
	}
}

function copySafeMetadata(metadata: unknown): SafeMetadata {
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
	const safe: SafeMetadata = {};
	for (const [key, value] of Object.entries(metadata)) {
		const copied = copySafeMetadataValue(value);
		if (copied !== undefined) safe[key] = copied;
	}
	return safe;
}

function copySafeMetadataValue(value: unknown): SafeMetadataValue | undefined {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean' ||
		(typeof value === 'number' && Number.isSafeInteger(value) && Number.isFinite(value))
	) {
		return value;
	}
	if (Array.isArray(value)) {
		const items: SafeMetadataValue[] = [];
		for (const entry of value) {
			const copied = copySafeMetadataValue(entry);
			if (copied !== undefined) items.push(copied);
		}
		return items;
	}
	if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
		const safe: { [key: string]: SafeMetadataValue } = {};
		for (const [key, entry] of Object.entries(value)) {
			const copied = copySafeMetadataValue(entry);
			if (copied !== undefined) safe[key] = copied;
		}
		return safe;
	}
	return undefined;
}

export function asSdlcError(
	error: unknown,
	fallbackCode: SdlcErrorCode | string = 'INTERNAL_ERROR',
	fallbackMessage?: unknown,
): SdlcError {
	if (error instanceof SdlcError) return error;
	const errorMessage =
		error && typeof error === 'object' && 'message' in error ? error.message : undefined;
	return new SdlcError(
		fallbackCode,
		fallbackMessage ?? errorMessage ?? 'Unexpected SDLC runtime failure',
		{},
		{ cause: error },
	);
}

const EXIT_64_CODES: ReadonlySet<string> = new Set<string>([
	'INVALID_INPUT',
	'INVALID_CONTRACT',
	'INVALID_TRANSITION',
	'PATH_OUTSIDE_ROOT',
	'RUN_NOT_FOUND',
	'RUN_ALREADY_EXISTS',
	'STALE_RESPONSE',
	'INTERRUPT_RESOLVED',
	'MODEL_OUTPUT_INVALID',
	'AUTHORIZATION_INVALID',
	'AUTHORIZATION_EXPIRED',
	'PATH_CONTAINMENT_VIOLATION',
	'SDLC_CONTAINMENT_VIOLATION',
	'ORACLE_PATH_MODIFICATION_PROHIBITED',
	'HIGH_RISK_PATH_VIOLATION',
	'CAPACITY_LIMIT_EXCEEDED',
	'TASK_PLAN_INVALID',
	'TASK_DECOMPOSITION_REQUIRED',
	'CANARY_REQUIRED',
	'CANARY_STALE',
]);

const EXIT_3_CODES: ReadonlySet<string> = new Set<string>([
	'GOVERNOR_UNAVAILABLE',
	'GOVERNOR_BUDGET_DENIED',
	'GOVERNOR_CONCURRENCY_DENIED',
	'GOVERNOR_ROUTES_EXHAUSTED',
	'GOVERNOR_RUN_DEADLINE_EXPIRED',
]);

export function exitCodeForError(error: unknown): number {
	const code: SdlcErrorCode = error instanceof SdlcError ? error.code : 'INTERNAL_ERROR';
	if (EXIT_64_CODES.has(code)) {
		return 64;
	}
	if (EXIT_3_CODES.has(code)) {
		return 3;
	}
	if (code === 'RUN_CANCELLED' || code === 'RUN_REJECTED') return 4;
	if (code === 'INTERRUPTED') return 130;
	return 70;
}
