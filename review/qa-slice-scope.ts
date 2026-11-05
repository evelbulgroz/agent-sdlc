import type { EvidenceObligation } from '../policy/contracts/quality-schema.ts';

export interface QaReviewScope {
	readonly specSummary: string;
	readonly acceptanceCriteria: readonly string[];
}

// A non-final checkpoint is reviewed against its own obligations only: the full goal would make the
// critic fault behaviour that later slices implement.
export function qaReviewScope(
	goal: string,
	checkpointKind: string,
	obligations: readonly EvidenceObligation[],
): QaReviewScope {
	const ids = [...new Set(obligations.map((obligation) => obligation.criterionId))];
	if (checkpointKind === 'final') return { specSummary: goal, acceptanceCriteria: ids };
	const lines = obligations.map((obligation) =>
		`- ${obligation.caseId ?? obligation.criterionId}: ${obligation.observableOutcome} ` +
		`(setup: ${obligation.setupAction}; expected: ${obligation.expectedResult})`);
	return {
		specSummary: [
			`Scoped ${checkpointKind} checkpoint. Review ONLY the obligations below.`,
			'Other slices and criteria of the overall goal are implemented and reviewed at their own checkpoints;',
			'their absence here is not a finding.',
			'',
			...lines,
		].join('\n'),
		acceptanceCriteria: ids,
	};
}
