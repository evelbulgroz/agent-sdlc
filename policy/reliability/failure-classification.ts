// Maps a failure code or message onto one reliability category.

import type { ReliabilityFailureCategory } from '../contracts.ts';

export const INFRASTRUCTURE_CODES: ReadonlySet<string> = new Set([
	'GOVERNOR_UNAVAILABLE',
	'GOVERNOR_BUDGET_DENIED',
	'GOVERNOR_CONCURRENCY_DENIED',
	'GOVERNOR_ROUTES_EXHAUSTED',
	'GOVERNOR_RUN_DEADLINE_EXPIRED',
	'BUDGET_EXHAUSTED',
	'INTERRUPTED',
]);

export interface FailureCandidate {
	code?: string | null;
	message?: string | null;
	error?: string | null;
	[key: string]: unknown;
}

export function classifyReliabilityFailure(
	value: FailureCandidate | string | null | undefined,
): ReliabilityFailureCategory {
	const obj = value && typeof value === 'object' ? value : null;
	const code = String(obj?.code ?? '');
	const message = String(
		obj?.message ?? obj?.error ?? value ?? '',
	).toLowerCase();
	if (
		code === 'STALE_FILE_SNAPSHOT' ||
		message.includes('stale literal') ||
		message.includes('old_string not found')
	) {
		return 'STALE_LITERAL_REPLACEMENT';
	}
	if (
		message.includes('source extension') ||
		message.includes("include '.js'")
	) {
		return 'MISSING_SOURCE_EXTENSION';
	}
	if (
		message.includes('authorized dependency range') ||
		message.includes('approved dependency range')
	) {
		return 'WRONG_AUTHORIZED_DEPENDENCY_RANGE';
	}
	if (
		message.includes('transient verification') ||
		code === 'TRANSIENT_VERIFICATION_FAILURE'
	) {
		return 'TRANSIENT_VERIFICATION_FAILURE';
	}
	if (
		message.includes('lockfile') &&
		(message.includes('direct') || message.includes('generated'))
	) {
		return 'DIRECT_LOCKFILE_MUTATION';
	}
	if (message.includes('must run') && message.includes('before completing')) {
		return 'MISSING_POST_EDIT_VERIFICATION';
	}
	if (
		message.includes('implementer did not complete') ||
		message.includes('step_limit_reached')
	) {
		return 'IMPLEMENTER_NON_COMPLETED';
	}
	if (
		message.includes('deadline') ||
		code === 'ERR_RUN_DEADLINE_EXCEEDED' ||
		code === 'ERR_RUN_DEADLINE_EXPIRED' ||
		code === 'GOVERNOR_RUN_DEADLINE_EXPIRED'
	) {
		return 'RUN_DEADLINE_EXPIRED';
	}
	if (
		message.includes('does not exist') ||
		message.includes('nonexistent source path')
	) {
		return 'NONEXISTENT_SOURCE_PATH_REPEATED';
	}
	if (
		message.includes('undeclared dependency') ||
		message.includes('not declared by the task')
	) {
		return 'UNDECLARED_DEPENDENCY_MUTATION';
	}
	if (code === 'PATH_CONTAINMENT_VIOLATION' || code === 'POLICY_VIOLATION') {
		return 'POLICY_REJECTION';
	}
	if (
		code === 'NON_SUBSTANTIVE_RECOVERY_MUTATION' ||
		code === 'TASK_EXECUTION_FAILED'
	) {
		return 'INVALID_EDIT';
	}
	if (code === 'PREFLIGHT_FAILED') return 'NONCANONICAL_PREFLIGHT';
	if (INFRASTRUCTURE_CODES.has(code)) return 'INFRASTRUCTURE_INTERRUPTION';
	if (
		code === 'REPAIR_BUDGET_EXHAUSTED' ||
		code === 'REPAIR_BUDGET_EXCEEDED' ||
		code === 'REPAIR_HUMAN_INTERVENTION_REQUIRED'
	) {
		return 'REPAIR_GATE_EXHAUSTED';
	}
	if (code === 'INVALID_CONTRACT') return 'TASK_PLAN_CONTRACT_VIOLATION';
	if (code === 'CONFIGURATION_CHANGED') return 'CONFIGURATION_DRIFT';
	if (code === 'AUTHOR_VENDOR_UNKNOWN') return 'UNSUPPORTED_AUTHOR_VENDOR';
	if (code === 'IMPLEMENTER_NON_PROGRESS') return 'IMPLEMENTER_NON_PROGRESS';
	return 'UNCLASSIFIED';
}
