// Pure continuation decision. No status file, host card, or store I/O.
import { type ContinuationRecord, validateContinuation } from '../policy/contracts.ts';
import { isGovernorRecoverableError } from '../policy/errors.ts';

export interface ContinuationStateLike {
	state?: string | null;
	blockedReason?: string | null;
	pendingInterruptId?: string | null;
	lastError?: {
		code?: string | null;
		executionProvenFalse?: boolean | null;
		metadata?: Record<string, unknown> | null;
	} | null;
}

export function isRunDeadlineHalt(state: ContinuationStateLike | null | undefined): boolean {
	if (!state || state.state !== 'BLOCKED') return false;
	return (
		state.blockedReason === 'GOVERNOR_RUN_DEADLINE_EXPIRED' ||
		state.lastError?.code === 'GOVERNOR_RUN_DEADLINE_EXPIRED'
	);
}

export function isInfrastructureContinuation(
	state: ContinuationStateLike | null | undefined,
): boolean {
	if (!state || state.state !== 'BLOCKED') return false;
	if (isRunDeadlineHalt(state)) return false;
	if (state.blockedReason === 'HYDRATION_FAILED') return true;
	if (
		state.blockedReason === 'GOVERNOR_ROUTES_EXHAUSTED' ||
		state.lastError?.code === 'GOVERNOR_ROUTES_EXHAUSTED'
	) {
		return true;
	}
	const provenFalse = Boolean(
		state.lastError?.executionProvenFalse || state.lastError?.metadata?.executionProvenFalse,
	);
	if (!provenFalse) return false;
	const blockedReason = state.blockedReason ?? '';
	const lastErrorCode = state.lastError?.code ?? '';
	return (
		isGovernorRecoverableError(state.lastError) ||
		[
			'QUOTA_EXCEEDED',
			'RATE_LIMITED',
			'TIMEOUT',
			'TRANSPORT_ERROR',
			'GOVERNOR_UNAVAILABLE',
		].includes(blockedReason) ||
		['QUOTA_EXCEEDED', 'RATE_LIMITED', 'TIMEOUT', 'TRANSPORT_ERROR'].includes(lastErrorCode)
	);
}

export interface ContinuationInterruptLike {
	interruptId?: string;
	kind?: string | null;
	status?: string | null;
	stateHash?: string | null;
	request?: Record<string, unknown> | null;
	payload?: Record<string, unknown> | null;
	[key: string]: unknown;
}

export interface ContinuationInputs {
	authorization?: { baseCommitSha?: string | null; [key: string]: unknown } | null;
	pendingInterrupt?: ContinuationInterruptLike | null;
	continuationAttempts?: number;
}

export function computeContinuation(
	state: ContinuationStateLike | null | undefined,
	{
		authorization = null,
		pendingInterrupt = null,
		continuationAttempts = 0,
	}: ContinuationInputs = {},
): Readonly<ContinuationRecord> {
	if (!state) {
		return validateContinuation({ action: 'stop', reason: 'HALTED' });
	}

	if (state.state === 'READY_FOR_GIT_APPROVAL') {
		return validateContinuation({ action: 'stop', reason: 'GIT_APPROVAL' });
	}
	if (state.state === 'DONE') {
		return validateContinuation({ action: 'stop', reason: 'COMPLETE' });
	}

	if (state.state === 'CANCELLED' || state.state === 'SPEC_REJECTED') {
		return validateContinuation({ action: 'stop', reason: 'HALTED' });
	}

	if (state.pendingInterruptId || pendingInterrupt) {
		const kind = pendingInterrupt?.kind;
		if (kind === 'authorization' || state.state === 'WAITING_FOR_AUTHORIZATION') {
			return validateContinuation({ action: 'authorize', reason: 'AUTHORIZATION_REQUIRED' });
		}
		return validateContinuation({ action: 'answer', reason: 'HUMAN_RESPONSE_REQUIRED' });
	}

	if (state.state === 'WAITING_FOR_AUTHORIZATION') {
		return validateContinuation({ action: 'authorize', reason: 'AUTHORIZATION_REQUIRED' });
	}
	if (state.state === 'SPEC_APPROVED') {
		if (!authorization) {
			return validateContinuation({ action: 'authorize', reason: 'AUTHORIZATION_REQUIRED' });
		}
	}

	if (state.state === 'BUDGET_EXHAUSTED') {
		return validateContinuation({ action: 'stop', reason: 'HALTED' });
	}

	if (state.state === 'BLOCKED') {
		if (isInfrastructureContinuation(state)) {
			if (continuationAttempts >= 2) {
				return validateContinuation({ action: 'stop', reason: 'HALTED' });
			}
			return validateContinuation({ action: 'resume', reason: 'INFRASTRUCTURE_RETRY' });
		}
		return validateContinuation({ action: 'stop', reason: 'HALTED' });
	}

	if (state.state === 'FAILED' || state.state === 'ESCALATED') {
		return validateContinuation({ action: 'stop', reason: 'HALTED' });
	}

	return validateContinuation({ action: 'resume', reason: 'INFRASTRUCTURE_RETRY' });
}
