import { approvedAcCases, approvedAcIds } from '../execution/ac-citations.ts';
import type { EvidenceObligation } from '../policy/contracts/quality-schema.ts';

export type FinalObligationFailureCode =
	| 'NO_OBLIGATION'
	| 'OBLIGATION_NOT_DISCHARGED'
	| 'NO_EXECUTION_EVIDENCE';

export interface FinalObligationFailure {
	readonly code: FinalObligationFailureCode;
	readonly message: string;
}

export interface FinalReceiptEvidence {
	readonly status: string;
	readonly dischargedObligationIds: readonly string[];
}

/**
 * Every approved criterion (or each of its cases) needs an obligation that a passed
 * receipt of the current candidate discharged. Receipts are the final gate's execution evidence.
 */
export function checkFinalObligationEvidence({
	acceptanceCriteria,
	obligations,
	receipts,
}: {
	acceptanceCriteria: readonly unknown[];
	obligations: readonly EvidenceObligation[];
	receipts: readonly (FinalReceiptEvidence | null)[];
}): readonly FinalObligationFailure[] {
	const discharged = new Set(
		receipts.flatMap((receipt) => (receipt?.status === 'passed' ? receipt.dischargedObligationIds : [])),
	);
	if (discharged.size === 0) {
		return [{ code: 'NO_EXECUTION_EVIDENCE', message: 'The final candidate has no passed execution receipt' }];
	}
	const caseIds = approvedAcCases(acceptanceCriteria).map((entry) => entry.id);
	const failures: FinalObligationFailure[] = [];
	const check = (label: string, criterionId: string, caseId: string | null) => {
		const matching = obligations.filter(
			(obligation) => obligation.criterionId === criterionId && obligation.caseId === caseId,
		);
		if (matching.length === 0) {
			failures.push({ code: 'NO_OBLIGATION', message: `${label} has no evidence obligation` });
		} else if (!matching.every((obligation) => discharged.has(obligation.obligationId))) {
			failures.push({
				code: 'OBLIGATION_NOT_DISCHARGED',
				message: `${label} has an obligation no passed receipt discharged`,
			});
		}
	};
	for (const id of approvedAcIds(acceptanceCriteria)) {
		const own = caseIds.filter((caseId) => caseId.startsWith(`${id}.`));
		if (own.length === 0) check(id, id, null);
		for (const caseId of own) check(caseId, id, caseId);
	}
	return failures;
}
