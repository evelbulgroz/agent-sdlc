import type { StaleOracleCitationFinding, UncitedTouchedTestFinding } from './ac-coverage.ts';

export interface CoverageAdvisorySource {
	readonly coveragePass?: boolean | null;
	readonly pass?: boolean | null;
	readonly emptyAssertFiles?: readonly string[];
	readonly uncitedTouchedTests?: readonly UncitedTouchedTestFinding[];
	readonly staleOracleCitations?: readonly StaleOracleCitationFinding[];
	readonly uncoveredAcIds?: readonly string[];
}

export interface CoverageAdvisory {
	readonly emptyAssertFiles: readonly string[];
	readonly uncitedTouchedTests: readonly UncitedTouchedTestFinding[];
	readonly staleOracleCitations: readonly StaleOracleCitationFinding[];
	readonly coveragePass: boolean | null;
	readonly uncoveredAcIds: readonly string[];
}

/**
 * Operator-facing acceptance-coverage fields.
 * `pass` is the coverage artifact. `coveragePass` is the graph event payload.
 * A missing boolean stays null so an older event is not reported as a failure.
 */
export function coverageAdvisoryFromSource(source: unknown): CoverageAdvisory | null {
	if (!source || typeof source !== 'object') return null;
	const src = source as CoverageAdvisorySource;
	const coveragePass =
		typeof src.coveragePass === 'boolean'
			? src.coveragePass
			: typeof src.pass === 'boolean'
				? src.pass
				: null;
	return {
		emptyAssertFiles: src.emptyAssertFiles ?? [],
		uncitedTouchedTests: src.uncitedTouchedTests ?? [],
		staleOracleCitations: src.staleOracleCitations ?? [],
		coveragePass,
		uncoveredAcIds: Array.isArray(src.uncoveredAcIds) ? src.uncoveredAcIds : [],
	};
}

export function acceptanceCoverageMissText(
	coverageAdvisories: CoverageAdvisorySource | null | undefined,
): string | null {
	if (coverageAdvisories?.coveragePass !== false) return null;
	const ids = Array.isArray(coverageAdvisories.uncoveredAcIds)
		? coverageAdvisories.uncoveredAcIds.filter(
				(id): id is string => typeof id === 'string' && id.length > 0,
			)
		: [];
	return ids.length > 0
		? `Acceptance coverage did not pass: ${ids.join(', ')}`
		: 'Acceptance coverage did not pass.';
}
