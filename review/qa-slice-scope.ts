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
	const lines = obligations.map((obligation) =>
		`- ${obligation.caseId ?? obligation.criterionId}: ${obligation.observableOutcome} ` +
		`(setup: ${obligation.setupAction}; expected: ${obligation.expectedResult})`);
	if (checkpointKind === 'final') {
		const narrative = lines.join('\n');
		const goalText = goal.trim();
		return {
			specSummary: goalText ? `${goalText}\n\n${narrative}` : narrative,
			acceptanceCriteria: ids,
		};
	}
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

const DUPLICATE_OBLIGATION_PROSE = ['observableOutcome', 'setupAction', 'expectedResult'];

function recordWithout(value: unknown, keys: readonly string[]): unknown {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
	const copy: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (!keys.includes(key)) copy[key] = entry;
	}
	return copy;
}

function compactCheckpointEvidence(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	return value.map((item) => recordWithout(item, DUPLICATE_OBLIGATION_PROSE));
}

function compactReceipts(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	return value.map((item) => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
		const receipt = { ...(item as Record<string, unknown>) };
		if (!Array.isArray(receipt.cases)) return receipt;
		receipt.cases = receipt.cases.map((caseResult) => recordWithout(caseResult, ['attempts']));
		return receipt;
	});
}

/** Scope text quotes every obligation. The prompt keeps each test source once and the adequacy record. */
export function promptPacketText(packetText: string, checkpointKind: string): string {
	if (packetText.trim().length === 0) return packetText;
	try {
		const parsed = JSON.parse(packetText) as Record<string, unknown>;
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return packetText;
		let changed = false;
		// Given/Then prose is already in the scope summary. Layer, required capabilities, and
		// executed-case mappings are not, so the prompt keeps that structured record.
		if (Object.hasOwn(parsed, 'checkpointEvidence')) {
			parsed.checkpointEvidence = compactCheckpointEvidence(parsed.checkpointEvidence);
			changed = true;
		}
		// Attempt timing is receipt metadata. Final review still needs outcome and exercised capabilities.
		if (checkpointKind === 'final' && Object.hasOwn(parsed, 'receipts')) {
			parsed.receipts = compactReceipts(parsed.receipts);
			changed = true;
		}
		return changed ? JSON.stringify(parsed) : packetText;
	} catch {
		return packetText;
	}
}
