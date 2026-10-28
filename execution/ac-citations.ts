import path from 'node:path';
import { SdlcError } from '../policy/errors.ts';
import { parseAcceptanceCriterion } from '../workflow/acceptance-criteria.ts';
import type { ParsedTestCitationRow } from './ac-coverage.ts';

const AC_TAG = /@ac\s+(AC-\d{2,})/gi;
const AC_CASE_TAG = /@case\s+(AC-\d{2,}\.[1-9]\d*)/gi;
const REGRESSION_TAG = /@regression\s+(\S+)/i;
const SHADOW_TAG = /@shadow\s+(happy|nil|empty|error)/i;
export const ASSERTION_RE = /\bexpect\s*\(|\bassert\s*\(|\bassert\./;
const TEST_CALL_RE = /\b((?:it|test)(?:\.(?:only|skip|concurrent))?)\s*\(\s*(['"`])([\s\S]*?)\2/g;
/**
 * Matches parameterized `it.each(...)('title', fn)` / `test.each(...)('title', fn)`
 * call sites (with an optional `.only`/`.skip` modifier before `.each`). The
 * table argument may itself contain one level of nested parentheses (e.g. a
 * function call), which is tolerated by the non-capturing alternation below.
 */
const TEST_EACH_CALL_RE =
	/\b(?:it|test)(?:\.(?:only|skip))?\.each\s*\(((?:[^()]|\([^()]*\))*)\)\s*\(\s*(['"`])([\s\S]*?)\2/g;
const DESCRIBE_CALL_RE =
	/\bdescribe(?:\.(?:only|skip|concurrent))?\s*\(\s*(['"`])([\s\S]*?)\1/g;
const TABLE_CASE_ID_RE = /\b(AC-\d{2,}\.[1-9]\d*)\b/g;

export interface ApprovedAcCase {
	readonly id: string;
	readonly description: string;
}

export function isOraclePath(filePath: unknown): boolean {
	if (typeof filePath !== 'string' || filePath.trim().length === 0) return false;
	const normalized = filePath.split(path.sep).join('/').replace(/^\.\//, '');
	return /\.oracle\.spec\.tsx?$/.test(normalized);
}

export function approvedAcIds(acceptanceCriteria: readonly unknown[] = []): readonly string[] {
	const ids: string[] = [];
	for (const [index, entry] of acceptanceCriteria.entries()) {
		const parsed = parseAcceptanceCriterion(entry, index);
		if (parsed.ok && typeof parsed.id === 'string') ids.push(parsed.id);
	}
	return Object.freeze(ids);
}

export function approvedAcCases(
	acceptanceCriteria: readonly unknown[] = [],
): readonly ApprovedAcCase[] {
	const cases: ApprovedAcCase[] = [];
	for (const [index, entry] of acceptanceCriteria.entries()) {
		const parsed = parseAcceptanceCriterion(entry, index);
		if (parsed.ok && Array.isArray(parsed.cases)) cases.push(...parsed.cases);
	}
	return Object.freeze(cases);
}

interface DescribeScope {
	readonly start: number;
	readonly end: number;
	readonly acIds: readonly string[];
}

function extractDescribeScopes(source: string): DescribeScope[] {
	const scopes: DescribeScope[] = [];
	DESCRIBE_CALL_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = DESCRIBE_CALL_RE.exec(source)) !== null) {
		const acIds = uniqueAcIds(match[2] ?? '');
		if (acIds.length === 0) continue;
		const afterTitle = match.index + match[0].length;
		const braceOffset = indexOfUnquoted(source.slice(afterTitle), '{');
		if (braceOffset === -1) continue;
		const openIndex = afterTitle + braceOffset;
		const body = extractBraced(source, openIndex);
		scopes.push({
			start: openIndex,
			end: openIndex + body.length,
			acIds,
		});
	}
	return scopes;
}

function extractTableCaseIds(tableSource: unknown): string[] {
	if (typeof tableSource !== 'string' || tableSource.length === 0) return [];
	const ids: string[] = [];
	const seen = new Set<string>();
	TABLE_CASE_ID_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = TABLE_CASE_ID_RE.exec(tableSource)) !== null) {
		const caseId = match[1];
		if (!caseId || seen.has(caseId)) continue;
		seen.add(caseId);
		ids.push(caseId);
	}
	return ids;
}

interface RawTestMatch {
	readonly index: number;
	readonly length: number;
	readonly tableSource: string | null;
	readonly title: string;
}

export function parseTestCitations(
	source: unknown,
	filePath = 'unknown',
): readonly ParsedTestCitationRow[] {
	if (typeof source !== 'string') {
		throw new SdlcError('INVALID_INPUT', 'Test source must be text', { filePath });
	}
	const describeScopes = extractDescribeScopes(source);
	const rawMatches: RawTestMatch[] = [];
	TEST_EACH_CALL_RE.lastIndex = 0;
	let eachMatch: RegExpExecArray | null;
	while ((eachMatch = TEST_EACH_CALL_RE.exec(source)) !== null) {
		rawMatches.push({
			index: eachMatch.index,
			length: eachMatch[0].length,
			tableSource: eachMatch[1] ?? null,
			title: eachMatch[3] ?? '',
		});
	}
	const eachRanges = rawMatches.map(({ index, length }): [number, number] => [
		index,
		index + length,
	]);
	TEST_CALL_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = TEST_CALL_RE.exec(source)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		// Skip plain it(/test( matches that are actually the tail of an
		// `.each(...)(` parameterized call site already captured above.
		if (eachRanges.some(([eachStart, eachEnd]) => start >= eachStart && end <= eachEnd)) {
			continue;
		}
		rawMatches.push({
			index: start,
			length: match[0].length,
			tableSource: null,
			title: match[3] ?? '',
		});
	}
	rawMatches.sort((a, b) => a.index - b.index);

	const tests: ParsedTestCitationRow[] = [];
	for (const { index, length, tableSource, title } of rawMatches) {
		const titleStart = index;
		const line = source.slice(0, titleStart).split('\n').length;
		const afterTitle = index + length;
		const body = extractCallbackBody(source, afterTitle);
		const inheritedAcIds: string[] = [];
		for (const scope of describeScopes) {
			if (index >= scope.start && index < scope.end) {
				for (const id of scope.acIds) {
					if (!inheritedAcIds.includes(id)) inheritedAcIds.push(id);
				}
			}
		}
		const acIds = [...new Set([...inheritedAcIds, ...uniqueAcIds(title)])];
		const titleCaseIds = uniqueCaseIds(title);
		const tableCaseIds =
			titleCaseIds.length === 0 && tableSource ? extractTableCaseIds(tableSource) : [];
		const regression = title.match(REGRESSION_TAG);
		const shadow = title.match(SHADOW_TAG);
		const hasAssertion = ASSERTION_RE.test(body);
		const oracle = /@oracle\b/i.test(title) || isOraclePath(filePath);
		if (tableCaseIds.length > 0) {
			for (const eachCaseId of tableCaseIds) {
				tests.push(
					Object.freeze({
						file: filePath,
						line,
						title,
						acIds: Object.freeze(acIds),
						caseIds: Object.freeze([eachCaseId]),
						eachCaseId,
						regressionId: regression?.[1] ?? null,
						shadow: shadow?.[1]?.toLowerCase() ?? null,
						hasAssertion,
						oracle,
					}),
				);
			}
			continue;
		}
		tests.push(
			Object.freeze({
				file: filePath,
				line,
				title,
				acIds: Object.freeze(acIds),
				caseIds: Object.freeze(titleCaseIds),
				regressionId: regression?.[1] ?? null,
				shadow: shadow?.[1]?.toLowerCase() ?? null,
				hasAssertion,
				oracle,
			}),
		);
	}
	return Object.freeze(tests);
}

function uniqueCaseIds(title: string): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	AC_CASE_TAG.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = AC_CASE_TAG.exec(title)) !== null) {
		const caseId = match[1];
		if (!caseId || seen.has(caseId)) continue;
		seen.add(caseId);
		ids.push(caseId);
	}
	return ids;
}

function uniqueAcIds(title: string): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	AC_TAG.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = AC_TAG.exec(title)) !== null) {
		const digits = match[1]?.match(/\d{2,}/)?.[0];
		if (!digits) continue;
		const canonical = `AC-${digits}`;
		if (seen.has(canonical)) continue;
		seen.add(canonical);
		ids.push(canonical);
	}
	return ids;
}

function extractCallbackBody(source: string, fromIndex: number): string {
	const rest = source.slice(fromIndex);
	const nextTestOffset = rest.search(/\n\s*(?:it|test|describe)\s*\(/);
	const validLimit = nextTestOffset === -1 ? rest.length : nextTestOffset;
	const scopeRest = rest.slice(0, validLimit);

	const braceOffset = indexOfUnquoted(scopeRest, '{');
	const arrowOffset = scopeRest.search(/=>/);
	const functionOffset = scopeRest.search(/\bfunction\b/);
	const isRegularFunction =
		functionOffset !== -1 && (braceOffset === -1 || functionOffset < braceOffset);

	if (arrowOffset !== -1 && !isRegularFunction) {
		const afterArrow = rest.slice(arrowOffset + 2).trimStart();
		if (afterArrow.startsWith('{')) {
			const abs = fromIndex + rest.length - afterArrow.length;
			return extractBraced(source, abs);
		}
		const end = afterArrow.search(/\n/);
		return end === -1 ? afterArrow : afterArrow.slice(0, end);
	}
	if (braceOffset === -1) {
		return nextTestOffset === -1 ? rest.slice(0, 500) : rest.slice(0, nextTestOffset);
	}
	return extractBraced(source, fromIndex + braceOffset);
}

function indexOfUnquoted(text: string, needle: string): number {
	let inStr: string | null = null;
	let escape = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inStr) {
			if (escape) {
				escape = false;
				continue;
			}
			if (ch === '\\') {
				escape = true;
				continue;
			}
			if (ch === inStr) inStr = null;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			inStr = ch;
			continue;
		}
		if (ch === needle) return i;
	}
	return -1;
}

function extractBraced(source: string, openIndex: number): string {
	let depth = 0;
	let inStr: string | null = null;
	let escape = false;
	for (let i = openIndex; i < source.length; i++) {
		const ch = source[i];
		if (inStr) {
			if (escape) {
				escape = false;
				continue;
			}
			if (ch === '\\') {
				escape = true;
				continue;
			}
			if (ch === inStr) inStr = null;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			inStr = ch;
			continue;
		}
		if (ch === '{') depth += 1;
		else if (ch === '}') {
			depth -= 1;
			if (depth === 0) return source.slice(openIndex, i + 1);
		}
	}
	return source.slice(openIndex);
}
