import type { AttemptOutcome } from './minimal-executor.ts';

const MAX_SUMMARY_LENGTH = 500;

export const FILE_MODIFIED_FEEDBACK =
	'Previous check reported an issue, and a file has since been modified. Once your edits and test runs pass, emit {"kind":"complete","summary":"..."} to re-verify.';

/** Carries the implementer's final `complete` summary onto a failed result so an operator can see why it stopped. */
export function withLastSummary(outcome: AttemptOutcome, summary: unknown): AttemptOutcome {
	if (!outcome.done || outcome.result.status !== 'failed') return outcome;
	if (typeof summary !== 'string' || summary.trim() === '') return outcome;
	return { ...outcome, result: { ...outcome.result, lastSummary: summary.trim().slice(0, MAX_SUMMARY_LENGTH) } };
}
