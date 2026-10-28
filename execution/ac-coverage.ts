import { SdlcError } from '../policy/errors.ts';
import {
	ASSERTION_RE,
	approvedAcCases,
	approvedAcIds,
	parseTestCitations,
} from './ac-citations.ts';
import {
	normalizeExecutedTitle,
	parseTestExecutionEvidence,
} from './test-execution-evidence.ts';

export interface BaselineCitationObject {
	readonly id?: string;
	readonly acIds?: readonly string[];
	readonly caseId?: string;
	readonly caseIds?: readonly string[];
	readonly file?: string;
	readonly title?: string;
}

export type BaselineCitationItem = string | BaselineCitationObject;

export interface TouchedTestFile {
	readonly path: string;
	readonly content?: unknown;
}

export interface UntouchedOracleFile {
	readonly path: string;
	readonly content?: string | null;
}

export interface EvaluateAcCoverageOptions {
	readonly acceptanceCriteria?: readonly string[];
	readonly knownAcceptanceCriteria?: readonly string[];
	readonly baselineTestCitations?: readonly BaselineCitationItem[];
	readonly touchedFiles?: readonly TouchedTestFile[];
	readonly untouchedOracleFiles?: readonly UntouchedOracleFile[];
}

export interface ParsedTestCitationRow {
	readonly file: string;
	readonly line: number;
	readonly title: string;
	readonly acIds: readonly string[];
	readonly caseIds: readonly string[];
	readonly eachCaseId?: string;
	readonly regressionId: string | null;
	readonly shadow: string | null;
	readonly hasAssertion: boolean;
	readonly oracle: boolean;
}

export interface AcCoverageError {
	readonly code: string;
	readonly message: string;
}

export interface AcCitationFinding {
	readonly file: string;
	readonly line: number;
	readonly id: string;
	readonly title: string;
}

export interface CaseCitationFinding {
	readonly file: string;
	readonly line: number;
	readonly caseId: string;
	readonly title: string;
}

export interface CaseWithoutParentFinding extends CaseCitationFinding {
	readonly parentId: string;
}

export interface MultipleCaseCitationFinding {
	readonly file: string;
	readonly line: number;
	readonly caseIds: readonly string[];
	readonly title: string;
}

export interface UncitedTouchedTestFinding {
	readonly file: string;
	readonly line: number;
	readonly title: string;
}

export interface StaleOracleCitationFinding {
	readonly file: string;
	readonly line: number;
	readonly id: string;
}

export interface AcCoverageReport {
	readonly pass: boolean;
	readonly approvedAcIds: readonly string[];
	readonly approvedCaseIds: readonly string[];
	readonly caseFreeAcIds: readonly string[];
	readonly uncoveredAcIds: readonly string[];
	readonly uncoveredCaseIds: readonly string[];
	readonly unknownCitations: readonly AcCitationFinding[];
	readonly unknownCaseCitations: readonly CaseCitationFinding[];
	readonly caseWithoutParent: readonly CaseWithoutParentFinding[];
	readonly multipleCaseCitations: readonly MultipleCaseCitationFinding[];
	readonly citeWithoutAssertion: readonly AcCitationFinding[];
	readonly caseWithoutAssertion: readonly CaseCitationFinding[];
	readonly uncitedTouchedTests: readonly UncitedTouchedTestFinding[];
	readonly emptyAssertFiles: readonly string[];
	readonly staleOracleCitations: readonly StaleOracleCitationFinding[];
	readonly rows: readonly ParsedTestCitationRow[];
	readonly errors: readonly AcCoverageError[];
}

export interface PreparsedExecutionEvidence {
	readonly format?: string | null;
	readonly passedTitles: readonly string[];
	readonly errors?: readonly AcCoverageError[];
}

export interface BoundAcCoverageReport extends Partial<AcCoverageReport> {
	readonly pass: boolean;
	readonly executionEvidenceFormat: string | null | undefined;
	readonly executedTestTitles: readonly string[];
	readonly notExecutedAcIds: readonly string[];
	readonly notExecutedCaseIds: readonly string[];
	readonly executionEvidenceErrors: readonly AcCoverageError[] | undefined;
}

export function evaluateAcCoverage({
	acceptanceCriteria = [],
	knownAcceptanceCriteria = acceptanceCriteria,
	baselineTestCitations = [],
	touchedFiles = [],
	untouchedOracleFiles = [],
}: EvaluateAcCoverageOptions = {}): Readonly<AcCoverageReport> {
	const criterionList = Array.isArray(acceptanceCriteria) ? [...acceptanceCriteria] : [];
	const knownList = Array.isArray(knownAcceptanceCriteria)
		? [...knownAcceptanceCriteria]
		: criterionList;
	const parsedIds: readonly string[] = approvedAcIds(criterionList);
	const parsedCases: readonly { id: string; description: string }[] = approvedAcCases(criterionList);
	const knownIds: readonly string[] = approvedAcIds(knownList);
	const knownCases: readonly { id: string; description: string }[] = approvedAcCases(knownList);
	const baselineIds = new Set<string>();
	const baselineCases = new Map<string, string>();
	for (const item of baselineTestCitations) {
		if (typeof item === 'string') {
			baselineIds.add(item);
		} else if (item && typeof item === 'object') {
			for (const id of item.acIds ?? (item.id ? [item.id] : [])) {
				baselineIds.add(id);
			}
			for (const caseId of item.caseIds ?? (item.caseId ? [item.caseId] : [])) {
				const parent = caseId.slice(0, caseId.lastIndexOf('.'));
				baselineCases.set(caseId, parent);
			}
		}
	}
	// A citation that already sits in a base test file belongs to an older
	// feature that reused the same AC id. It cannot prove the approved criteria.
	const baselineTests = new Set<string>();
	for (const item of baselineTestCitations) {
		if (item && typeof item === 'object' && item.file && item.title) {
			baselineTests.add(`${item.file}\u0000${item.title}`);
		}
	}
	const errors: AcCoverageError[] = [];
	if (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.length === 0) {
		errors.push(
			Object.freeze({
				code: 'EMPTY',
				message: 'acceptanceCriteria is empty',
			}),
		);
	} else if (parsedIds.length === 0) {
		errors.push(
			Object.freeze({
				code: 'INVALID_GRAMMAR',
				message: 'No grammatical AC-NN Given/Then criteria are available',
			}),
		);
	}
	const approved = new Set<string>([...parsedIds, ...knownIds, ...baselineIds]);
	const approvedCases = new Map<string, string>([
		...baselineCases,
		...[...knownCases, ...parsedCases].map((oracleCase): [string, string] => [
			oracleCase.id,
			oracleCase.id.slice(0, oracleCase.id.lastIndexOf('.')),
		]),
	]);
	const parentsWithCases = new Set<string>(
		[...parsedCases, ...knownCases].map((oracleCase) =>
			oracleCase.id.slice(0, oracleCase.id.lastIndexOf('.')),
		),
	);
	for (const caseId of baselineCases.keys()) {
		parentsWithCases.add(caseId.slice(0, caseId.lastIndexOf('.')));
	}
	const caseFreeAcIds = parsedIds.filter((id) => !parentsWithCases.has(id));
	const caseFreeSet = new Set<string>(
		[...parsedIds, ...knownIds].filter((id) => !parentsWithCases.has(id)),
	);
	const covered = new Set<string>();
	const coveredCases = new Set<string>();
	const unknownCitations: AcCitationFinding[] = [];
	const unknownCaseCitations: CaseCitationFinding[] = [];
	const caseWithoutParent: CaseWithoutParentFinding[] = [];
	const multipleCaseCitations: MultipleCaseCitationFinding[] = [];
	const caseWithoutAssertion: CaseCitationFinding[] = [];
	const citeWithoutAssertion: AcCitationFinding[] = [];
	const uncitedTouchedTests: UncitedTouchedTestFinding[] = [];
	const emptyAssertFiles: string[] = [];
	const rows: ParsedTestCitationRow[] = [];

	for (const file of touchedFiles) {
		const filePath = file.path;
		const source = file.content;
		if (typeof source !== 'string') {
			throw new SdlcError('INVALID_INPUT', `Touched test content is missing for '${filePath}'`);
		}
		const tests: readonly ParsedTestCitationRow[] = parseTestCitations(source, filePath);
		const fileHasAc = tests.some((test) => test.acIds.length > 0);
		const fileHasAssertion = ASSERTION_RE.test(source);
		if (!fileHasAssertion && !fileHasAc) emptyAssertFiles.push(filePath);
		if (tests.length === 0 && fileHasAc === false && !fileHasAssertion) {
			if (!emptyAssertFiles.includes(filePath)) emptyAssertFiles.push(filePath);
		}
		for (const test of tests) {
			rows.push(test);
			if (
				baselineTests.has(
					`${test.file}\u0000${test.title}${test.eachCaseId ? `\u0000${test.eachCaseId}` : ''}`,
				) ||
				(!test.eachCaseId && baselineTests.has(`${test.file}\u0000${test.title}`))
			) {
				continue;
			}
			const uniqueIds = test.acIds;
			const caseIds = test.caseIds.filter((caseId) => {
				const parentId = caseId.slice(0, caseId.lastIndexOf('.'));
				return !(caseFreeSet.has(parentId) && uniqueIds.includes(parentId));
			});
			if (uniqueIds.length === 0 && !test.regressionId) {
				uncitedTouchedTests.push(
					Object.freeze({ file: test.file, line: test.line, title: test.title }),
				);
			}
			for (const id of uniqueIds) {
				if (!approved.has(id)) {
					unknownCitations.push(
						Object.freeze({ file: test.file, line: test.line, id, title: test.title }),
					);
					continue;
				}
				covered.add(id);
				if (!test.hasAssertion) {
					citeWithoutAssertion.push(
						Object.freeze({ file: test.file, line: test.line, id, title: test.title }),
					);
				}
			}
			if (caseIds.length > 1) {
				multipleCaseCitations.push(
					Object.freeze({
						file: test.file,
						line: test.line,
						caseIds: Object.freeze(caseIds),
						title: test.title,
					}),
				);
			}
			for (const caseId of caseIds) {
				const parentId = approvedCases.get(caseId);
				if (!parentId) {
					unknownCaseCitations.push(
						Object.freeze({
							file: test.file,
							line: test.line,
							caseId,
							title: test.title,
						}),
					);
					continue;
				}
				if (!uniqueIds.includes(parentId)) {
					caseWithoutParent.push(
						Object.freeze({
							file: test.file,
							line: test.line,
							caseId,
							parentId,
							title: test.title,
						}),
					);
					continue;
				}
				if (!test.hasAssertion) {
					caseWithoutAssertion.push(
						Object.freeze({
							file: test.file,
							line: test.line,
							caseId,
							title: test.title,
						}),
					);
					continue;
				}
				if (caseIds.length === 1) coveredCases.add(caseId);
			}
		}
	}

	const staleOracleCitations: StaleOracleCitationFinding[] = [];
	for (const file of untouchedOracleFiles) {
		const tests: readonly ParsedTestCitationRow[] = parseTestCitations(file.content ?? '', file.path);
		for (const test of tests) {
			for (const id of test.acIds) {
				if (!approved.has(id)) {
					staleOracleCitations.push(
						Object.freeze({ file: test.file, line: test.line, id }),
					);
				}
			}
		}
	}

	const uncoveredAcIds = parsedIds.filter((id) => !covered.has(id));
	const uncoveredCaseIds = parsedCases
		.map((oracleCase) => oracleCase.id)
		.filter((id) => !coveredCases.has(id));
	const pass =
		errors.length === 0 &&
		uncoveredAcIds.length === 0 &&
		uncoveredCaseIds.length === 0 &&
		unknownCitations.length === 0 &&
		unknownCaseCitations.length === 0 &&
		caseWithoutParent.length === 0 &&
		multipleCaseCitations.length === 0 &&
		citeWithoutAssertion.length === 0 &&
		caseWithoutAssertion.length === 0;

	return Object.freeze({
		pass,
		approvedAcIds: Object.freeze(parsedIds),
		approvedCaseIds: Object.freeze(parsedCases.map((oracleCase) => oracleCase.id)),
		caseFreeAcIds: Object.freeze(caseFreeAcIds),
		uncoveredAcIds: Object.freeze(uncoveredAcIds),
		uncoveredCaseIds: Object.freeze(uncoveredCaseIds),
		unknownCitations: Object.freeze(unknownCitations),
		unknownCaseCitations: Object.freeze(unknownCaseCitations),
		caseWithoutParent: Object.freeze(caseWithoutParent),
		multipleCaseCitations: Object.freeze(multipleCaseCitations),
		citeWithoutAssertion: Object.freeze(citeWithoutAssertion),
		caseWithoutAssertion: Object.freeze(caseWithoutAssertion),
		uncitedTouchedTests: Object.freeze(uncitedTouchedTests),
		emptyAssertFiles: Object.freeze(emptyAssertFiles),
		staleOracleCitations: Object.freeze(staleOracleCitations),
		rows: Object.freeze(rows),
		errors: Object.freeze(errors),
	});
}

function isPreparsedExecutionEvidence(value: unknown): value is PreparsedExecutionEvidence {
	return (
		value !== null &&
		typeof value === 'object' &&
		'passedTitles' in value &&
		Array.isArray(value.passedTitles)
	);
}

export function bindAcCoverageToExecution(
	coverage: Partial<AcCoverageReport> | null | undefined,
	executionOutput: unknown,
): Readonly<BoundAcCoverageReport> {
	const evidence: PreparsedExecutionEvidence = isPreparsedExecutionEvidence(executionOutput)
		? executionOutput
		: parseTestExecutionEvidence(typeof executionOutput === 'string' ? executionOutput : '');
	const passedTitles = new Set<string>(evidence.passedTitles.map(normalizeExecutedTitle));
	const passedTitleList = [...passedTitles];
	const executedAcIds = new Set<string>();
	const executedCaseIds = new Set<string>();
	for (const row of coverage?.rows ?? []) {
		if (!row.hasAssertion) continue;
		const title = normalizeExecutedTitle(row.title);
		const eachCaseId = typeof row.eachCaseId === 'string' ? row.eachCaseId : '';
		const executed =
			passedTitles.has(title) ||
			(eachCaseId.length > 0 &&
				passedTitleList.some((passedTitle) => passedTitle.includes(eachCaseId)));
		if (!executed) continue;
		for (const id of row.acIds ?? []) executedAcIds.add(id);
		for (const id of row.caseIds ?? []) executedCaseIds.add(id);
	}
	const approvedIds = new Set<string>(coverage?.approvedAcIds ?? []);
	const notExecutedAcIds = [...approvedIds].filter(
		(id) =>
			!(coverage?.unknownCitations ?? []).some((item) => item.id === id) &&
			!executedAcIds.has(id),
	);
	const notExecutedCaseIds = (coverage?.approvedCaseIds ?? []).filter(
		(id) => !executedCaseIds.has(id),
	);
	const evidenceErrors = evidence.errors ?? [];
	const pass =
		coverage?.pass === true &&
		evidenceErrors.length === 0 &&
		notExecutedAcIds.length === 0 &&
		notExecutedCaseIds.length === 0;
	return Object.freeze({
		...coverage,
		pass,
		executionEvidenceFormat: evidence.format,
		executedTestTitles: evidence.passedTitles,
		notExecutedAcIds: Object.freeze(notExecutedAcIds),
		notExecutedCaseIds: Object.freeze(notExecutedCaseIds),
		executionEvidenceErrors: evidence.errors,
	});
}
