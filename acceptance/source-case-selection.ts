import type { EvidenceRequest } from '../policy/contracts/quality-evidence-schema.ts';
import { RelPath } from '../policy/contracts/quality-primitives.ts';
import { EvidenceReportError } from './report-formats.ts';
import type { CaseResult, CaseRow, SourceCaseIdentity } from './report-formats.ts';

export const sourceCaseKey = ({ file, criterionId, caseId }: SourceCaseIdentity): string =>
	`${file}\0${criterionId}\0${caseId}`;

/** Selectors come from obligations, never from a case-only projection of the request. */
export function selectedSourceCaseIdentities(request: Pick<EvidenceRequest, 'obligations'>): SourceCaseIdentity[] {
	const selected = new Map<string, SourceCaseIdentity>();
	for (const obligation of request.obligations) {
		if (obligation.caseId === null || !obligation.caseId.startsWith(`${obligation.criterionId}.`) ||
			obligation.testCases.length === 0) throw new Error('invalid-evidence');
		for (const testCase of obligation.testCases) {
			if (!RelPath.safeParse(testCase.file).success) throw new Error('invalid-evidence');
			const source = { file: testCase.file, criterionId: obligation.criterionId, caseId: obligation.caseId };
			selected.set(sourceCaseKey(source), source);
		}
	}
	return [...selected.values()];
}

const caseTags = (name: string): string[] =>
	[...new Set([...name.matchAll(/(?:^|\s)@case (AC-\d+\.\d+)(?=\s|$)/g)].map((match) => match[1]))];

function observedSource(row: CaseRow): SourceCaseIdentity | null {
	const cases = caseTags(row.name);
	const criteria = [...new Set([...row.name.matchAll(/(?:^|\s)@ac (AC-\d{2,})(?=\s|$)/g)].map((match) => match[1]))];
	if (cases.length !== 1 || criteria.length !== 1 || !RelPath.safeParse(row.file).success) return null;
	return { file: row.file as string, criterionId: criteria[0], caseId: cases[0] };
}

/** Reconcile the entire report before filtering; only duplicates of the requested tuple count as attempts. */
export function selectSourceCases({ rows, selected, exitCode, retries = 0 }: {
	rows: readonly CaseRow[]; selected: readonly SourceCaseIdentity[]; exitCode: number | null; retries?: number;
}): CaseResult[] {
	if (!rows.length || !selected.length) throw new EvidenceReportError('REPORT_ZERO_CASES');
	const failing = rows.some((row) => row.outcome === 'failed' || row.outcome === 'error');
	if ((exitCode === 0) === failing) {
		throw new EvidenceReportError('REPORT_EXIT_CONTRADICTION', `exit ${exitCode}, failing rows ${failing}`);
	}
	const observed = rows.map((row) => ({ row, source: observedSource(row), tags: caseTags(row.name) }));
	return selected.map((target) => {
		const key = sourceCaseKey(target);
		const matched = observed.filter((entry) => entry.source && sourceCaseKey(entry.source) === key);
		if (!matched.length) {
			if (observed.some((entry) => entry.tags.includes(target.caseId))) {
				throw new EvidenceReportError('REPORT_SOURCE_MISMATCH', key);
			}
			return { identity: target.caseId, source: target, outcome: 'not-run', message: '', attempts: 0 };
		}
		if (matched.length > retries + 1) throw new EvidenceReportError('REPORT_DUPLICATE_IDENTITY', key);
		const { row, source } = matched[matched.length - 1];
		return {
			identity: target.caseId, source: source as SourceCaseIdentity,
			outcome: row.outcome === 'error' ? 'failed' : row.outcome, message: row.message, attempts: matched.length,
		};
	});
}
