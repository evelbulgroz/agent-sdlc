import path from 'node:path';
import { SdlcError } from '../policy/errors.ts';
import { isOraclePath } from '../execution/ac-citations.ts';

const ASSERTION_RE = /\bexpect\s*\(|\bassert\s*\(|\bassert\./;
const TEST_CALL_RE = /\b((?:it|test)(?:\.(?:only|skip))?)\s*\(\s*(['"`])([\s\S]*?)\2/g;

export const DEFAULT_MAX_BYTES = 24576; // 24 KB
export const DEFAULT_MAX_LINES = 1000;
export const DEFAULT_ASSERTIONS_PER_TEST = 3;
export const DEFAULT_MAX_ASSERT_CHARS = 240;
export const DEFAULT_FILE_SOFT_CAP = 80;

export interface TouchedTestFileObject {
	path?: string;
	content?: string;
}

export interface ExtractedTestExcerpts {
	text: string;
	lines: readonly string[];
	fileCount: number;
	testCount: number;
	byteCount: number;
	lineCount: number;
}

interface AssertionLine {
	line: number;
	text: string;
}

interface ParsedTest {
	file: string;
	line: number;
	title: string;
	acIds: string[];
	isOracle: boolean;
	assertionLines: AssertionLine[];
	hadAssertions: boolean;
	activeAssertions: AssertionLine[];
	evicted?: boolean;
}

interface ParsedFile {
	path: string;
	isOracle: boolean;
	tests: ParsedTest[];
}

function posixPath(filePath: unknown): string {
	return String(filePath).split(path.sep).join('/');
}

function truncateLine(text: unknown, maxChars = DEFAULT_MAX_ASSERT_CHARS): string {
	const trimmed = String(text ?? '').trim();
	if (trimmed.length <= maxChars) return trimmed;
	return trimmed.slice(0, maxChars - 1) + '…';
}

function extractCallbackInfo(source: string, fromIndex: number): { body: string; bodyStart: number } {
	const rest = source.slice(fromIndex);
	const braceOffset = rest.indexOf('{');
	const arrowOffset = rest.indexOf('=>');

	let bodyStart = -1;
	let body = '';

	if (arrowOffset !== -1 && (braceOffset === -1 || arrowOffset < braceOffset)) {
		const afterArrow = rest.slice(arrowOffset + 2);
		const trimmedAfterArrow = afterArrow.trimStart();
		const whitespaceLen = afterArrow.length - trimmedAfterArrow.length;
		if (trimmedAfterArrow.startsWith('{')) {
			const openBrace = fromIndex + arrowOffset + 2 + whitespaceLen;
			bodyStart = openBrace;
			body = extractBraced(source, openBrace);
		} else {
			bodyStart = fromIndex + arrowOffset + 2 + whitespaceLen;
			const nextNewline = trimmedAfterArrow.indexOf('\n');
			body = nextNewline === -1 ? trimmedAfterArrow : trimmedAfterArrow.slice(0, nextNewline);
		}
	} else if (braceOffset !== -1) {
		bodyStart = fromIndex + braceOffset;
		body = extractBraced(source, bodyStart);
	} else {
		bodyStart = fromIndex;
		body = rest.slice(0, 500);
	}

	return { body, bodyStart };
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

function parseFileTests(
	filePath: string,
	content: string,
	{ maxChars = DEFAULT_MAX_ASSERT_CHARS }: { maxChars?: number } = {},
): ParsedTest[] {
	const normalizedPath = posixPath(filePath);
	const tests: ParsedTest[] = [];
	TEST_CALL_RE.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = TEST_CALL_RE.exec(content)) !== null) {
		const title = match[3] ?? '';
		const testLineNumber = content.slice(0, match.index).split('\n').length;
		const afterTitleIndex = match.index + match[0].length;
		const { body, bodyStart } = extractCallbackInfo(content, afterTitleIndex);

		const assertionLines: AssertionLine[] = [];
		const bodyLines = body.split('\n');
		let currentOffset = bodyStart;

		for (const rawLine of bodyLines) {
			if (ASSERTION_RE.test(rawLine)) {
				const lineInFile = content.slice(0, currentOffset).split('\n').length;
				const truncated = truncateLine(rawLine, maxChars);
				assertionLines.push({
					line: lineInFile,
					text: truncated,
				});
			}
			currentOffset += rawLine.length + 1; // +1 for '\n'
		}

		const acMatches = [...title.matchAll(/@ac\s+(AC-\d{2,})/gi)].map((m) =>
			(m[1] ?? '').toUpperCase(),
		);
		const acIds = [...new Set(acMatches)];
		const isOracle = isOraclePath(normalizedPath) || /@oracle\b/i.test(title);

		tests.push({
			file: normalizedPath,
			line: testLineNumber,
			title,
			acIds,
			isOracle,
			assertionLines,
			hadAssertions: assertionLines.length > 0,
			activeAssertions: [],
		});
	}

	return tests;
}

export function extractTestExcerpts({
	touchedFiles = [],
	acceptanceCriteria = [],
	baseBytes = 0,
	baseLines = 0,
	maxBytes = DEFAULT_MAX_BYTES,
	maxLines = DEFAULT_MAX_LINES,
	maxAssertionsPerTest = DEFAULT_ASSERTIONS_PER_TEST,
	maxAssertChars = DEFAULT_MAX_ASSERT_CHARS,
	softCapPerFile = DEFAULT_FILE_SOFT_CAP,
}: {
	touchedFiles?: readonly TouchedTestFileObject[];
	acceptanceCriteria?: readonly string[];
	baseBytes?: number;
	baseLines?: number;
	maxBytes?: number;
	maxLines?: number;
	maxAssertionsPerTest?: number;
	maxAssertChars?: number;
	softCapPerFile?: number;
} = {}): Readonly<ExtractedTestExcerpts> {
	if (!Array.isArray(touchedFiles) || touchedFiles.length === 0) {
		return Object.freeze({
			text: '(none)',
			lines: Object.freeze(['(none)']),
			fileCount: 0,
			testCount: 0,
			byteCount: baseBytes + Buffer.byteLength('(none)', 'utf8'),
			lineCount: baseLines + 1,
		});
	}

	// Parse all touched files into structured tests
	const parsedFiles: ParsedFile[] = [];
	for (const file of touchedFiles) {
		const filePath = posixPath(file.path ?? 'unknown.spec.ts');
		const content = typeof file.content === 'string' ? file.content : '';
		const tests = parseFileTests(filePath, content, { maxChars: maxAssertChars });
		parsedFiles.push({
			path: filePath,
			isOracle: isOraclePath(filePath),
			tests,
		});
	}

	// Determine active AC ids from acceptanceCriteria for eviction priority
	const activeAcSet = new Set<string>();
	for (const ac of acceptanceCriteria) {
		const m = String(ac).match(/\b(AC-\d{2,})\b/i);
		if (m && m[1]) activeAcSet.add(m[1].toUpperCase());
	}

	// Prepare initial pack per file respecting maxAssertionsPerTest and softCapPerFile
	for (const file of parsedFiles) {
		for (const test of file.tests) {
			test.activeAssertions = test.assertionLines.slice(0, maxAssertionsPerTest);
		}
		enforceFileSoftCap(file, softCapPerFile);
	}

	// Now check against overall budget (maxBytes, maxLines) and evict in order
	evictToFitBudget({
		parsedFiles,
		baseBytes,
		baseLines,
		maxBytes,
		maxLines,
		activeAcSet,
	});

	// Build final output
	const rendered = renderFiles(parsedFiles);
	if (rendered.length === 0) {
		return Object.freeze({
			text: '(none)',
			lines: Object.freeze(['(none)']),
			fileCount: 0,
			testCount: 0,
			byteCount: baseBytes + Buffer.byteLength('(none)', 'utf8'),
			lineCount: baseLines + 1,
		});
	}

	const text = rendered.join('\n');
	const totalBytes = baseBytes + Buffer.byteLength(text, 'utf8');
	const totalLines = baseLines + rendered.length;

	let totalFilesIncluded = 0;
	let totalTestsIncluded = 0;
	for (const file of parsedFiles) {
		const includedTests = file.tests.filter((t) => !t.evicted);
		if (includedTests.length > 0) {
			totalFilesIncluded += 1;
			totalTestsIncluded += includedTests.length;
		}
	}

	if (totalBytes > maxBytes || totalLines > maxLines) {
		throw new SdlcError(
			'INPUT_OVERSIZED',
			`Assembled prompt exceeds packing ceiling (max 24KB / 1,000 lines; got ${totalBytes} bytes, ${totalLines} lines across ${totalFilesIncluded} files and ${totalTestsIncluded} tests). Hint: split the run or reduce touched tests.`,
			{
				byteCount: totalBytes,
				lineCount: totalLines,
				fileCount: totalFilesIncluded,
				testCount: totalTestsIncluded,
			},
		);
	}

	return Object.freeze({
		text,
		lines: Object.freeze(rendered),
		fileCount: totalFilesIncluded,
		testCount: totalTestsIncluded,
		byteCount: totalBytes,
		lineCount: totalLines,
	});
}

function renderTestLines(test: ParsedTest): string[] {
	if (test.evicted) return [];
	const lines: string[] = [];
	lines.push(`${test.file}:${test.line} it("${test.title}")`);
	if (test.hadAssertions) {
		for (const a of test.activeAssertions) {
			lines.push(`${test.file}:${a.line} ${a.text}`);
		}
	} else {
		lines.push(`${test.file}:${test.line + 1} (no assertion lines)`);
	}
	return lines;
}

function renderFiles(parsedFiles: readonly ParsedFile[]): string[] {
	const allLines: string[] = [];
	for (const file of parsedFiles) {
		for (const test of file.tests) {
			if (!test.evicted) {
				allLines.push(...renderTestLines(test));
			}
		}
	}
	return allLines;
}

function countFileLines(file: ParsedFile): number {
	let count = 0;
	for (const test of file.tests) {
		if (!test.evicted) {
			count += renderTestLines(test).length;
		}
	}
	return count;
}

function enforceFileSoftCap(file: ParsedFile, softCap: number): void {
	if (countFileLines(file) <= softCap) return;

	// Step A: Drop assertions 2-3 per test down to 1
	for (const test of file.tests) {
		if (test.activeAssertions && test.activeAssertions.length > 1) {
			test.activeAssertions = test.activeAssertions.slice(0, 1);
		}
	}
	if (countFileLines(file) <= softCap) return;

	// Step B: Evict extra tests from the end, preserving at least 1 test (prefer keeping oracle)
	for (let i = file.tests.length - 1; i >= 1; i--) {
		const test = file.tests[i];
		if (test) test.evicted = true;
		if (countFileLines(file) <= softCap) return;
	}
}

function calculateTotalBudgetUsage(
	parsedFiles: readonly ParsedFile[],
	baseBytes: number,
	baseLines: number,
): { byteCount: number; lineCount: number } {
	const rendered = renderFiles(parsedFiles);
	const text = rendered.join('\n');
	const byteCount = baseBytes + Buffer.byteLength(text, 'utf8');
	const lineCount = baseLines + rendered.length;
	return { byteCount, lineCount };
}

function isOverBudget(
	parsedFiles: readonly ParsedFile[],
	baseBytes: number,
	baseLines: number,
	maxBytes: number,
	maxLines: number,
): boolean {
	const { byteCount, lineCount } = calculateTotalBudgetUsage(parsedFiles, baseBytes, baseLines);
	return byteCount > maxBytes || lineCount > maxLines;
}

function evictToFitBudget({
	parsedFiles,
	baseBytes,
	baseLines,
	maxBytes,
	maxLines,
	activeAcSet,
}: {
	parsedFiles: ParsedFile[];
	baseBytes: number;
	baseLines: number;
	maxBytes: number;
	maxLines: number;
	activeAcSet: ReadonlySet<string>;
}): void {
	if (!isOverBudget(parsedFiles, baseBytes, baseLines, maxBytes, maxLines)) return;

	// Eviction order 1: Drop assertion lines 2-3 per test (keep the first). Preserve-one rule.
	for (const file of parsedFiles) {
		for (const test of file.tests) {
			if (test.activeAssertions && test.activeAssertions.length > 1) {
				test.activeAssertions = test.activeAssertions.slice(0, 1);
			}
		}
	}
	if (!isOverBudget(parsedFiles, baseBytes, baseLines, maxBytes, maxLines)) return;

	// Eviction order 2: Evict extra tests from files that already contributed >= 1 test.
	// Prefer KEEPING oracle files and tests that cite currently uncovered / active ACs.
	const nonOracleFiles = parsedFiles.filter((f) => !f.isOracle);
	const targetFilesForStep2 = [...nonOracleFiles, ...parsedFiles.filter((f) => f.isOracle)];

	for (const file of targetFilesForStep2) {
		const activeTests = file.tests.filter((t) => !t.evicted);
		if (activeTests.length <= 1) continue;

		// Sort extra tests: tests citing ACs or oracles are evicted last
		const candidates = activeTests.slice(1).sort((a, b) => {
			const aCites = a.acIds.some((id) => activeAcSet.has(id)) ? 1 : 0;
			const bCites = b.acIds.some((id) => activeAcSet.has(id)) ? 1 : 0;
			return aCites - bCites; // non-citing first
		});

		for (const test of candidates) {
			test.evicted = true;
			if (!isOverBudget(parsedFiles, baseBytes, baseLines, maxBytes, maxLines)) return;
		}
	}
	if (!isOverBudget(parsedFiles, baseBytes, baseLines, maxBytes, maxLines)) return;

	// Eviction order 3: Evict remaining files (keeping the last file / oracle test if possible)
	const filesToEvict = [...parsedFiles].sort((a, b) => {
		if (a.isOracle && !b.isOracle) return 1;
		if (!a.isOracle && b.isOracle) return -1;
		return 0;
	});

	for (let i = 0; i < filesToEvict.length; i++) {
		const file = filesToEvict[i];
		if (!file) continue;
		// If this is the very last file with active tests, do not evict its last test
		const remainingActiveFiles = filesToEvict.filter((f) => f.tests.some((t) => !t.evicted));
		if (remainingActiveFiles.length <= 1) {
			const lastFile = remainingActiveFiles[0];
			const activeTests = lastFile ? lastFile.tests.filter((t) => !t.evicted) : [];
			if (activeTests.length <= 1) {
				// Can't evict further without leaving 0 tests
				break;
			}
		}

		for (const test of file.tests) {
			test.evicted = true;
		}
		if (!isOverBudget(parsedFiles, baseBytes, baseLines, maxBytes, maxLines)) return;
	}
}
