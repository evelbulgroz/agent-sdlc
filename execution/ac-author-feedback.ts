import { parseAcceptanceCriterion } from '../workflow/acceptance-criteria.ts';
import type { BoundAcCoverageReport } from './ac-coverage.ts';

export interface ToolCallSnapshot {
	readonly toolName?: string;
	readonly parameters?: {
		readonly path?: unknown;
		readonly [key: string]: unknown;
	};
	readonly result?: {
		readonly written?: unknown;
		readonly error?: unknown;
		readonly code?: unknown;
		readonly [key: string]: unknown;
	};
}

export function formatAcCoverageFailure(result: Partial<BoundAcCoverageReport>): string {
	const lines = ['ac-coverage failed'];
	if ((result.uncoveredCaseIds ?? []).length > 0 || (result.notExecutedCaseIds ?? []).length > 0) {
		lines.push(
			'[case-repair] Each case id must appear as literal text in its own it/test title or it.each table row, for example it(\'@ac AC-01 @case AC-01.1 ...\'). A template such as ${caseId} does not cover that case.',
		);
	}
	if (
		(result.caseWithoutAssertion ?? []).length > 0 ||
		(result.citeWithoutAssertion ?? []).length > 0
	) {
		lines.push(
			'[assertion-repair] The it/test body must contain a direct expect( call. A helper that calls expect does not count. Paste expect( into each listed it() callback. Do not re-read a file that was already read in full.',
		);
	}
	for (const error of result.errors ?? []) {
		lines.push(`[error] ${error.message}`);
	}
	for (const id of result.uncoveredAcIds ?? []) {
		lines.push(`[uncovered] ${id}`);
	}
	for (const id of result.uncoveredCaseIds ?? []) {
		lines.push(`[uncovered-case] ${id}`);
	}
	const uncitedByFile = new Map<string, number>();
	for (const row of result.rows ?? []) {
		if (typeof row?.title !== 'string' || !row.title.includes('${')) continue;
		if (!/@ac\b|@case\b/.test(row.title)) continue;
		lines.push(`[template-case] ${row.file}:${row.line}`);
	}
	// pwa-session-metric-strip-r43 step 74: uncovered cases and no template,
	// uncited row, or file. The summary named no path, coverage repair
	// returned null, and the wide schema still offered read_file.
	if ((result.uncoveredCaseIds ?? []).length > 0) {
		const files: string[] = [];
		for (const row of result.rows ?? []) {
			if (typeof row?.file !== 'string') continue;
			if (!/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(row.file)) continue;
			if (!files.includes(row.file)) files.push(row.file);
		}
		for (const file of files) lines.push(`[coverage-file] ${file}`);
	}
	for (const item of result.uncitedTouchedTests ?? []) {
		uncitedByFile.set(item.file, (uncitedByFile.get(item.file) ?? 0) + 1);
	}
	for (const [file, count] of uncitedByFile) {
		lines.push(
			`[uncited-existing] ${file} ${count} existing tests have no @ac citation. They do not block completion. Add new it() tests for the uncovered ids. Do not add @ac to those existing tests.`,
		);
	}
	for (const item of result.unknownCitations ?? []) {
		lines.push(`[unknown] ${item.file}:${item.line} ${item.id}`);
	}
	for (const item of result.citeWithoutAssertion ?? []) {
		lines.push(`[cite-without-assertion] ${item.file}:${item.line} ${item.id}`);
	}
	for (const item of result.unknownCaseCitations ?? []) {
		lines.push(`[unknown-case] ${item.file}:${item.line} ${item.caseId}`);
	}
	for (const item of result.caseWithoutParent ?? []) {
		lines.push(
			`[case-without-parent] ${item.file}:${item.line} test title requires both @ac ${item.parentId} and @case ${item.caseId} (or @ac ${item.parentId} on an enclosing describe block)`,
		);
	}
	if ((result.caseWithoutParent ?? []).length > 0) {
		lines.push(
			'[case-without-parent-repair] Add @ac to the enclosing describe block or edit the individual it/test titles. First read_file the target, then call replace_in_file with path, exact literal old_string copied from that read, new_string containing the required @ac and @case pair, and expected_file_hash from that read.',
		);
	}
	for (const item of result.multipleCaseCitations ?? []) {
		lines.push(`[multiple-cases] ${item.file}:${item.line} ${item.caseIds.join(', ')}`);
	}
	for (const item of result.caseWithoutAssertion ?? []) {
		lines.push(`[case-without-assertion] ${item.file}:${item.line} ${item.caseId}`);
	}
	for (const id of result.notExecutedAcIds ?? []) {
		lines.push(`[not-executed] ${id}`);
	}
	for (const id of result.notExecutedCaseIds ?? []) {
		lines.push(`[not-executed-case] ${id}`);
	}
	for (const error of result.executionEvidenceErrors ?? []) {
		lines.push(`[execution-evidence] ${error.message}`);
	}
	lines.push(
		'[note] ac-coverage only re-evaluates when you emit {"kind":"complete","summary":"..."}. Once your spec edits and test runs pass, declare complete to re-run ac-coverage.',
	);
	return lines.join('\n');
}

const TEMPLATE_CITATION_WARNING = 'A template such as ${caseId} does not count.';

/**
 * Standing citation sentence for one task.
 * A parent with no cases must not be shown a @case example.
 * A parent with cases is shown its own ids, not a sample from another criterion.
 */
export function citationRule(acceptanceCriteria: unknown): string {
	if (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.length === 0) return '';
	const parsed: Array<{ id: string; cases: readonly { id: string; description: string }[] }> = [];
	for (const [index, entry] of acceptanceCriteria.entries()) {
		const item = parseAcceptanceCriterion(typeof entry === 'string' ? entry : '', index);
		if (item.ok && typeof item.id === 'string' && Array.isArray(item.cases)) {
			parsed.push({ id: item.id, cases: item.cases });
		}
	}
	if (parsed.length === 0) {
		return (
			"Cite each listed criterion as its own it('@ac AC-NN ...') (or @ac AC-NN on an enclosing describe) with a direct expect(. " +
			`Add @case only for a case id written in that criterion. ${TEMPLATE_CITATION_WARNING}`
		);
	}
	const lines: string[] = [];
	for (const item of parsed) {
		const firstCase = item.cases[0];
		if (!firstCase) {
			lines.push(
				`Cite ${item.id} as its own it('@ac ${item.id} ...') (or on an enclosing describe) with a direct expect(. ` +
					`${item.id} has no cases. Do not add @case.`,
			);
			continue;
		}
		const example = firstCase.id;
		const ids = item.cases.map((oracleCase) => oracleCase.id).join(', ');
		lines.push(
			`Each case of ${item.id} is its own it('@ac ${item.id} @case ${example} ...') (or @ac ${item.id} on an enclosing describe and @case on each it / it.each row) ` +
				`with a direct expect(. The case ids are ${ids}.`,
		);
	}
	lines.push(TEMPLATE_CITATION_WARNING);
	return lines.join('\n');
}

const MISSING_TOUCHED_TEST = /Touched test file is missing from the worktree: '([^']+)'/;

/**
 * The missing-file sentence stays until write_file reports that path.
 * A later read does not clear it, because those reads were the spin.
 * The evidence check still runs only when the model declares complete.
 */
export function verificationBlock(feedback: unknown, toolCalls?: unknown): string {
	const match = typeof feedback === 'string' ? feedback.match(MISSING_TOUCHED_TEST) : null;
	const missingPath = match?.[1];
	if (!missingPath || !writtenTouchedTest(missingPath, toolCalls)) {
		return `### Verification\n${feedback}`;
	}
	return (
		`### Verification\nPrevious check said '${missingPath}' was missing. ` +
		'A tool result has since written that file. Declare complete so the check can run again.'
	);
}

function writtenTouchedTest(filePath: string, toolCalls: unknown): boolean {
	if (!Array.isArray(toolCalls)) return false;
	return (toolCalls as readonly ToolCallSnapshot[]).some(
		(call) =>
			call?.toolName === 'write_file' &&
			call.parameters?.path === filePath &&
			call.result?.written === true &&
			call.result.error == null &&
			call.result.code == null,
	);
}
