export interface ContinuationLike {
	action?: string | null;
	reason?: string | null;
}

export interface StateBearingResult {
	state?: string | null;
	continuation?: ContinuationLike | null;
}

/**
 * Process exit for a continuation packet. The host card and the CLI share
 * this mapping so hostInvocation.exitCode is the exit the process returns.
 * An unrecognized action returns null and the caller falls back.
 */
export function exitCodeForContinuation(
	continuation: ContinuationLike | null | undefined,
	state?: StateBearingResult | null,
): number | null {
	if (!continuation) return null;
	const action = continuation.action;
	const reason = continuation.reason;
	if (action === 'authorize' || action === 'answer') return 2;
	if (action === 'resume') return 3;
	if (action === 'stop') {
		if (reason === 'GIT_APPROVAL' || reason === 'COMPLETE') return 0;
		if (state?.state === 'CANCELLED' || state?.state === 'SPEC_REJECTED') return 4;
		return 3;
	}
	return null;
}

export function exitCodeForResult(result: StateBearingResult | null | undefined): number {
	if (!result) return 0;
	if (result.state === 'HELP') return 0;
	if (result.continuation) {
		const code = exitCodeForContinuation(result.continuation, result);
		if (code !== null) return code;
	}
	return exitCodeForState(result.state);
}

export function exitCodeForState(state: string | null | undefined): number {
	if (state === 'HELP') return 0;
	if (
		typeof state === 'string' &&
		[
			'WAITING_FOR_ANSWERS',
			'WAITING_FOR_APPROVAL',
			'WAITING_FOR_AUTHORIZATION',
			'WAITING_FOR_PLAN_ACCEPTANCE',
			'SPEC_APPROVED',
		].includes(state)
	) {
		return 2;
	}
	if (typeof state === 'string' && ['BLOCKED', 'BUDGET_EXHAUSTED', 'ESCALATED', 'FAILED'].includes(state)) {
		return 3;
	}
	if (typeof state === 'string' && ['CANCELLED', 'SPEC_REJECTED'].includes(state)) return 4;
	return 0;
}
