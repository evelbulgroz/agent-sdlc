export interface ExecutionEvidenceError {
	readonly code: string;
	readonly message: string;
}

export interface ParsedTestExecutionEvidence {
	readonly format: 'json' | 'tap' | null;
	readonly passedTitles: readonly string[];
	readonly errors: readonly ExecutionEvidenceError[];
}

export function normalizeExecutedTitle(value: unknown): string {
	return String(value ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * Extracts a JSON object substring starting at `startIndex` (which must be
 * the index of an opening `{`) by scanning forward with quote-aware brace
 * counting until the matching closing `}` is found. Returns null if the
 * braces never balance before the end of input.
 */
function extractBalancedJsonObject(output: string, startIndex: number): string | null {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = startIndex; index < output.length; index += 1) {
		const char = output[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === '\\') escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === '{') depth += 1;
		else if (char === '}') {
			depth -= 1;
			if (depth === 0) return output.slice(startIndex, index + 1);
		}
	}
	return null;
}

interface JsonAssertionResult {
	readonly status?: unknown;
	readonly title?: unknown;
	readonly fullName?: unknown;
}

interface JsonTestSuite {
	readonly assertionResults?: readonly JsonAssertionResult[];
}

function toJsonExecutionEvidence(parsed: unknown): ParsedTestExecutionEvidence | null {
	if (!parsed || typeof parsed !== 'object' || !('testResults' in parsed)) return null;
	const testResults = parsed.testResults;
	if (!Array.isArray(testResults)) return null;
	const passedTitles: string[] = [];
	for (const suite of testResults as readonly JsonTestSuite[]) {
		for (const assertion of suite?.assertionResults ?? []) {
			if (assertion?.status !== 'passed') continue;
			const title = normalizeExecutedTitle(assertion.title);
			const fullName = normalizeExecutedTitle(assertion.fullName);
			if (title) passedTitles.push(title);
			if (fullName && fullName !== title) passedTitles.push(fullName);
		}
	}
	return Object.freeze({
		format: 'json',
		passedTitles: Object.freeze([...new Set(passedTitles)]),
		errors: Object.freeze([]),
	});
}

function parseJsonExecutionEvidence(output: unknown): ParsedTestExecutionEvidence | null {
	const text = String(output ?? '');
	const lines = text.split(/\r?\n/);
	const lineStarts: number[] = [];
	let cursor = 0;
	for (const rawLine of lines) {
		lineStarts.push(cursor);
		cursor += rawLine.length + 1; // +1 for the stripped newline separator
	}
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const rawLine = lines[index] ?? '';
		const trimmed = rawLine.trim();
		if (!trimmed.startsWith('{')) continue;
		// Fast path: a single line already contains the full JSON object.
		try {
			const parsed: unknown = JSON.parse(trimmed);
			const evidence = toJsonExecutionEvidence(parsed);
			if (evidence) return evidence;
			continue;
		} catch {
			// Fall through to the balanced multi-line scan below: pretty-printed
			// JSON reports span several lines, so a single line is often just
			// the opening `{` of a larger object.
		}
		const braceIndex = (lineStarts[index] ?? 0) + rawLine.indexOf('{');
		const candidate = extractBalancedJsonObject(text, braceIndex);
		if (!candidate) continue;
		try {
			const parsed: unknown = JSON.parse(candidate);
			const evidence = toJsonExecutionEvidence(parsed);
			if (evidence) return evidence;
		} catch {
			// Continue searching earlier lines; package scripts may emit non-JSON prelude.
		}
	}
	return null;
}

function parseTapExecutionEvidence(output: unknown): ParsedTestExecutionEvidence | null {
	const lines = String(output ?? '').split(/\r?\n/);
	const passedTitles: string[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const match = (lines[index] ?? '').match(/^\s*#\s+Subtest:\s+(.+?)\s*$/);
		if (!match) continue;
		const title = normalizeExecutedTitle(match[1]);
		for (const line of lines.slice(index + 1)) {
			const terminal = line.match(/^\s*(ok|not ok)\s+\d+\s+-\s+(.+?)\s*$/);
			if (!terminal || normalizeExecutedTitle(terminal[2]) !== title) continue;
			if (terminal[1] === 'ok') passedTitles.push(title);
			break;
		}
	}
	if (passedTitles.length === 0) return null;
	return Object.freeze({
		format: 'tap',
		passedTitles: Object.freeze([...new Set(passedTitles)]),
		errors: Object.freeze([]),
	});
}

export function parseTestExecutionEvidence(output: unknown): ParsedTestExecutionEvidence {
	if (typeof output !== 'string' || output.trim().length === 0) {
		return Object.freeze({
			format: null,
			passedTitles: Object.freeze([]),
			errors: Object.freeze([
				Object.freeze({
					code: 'EMPTY_EXECUTION_EVIDENCE',
					message: 'Declared verification produced no test execution evidence',
				}),
			]),
		});
	}
	const parsed = parseJsonExecutionEvidence(output) ?? parseTapExecutionEvidence(output);
	if (parsed) return parsed;
	return Object.freeze({
		format: null,
		passedTitles: Object.freeze([]),
		errors: Object.freeze([
			Object.freeze({
				code: 'UNSUPPORTED_EXECUTION_EVIDENCE',
				message: 'Declared verification output did not contain supported JSON or TAP test results',
			}),
		]),
	});
}
