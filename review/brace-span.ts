const MASKED_OPEN = '\u0001';
const MASKED_CLOSE = '\u0002';
const MASKED_TEST = '\u0003';
const MASKED_IT = '\u0004';
const REGEX_KEYWORD = /(?:^|[^A-Za-z0-9_$])(?:return|throw|case|typeof|void|delete|await|yield|else|do|in|of|new)$/;

let boundSource: string | null = null;
let boundOpen = new Map<number, number>();

function isSpace(char: string): boolean {
	return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

function escaped(source: string, index: number): boolean {
	let slashes = 0;
	for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) slashes += 1;
	return slashes % 2 === 1;
}

function skipQuoteBackward(source: string, close: number): number {
	const quote = source[close] ?? '';
	for (let index = close - 1; index >= 0; index -= 1) {
		if (source[index] === quote && !escaped(source, index)) return index;
	}
	return 0;
}

function skipQuoteForward(source: string, open: number): number {
	const quote = source[open] ?? '';
	for (let index = open + 1; index < source.length; index += 1) {
		if (source[index] === '\\') {
			index += 1;
			continue;
		}
		if (source[index] === quote) return index;
	}
	return source.length;
}

function isControlWord(word: string): boolean {
	return word === 'if' || word === 'while' || word === 'for' || word === 'with' || word === 'switch';
}

function isControlOpen(source: string, prev: number): boolean {
	const head = wordEndingAt(source, prev);
	if (head.word === 'await') return wordEndingAt(source, head.from - 1).word === 'for';
	return isControlWord(head.word);
}

function opensRegex(source: string, prev: number, prevControl: boolean): boolean {
	if (prev < 0) return true;
	const char = source[prev] ?? '';
	if ((char === '+' || char === '-') && source[prev - 1] === char) return false;
	if ('([{:;,=!?&|~^%*+-<>'.includes(char)) return true;
	if (char === ')' && prevControl) return true;
	return REGEX_KEYWORD.test(source.slice(0, prev + 1));
}

/** Closing backtick of the template at `open`, recording nested templates in `bounds`. */
function templateClose(source: string, open: number, bounds: Map<number, number>): number {
	let index = open + 1;
	while (index < source.length) {
		const char = source[index] ?? '';
		if (char === '\\') {
			index += index + 1 < source.length ? 2 : 1;
			continue;
		}
		if (char === '`') {
			bounds.set(index, open);
			return index;
		}
		if (char === '$' && source[index + 1] === '{') {
			const end = scanCode(source, index + 2, bounds, 1);
			if (end < 0) return -1;
			index = end + 1;
			continue;
		}
		index += 1;
	}
	return -1;
}

/**
 * Forward code scan used to pair template backticks.
 * `openingDepth` 0 walks the file; 1 stops at the `}` that closes `${`.
 */
function scanCode(source: string, start: number, bounds: Map<number, number>, openingDepth: number): number {
	let depth = openingDepth;
	let index = start;
	let prev = start - 1;
	let prevControl = false;
	const controls: boolean[] = [];
	while (index < source.length) {
		const char = source[index] ?? '';
		if (isSpace(char)) {
			index += 1;
			continue;
		}
		if (char === '/' && source[index + 1] === '/') {
			index += 2;
			while (index < source.length && source[index] !== '\n') index += 1;
			continue;
		}
		if (char === '/' && source[index + 1] === '*') {
			index += 2;
			while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
			if (index < source.length) index += 2;
			continue;
		}
		if (char === "'" || char === '"') {
			const end = skipQuoteForward(source, index);
			if (end >= source.length) return openingDepth > 0 ? -1 : source.length;
			index = end + 1;
			prev = end;
			prevControl = false;
			continue;
		}
		if (char === '`') {
			const close = templateClose(source, index, bounds);
			if (close < 0) {
				if (openingDepth > 0) return -1;
				prev = index;
				prevControl = false;
				index += 1;
				continue;
			}
			index = close + 1;
			prev = close;
			prevControl = false;
			continue;
		}
		if (char === '/' && opensRegex(source, prev, prevControl)) {
			const end = regexCloseSlash(source, index);
			if (end < 0) {
				if (openingDepth > 0) return -1;
				prev = index;
				prevControl = false;
				index += 1;
				continue;
			}
			index = end + 1;
			while (index < source.length && /[A-Za-z]/.test(source[index] ?? '')) index += 1;
			prev = index - 1;
			prevControl = false;
			continue;
		}
		if (char === '(') {
			controls.push(isControlOpen(source, prev));
			prev = index;
			prevControl = false;
			index += 1;
			continue;
		}
		if (char === ')') {
			prevControl = controls.pop() ?? false;
			prev = index;
			index += 1;
			continue;
		}
		if (char === '{') {
			if (depth > 0) depth += 1;
			prev = index;
			prevControl = false;
			index += 1;
			continue;
		}
		if (char === '}') {
			if (depth > 0) {
				depth -= 1;
				if (depth === 0) return index;
			}
			prev = index;
			prevControl = false;
			index += 1;
			continue;
		}
		if (/[A-Za-z0-9_$]/.test(char)) {
			index += 1;
			while (index < source.length && /[A-Za-z0-9_$]/.test(source[index] ?? '')) index += 1;
			prev = index - 1;
			prevControl = false;
			continue;
		}
		prev = index;
		prevControl = false;
		index += 1;
	}
	return openingDepth > 0 ? -1 : source.length;
}

/** Opening backtick paired with `close`, including templates nested inside `${...}`. */
function templateOpenOfClose(source: string, close: number): number {
	if (boundSource !== source) {
		boundSource = source;
		boundOpen = new Map();
		scanCode(source, 0, boundOpen, 0);
	}
	return boundOpen.get(close) ?? -1;
}

function skipBlockBackward(source: string, slash: number): number {
	for (let index = slash - 2; index >= 0; index -= 1) {
		if (source[index] === '/' && source[index + 1] === '*') return index;
	}
	return 0;
}

/** Closing `/` of the regex that opens at `open`, or -1 when the literal does not close. */
function regexCloseSlash(source: string, open: number): number {
	let index = open + 1;
	let klass = false;
	while (index < source.length && (source[index] ?? '') !== '\n') {
		const char = source[index] ?? '';
		if (char === '\\') {
			index += index + 1 < source.length ? 2 : 1;
			continue;
		}
		if (char === '[') klass = true;
		else if (char === ']') klass = false;
		else if (char === '/' && !klass) return index;
		index += 1;
	}
	return -1;
}

/** Opening `/` when `closeSlash` ends a regex literal, otherwise -1. */
function regexOpenOfClose(source: string, closeSlash: number): number {
	let index = closeSlash - 1;
	while (index >= 0 && source[index] !== '\n') {
		if (source[index] === '/' && !escaped(source, index)
			&& regexCloseSlash(source, index) === closeSlash
			&& slashIsRegex(source, index)) return index;
		index -= 1;
	}
	return -1;
}

/** Index of the `(` that `close` ends, skipping strings, comments, and regex literals. */
function matchingOpenParen(source: string, close: number): number {
	let depth = 1;
	let index = close - 1;
	while (index >= 0) {
		const comment = lineCommentOpen(source, index);
		if (comment !== -1) {
			index = comment - 1;
			continue;
		}
		const char = source[index] ?? '';
		if (char === "'" || char === '"') {
			index = skipQuoteBackward(source, index) - 1;
			continue;
		}
		if (char === '`') {
			const open = templateOpenOfClose(source, index);
			index = (open >= 0 ? open : skipQuoteBackward(source, index)) - 1;
			continue;
		}
		if (char === '/' && source[index - 1] === '*') {
			index = skipBlockBackward(source, index) - 1;
			continue;
		}
		if (char === '/') {
			const open = regexOpenOfClose(source, index);
			if (open >= 0) {
				index = open - 1;
				continue;
			}
		}
		if (char === ')') depth += 1;
		else if (char === '(') {
			depth -= 1;
			if (depth === 0) return index;
		}
		index -= 1;
	}
	return -1;
}

function wordEndingAt(source: string, index: number): { word: string; from: number } {
	let cursor = previousCodeIndex(source, index);
	const end = cursor;
	while (cursor >= 0 && /[A-Za-z0-9_$]/.test(source[cursor] ?? '')) cursor -= 1;
	return { word: source.slice(cursor + 1, end + 1), from: cursor + 1 };
}

/** `)` closes `if`, `while`, `for`, `for await`, `with`, or `switch`. */
function closesControlCondition(source: string, close: number): boolean {
	const open = matchingOpenParen(source, close);
	if (open < 0) return false;
	const head = wordEndingAt(source, open - 1);
	if (head.word === 'await') return wordEndingAt(source, head.from - 1).word === 'for';
	return isControlWord(head.word);
}

/** Index of `//` on this line before `index` when that marker is outside a quote. */
function lineCommentOpen(source: string, index: number): number {
	let start = index;
	while (start > 0 && source[start - 1] !== '\n') start -= 1;
	let quote: string | null = null;
	let escape = false;
	for (let cursor = start; cursor < index; cursor += 1) {
		const char = source[cursor] ?? '';
		if (quote) {
			if (escape) escape = false;
			else if (char === '\\') escape = true;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === '/' && source[cursor + 1] === '/') return cursor;
		if (char === '"' || char === "'" || char === '`') quote = char;
	}
	return -1;
}

/** Previous code token, skipping whitespace and comments. */
function previousCodeIndex(source: string, from: number): number {
	let index = from;
	while (index >= 0) {
		while (index >= 0 && isSpace(source[index] ?? '')) index -= 1;
		if (index < 0) return -1;
		if (source[index] === '/' && source[index - 1] === '*') {
			index = skipBlockBackward(source, index) - 1;
			continue;
		}
		const comment = lineCommentOpen(source, index);
		if (comment !== -1) {
			index = comment - 1;
			continue;
		}
		return index;
	}
	return -1;
}

/** An operator, keyword, or control-condition ")" opens a regex literal. */
function slashIsRegex(source: string, slash: number): boolean {
	const previous = previousCodeIndex(source, slash - 1);
	if (previous < 0) return true;
	const char = source[previous] ?? '';
	if ((char === '+' || char === '-') && source[previous - 1] === char) return false;
	if ('([{:;,=!?&|~^%*+-<>'.includes(char)) return true;
	if (char === ')' && closesControlCondition(source, previous)) return true;
	return REGEX_KEYWORD.test(source.slice(0, previous + 1));
}

/** Last index of the regex literal that opens at `slash`, inclusive. */
function lastRegexIndex(source: string, slash: number): number {
	let index = slash + 1;
	let klass = false;
	while (index < source.length) {
		const char = source[index] ?? '';
		if (char === '\n') return index;
		if (char === '\\') {
			index += index + 1 < source.length ? 2 : 1;
			continue;
		}
		if (char === '[') klass = true;
		else if (char === ']') klass = false;
		else if (char === '/' && !klass) {
			index += 1;
			while (index < source.length && /[A-Za-z]/.test(source[index] ?? '')) index += 1;
			return index - 1;
		}
		index += 1;
	}
	return Math.max(slash, source.length - 1);
}

function maskChar(char: string): string {
	if (char === '{') return MASKED_OPEN;
	if (char === '}') return MASKED_CLOSE;
	return char;
}

/** `.test(` and `.it(` are member calls. The assertion rescan would read them as test titles. */
function markMemberTestCall(chars: string[], dot: number): void {
	let cursor = dot + 1;
	const start = cursor;
	while (cursor < chars.length && /[A-Za-z0-9_$]/.test(chars[cursor] ?? '')) cursor += 1;
	const name = chars.slice(start, cursor).join('');
	if (name !== 'test' && name !== 'it') return;
	while (cursor < chars.length && isSpace(chars[cursor] ?? '')) cursor += 1;
	if (chars[cursor] !== '(') return;
	chars[start] = name === 'test' ? MASKED_TEST : MASKED_IT;
}

/**
 * One-byte stand-ins for braces that are not block delimiters.
 * The assertion rescan counts every brace outside strings, so comments and regex
 * literals are masked here and restored in the excerpt text.
 */
export function maskIgnoredBraces(source: string): string {
	const chars = source.split('');
	let quote: string | null = null;
	let escape = false;
	for (let index = 0; index < chars.length; index += 1) {
		const char = chars[index] ?? '';
		if (quote) {
			if (escape) escape = false;
			else if (char === '\\') escape = true;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === '/' && chars[index + 1] === '/') {
			index += 2;
			while (index < chars.length && chars[index] !== '\n') {
				chars[index] = maskChar(chars[index] ?? '');
				index += 1;
			}
			continue;
		}
		if (char === '/' && chars[index + 1] === '*') {
			index += 2;
			while (index < chars.length && !(chars[index] === '*' && chars[index + 1] === '/')) {
				chars[index] = maskChar(chars[index] ?? '');
				index += 1;
			}
			if (index < chars.length) index += 1;
			continue;
		}
		if (char === '/' && slashIsRegex(source, index)) {
			const end = lastRegexIndex(source, index);
			for (let cursor = index + 1; cursor <= end && cursor < chars.length; cursor += 1) {
				chars[cursor] = maskChar(chars[cursor] ?? '');
			}
			index = end;
			continue;
		}
		if (char === '"' || char === "'" || char === '`') {
			quote = char;
			continue;
		}
		if (char === '.') markMemberTestCall(chars, index);
	}
	return chars.join('');
}

export function unmaskIgnoredBraces(text: string): string {
	return text
		.replaceAll(MASKED_TEST, 't')
		.replaceAll(MASKED_IT, 'i')
		.replaceAll(MASKED_OPEN, '{')
		.replaceAll(MASKED_CLOSE, '}');
}

/** Callback body from its opening brace through the matching close. Comments, strings, and regex literals do not count. */
export function extractBraced(source: string, openIndex: number): string {
	let depth = 0;
	let quote: string | null = null;
	let escape = false;
	for (let index = openIndex; index < source.length; index += 1) {
		const char = source[index] ?? '';
		if (quote) {
			if (escape) escape = false;
			else if (char === '\\') escape = true;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
			const block = source[index + 1] === '*';
			index += 2;
			while (index < source.length && (block
				? !(source[index] === '*' && source[index + 1] === '/')
				: source[index] !== '\n')) index += 1;
			if (block && index < source.length) index += 1;
			continue;
		}
		if (char === '/' && slashIsRegex(source, index)) {
			index = lastRegexIndex(source, index);
			continue;
		}
		if (char === '"' || char === "'" || char === '`') {
			quote = char;
			continue;
		}
		if (char === '{') depth += 1;
		else if (char === '}') {
			depth -= 1;
			if (depth === 0) return source.slice(openIndex, index + 1);
		}
	}
	return source.slice(openIndex);
}
