/**
 * Static it/test titles. The case tag matches the scorer.
 * Constant interpolations and constant `+` concatenations are rendered first.
 * Any other title expression, including a template hole, a continued
 * expression, or an `.each` printf or `$` placeholder, is unresolved: its
 * value can be a case tag, so occupancy fails closed. `.only`, `.skip`, and
 * `.concurrent` may precede the call or `.each`. A tagged-template `.each`
 * table is not the title; the call after it is. Text inside comments,
 * strings, and template bodies is not a call.
 */

export interface StaticTestTitle {
	readonly index: number;
	readonly length: number;
	readonly title: string;
	readonly quote: string;
	readonly each: boolean;
	/** True when the rendered title is not known. `title` is then empty. */
	readonly unresolved: boolean;
}

/**
 * An `.each` title rewrites these. `%%` is a literal percent.
 * `%[sdifjoOp#c]` and `%$` consume a row; `$name`, `$#`, and `$path` inject one.
 */
function eachTitlePlaceholder(title: string): boolean {
	for (let n = 0; n < title.length; n += 1) {
		const char = title[n] ?? '';
		if (char === '%') {
			const next = title[n + 1] ?? '';
			if (next === '%') { n += 1; continue; }
			if (next === '$' || 'sdifjoOp#c'.includes(next)) return true;
			continue;
		}
		if (char === '$' && /[A-Za-z0-9_$#.]/.test(title[n + 1] ?? '')) return true;
	}
	return false;
}

export function caseIdsInTitle(title: string): string[] {
	return [...title.matchAll(/(?:^|\s)@case (AC-\d+\.\d+)(?=\s|$)/g)]
		.map((match) => match[1] ?? '')
		.filter((id) => id.length > 0);
}

type Segment = { kind: 'text'; text: string } | { kind: 'hole' };
type Cooked = { value: string | null; closed: boolean };
type TemplateRead = { title: string; unresolved: boolean } | { skip: true } | null;

export function staticTestTitles(source: string): StaticTestTitle[] {
	let i = 0;
	const hits: StaticTestTitle[] = [];

	function isSpace(char: string): boolean {
		return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v';
	}
	function isIdent(char: string): boolean {
		return /[A-Za-z0-9_$]/.test(char);
	}
	function skipLine(): void {
		while (i < source.length && source[i] !== '\n') i += 1;
	}
	function skipBlock(): void {
		i += 2;
		while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
		if (i < source.length) i += 2;
	}
	function skipTrivia(): boolean {
		const start = i;
		while (i < source.length) {
			const char = source[i] ?? '';
			if (isSpace(char)) { i += 1; continue; }
			if (char === '/' && source[i + 1] === '/') { skipLine(); continue; }
			if (char === '/' && source[i + 1] === '*') { skipBlock(); continue; }
			break;
		}
		return i > start;
	}
	function readEscape(): string | null {
		const next = source[i + 1];
		if (next === undefined) { i += 1; return null; }
		if (next === '\n') { i += 2; return ''; }
		if (next === '\r') { i += 2; if (source[i] === '\n') i += 1; return ''; }
		const simple: Record<string, string> = {
			n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0',
			'\\': '\\', "'": "'", '"': '"', '`': '`', $: '$',
		};
		if (simple[next] !== undefined && next !== 'u' && next !== 'x') { i += 2; return simple[next] ?? null; }
		if (next === 'x') {
			const hex = source.slice(i + 2, i + 4);
			if (!/^[0-9a-fA-F]{2}$/.test(hex)) { i += 2; return null; }
			i += 4;
			return String.fromCharCode(Number.parseInt(hex, 16));
		}
		if (next === 'u' && source[i + 2] === '{') {
			const close = source.indexOf('}', i + 3);
			const hex = close === -1 ? '' : source.slice(i + 3, close);
			const value = /^[0-9a-fA-F]{1,6}$/.test(hex) ? Number.parseInt(hex, 16) : Number.NaN;
			if (close === -1 || value > 0x10ffff || Number.isNaN(value)) {
				i = close === -1 ? i + 2 : close + 1;
				return null;
			}
			i = close + 1;
			return String.fromCodePoint(value);
		}
		if (next === 'u') {
			const hex = source.slice(i + 2, i + 6);
			if (!/^[0-9a-fA-F]{4}$/.test(hex)) { i += 2; return null; }
			i += 6;
			return String.fromCharCode(Number.parseInt(hex, 16));
		}
		i += 2;
		return next;
	}
	function readQuoted(quote: string): Cooked {
		i += 1;
		let out = '';
		let ok = true;
		while (i < source.length) {
			const char = source[i] ?? '';
			if (char === '\\') {
				const escaped = readEscape();
				if (escaped === null) ok = false;
				else out += escaped;
				continue;
			}
			if (char === '\n' || char === '\r') return { value: null, closed: false };
			if (char === quote) { i += 1; return { value: ok ? out : null, closed: true }; }
			out += char;
			i += 1;
		}
		return { value: null, closed: false };
	}
	function slashIsRegex(): boolean {
		let p = i - 1;
		while (p >= 0 && isSpace(source[p] ?? '')) p -= 1;
		if (p < 0) return true;
		const char = source[p] ?? '';
		if ((char === '+' || char === '-') && source[p - 1] === char) return false;
		if ('([{:;,=!?&|~^%*+-<>'.includes(char)) return true;
		return /(?:^|[^A-Za-z0-9_$])(?:return|throw|case|typeof|void|delete|await|yield|else|do|in|of|new)$/.test(source.slice(0, p + 1));
	}
	function skipRegex(): void {
		i += 1;
		let klass = false;
		while (i < source.length) {
			const char = source[i] ?? '';
			if (char === '\n') return;
			if (char === '\\') { i += Math.min(2, source.length - i); continue; }
			if (char === '[') klass = true;
			else if (char === ']') klass = false;
			if (char === '/' && !klass) {
				i += 1;
				while (i < source.length && /[A-Za-z]/.test(source[i] ?? '')) i += 1;
				return;
			}
			i += 1;
		}
	}
	function nextToken(): string {
		const before = i;
		if (i >= source.length) return 'eof';
		if (skipTrivia()) return 'trivia';
		if (i >= source.length) return 'eof';
		const char = source[i] ?? '';
		if (char === '/' && source[i + 1] === '/') { skipLine(); return 'trivia'; }
		if (char === '/' && source[i + 1] === '*') { skipBlock(); return 'trivia'; }
		if (char === '/' && slashIsRegex()) { skipRegex(); return 'regex'; }
		if (char === "'" || char === '"') { readQuoted(char); return 'string'; }
		if (char === '`') { readTemplate(false); return 'template'; }
		if ((char === 't' || char === 'i') && parseCall()) return 'call';
		if (i === before) i += 1;
		const consumed = source[before] ?? '';
		return consumed === '(' || consumed === ')' || consumed === '{' || consumed === '}' ? consumed : 'other';
	}
	function skipNested(close: ')' | '}'): boolean {
		const open = close === ')' ? '(' : '{';
		let depth = 1;
		while (i < source.length && depth > 0) {
			const token = nextToken();
			if (token === 'eof') return false;
			// A recognized call consumes its opening paren and leaves the close behind.
			if (token === 'call' && close === ')') depth += 1;
			else if (token === open) depth += 1;
			else if (token === close) depth -= 1;
		}
		return depth === 0;
	}
	function skipGroup(close: ')' | '}'): boolean {
		const open = close === ')' ? '(' : '{';
		if (source[i] !== open) return false;
		i += 1;
		return skipNested(close);
	}
	function parseConstantPrimary(): string | null {
		skipTrivia();
		const char = source[i];
		if (char === "'" || char === '"') {
			const cooked = readQuoted(char);
			return cooked.closed ? cooked.value : null;
		}
		if (char === '(') {
			i += 1;
			const inner = parseConstant();
			if (inner === null) return null;
			skipTrivia();
			if (source[i] !== ')') return null;
			i += 1;
			return inner;
		}
		if (char === '`') return parseConstantTemplate();
		return null;
	}
	/** Folds `'a' + 'b'`. A non-constant term makes the whole sum unknown. */
	function parseConstant(): string | null {
		const first = parseConstantPrimary();
		if (first === null) return null;
		let out = first;
		while (true) {
			const mark = i;
			skipTrivia();
			if (source[i] !== '+') { i = mark; return out; }
			i += 1;
			const next = parseConstantPrimary();
			if (next === null) return null;
			out += next;
		}
	}
	function parseConstantTemplate(): string | null {
		i += 1;
		let out = '';
		while (i < source.length) {
			const char = source[i] ?? '';
			if (char === '\\') {
				const escaped = readEscape();
				if (escaped === null) return null;
				out += escaped;
				continue;
			}
			if (char === '`') { i += 1; return out; }
			if (char === '$' && source[i + 1] === '{') {
				i += 2;
				const inner = parseConstant();
				if (inner === null) return null;
				skipTrivia();
				if (source[i] !== '}') return null;
				i += 1;
				out += inner;
				continue;
			}
			out += char;
			i += 1;
		}
		return null;
	}
	function tryConstant(): string | null {
		const saved = i;
		const value = parseConstant();
		if (value === null) i = saved;
		return value;
	}
	/**
	 * The first literal is already consumed. Further `+` constants are appended.
	 * Any other continuation is unresolved and the cursor stays on that literal.
	 */
	function extendConstantSum(title: string): { title: string; unresolved: boolean } {
		const origin = i;
		let end = i;
		let out = title;
		while (true) {
			skipTrivia();
			if (source[i] === ',' || source[i] === ')' || source[i] === undefined) {
				i = end;
				return { title: out, unresolved: false };
			}
			if (source[i] !== '+') {
				i = origin;
				return { title: '', unresolved: true };
			}
			i += 1;
			const next = tryConstant();
			if (next === null) {
				i = origin;
				return { title: '', unresolved: true };
			}
			out += next;
			end = i;
		}
	}
	function pushText(segments: Segment[], text: string): void {
		const last = segments[segments.length - 1];
		if (last && last.kind === 'text') last.text += text;
		else segments.push({ kind: 'text', text });
	}
	function assess(segments: Segment[], cookFailed: boolean): { title: string; unresolved: boolean } {
		if (cookFailed || segments.some((segment) => segment.kind === 'hole')) {
			return { title: '', unresolved: true };
		}
		return {
			title: segments.map((segment) => segment.kind === 'text' ? segment.text : '').join(''),
			unresolved: false,
		};
	}
	function readTemplate(asTitle: boolean): TemplateRead {
		if (source[i] !== '`') return null;
		i += 1;
		const segments: Segment[] = [];
		let cookFailed = false;
		while (i < source.length) {
			const char = source[i] ?? '';
			if (char === '\\') {
				const escaped = readEscape();
				if (escaped === null) cookFailed = true;
				else pushText(segments, escaped);
				continue;
			}
			if (char === '`') {
				i += 1;
				if (!asTitle) return { skip: true };
				return assess(segments, cookFailed);
			}
			if (char === '$' && source[i + 1] === '{') {
				i += 2;
				const saved = i;
				const value = tryConstant();
				skipTrivia();
				if (value !== null && source[i] === '}') {
					i += 1;
					pushText(segments, value);
					continue;
				}
				i = saved;
				skipNested('}');
				segments.push({ kind: 'hole' });
				continue;
			}
			pushText(segments, char);
			i += 1;
		}
		return null;
	}
	function readDotWord(word: string): boolean {
		const saved = i;
		skipTrivia();
		if (source[i] !== '.') { i = saved; return false; }
		i += 1;
		skipTrivia();
		if (!source.startsWith(word, i) || isIdent(source[i + word.length] ?? '')) { i = saved; return false; }
		i += word.length;
		return true;
	}
	function parseCall(): boolean {
		const start = i;
		const hitCount = hits.length;
		const fail = (): boolean => { hits.length = hitCount; i = start; return false; };
		if (start > 0 && isIdent(source[start - 1] ?? '')) return false;
		let previous = start - 1;
		while (previous >= 0 && isSpace(source[previous] ?? '')) previous -= 1;
		if (previous >= 0 && source[previous] === '.') return false;
		const keyword = source.startsWith('test', start) && !isIdent(source[start + 4] ?? '') ? 'test'
			: source.startsWith('it', start) && !isIdent(source[start + 2] ?? '') ? 'it' : '';
		if (!keyword) return false;
		i = start + keyword.length;
		let each = false;
		let taggedEach = false;
		let modifiers = 0;
		while (modifiers < 3) {
			if (readDotWord('each')) {
				each = true;
				skipTrivia();
				if (source[i] === '`') {
					taggedEach = true;
					if (readTemplate(false) === null) {
						markUnresolved();
						return true;
					}
				} else if (!skipGroup(')')) return fail();
				break;
			}
			if (!(readDotWord('only') || readDotWord('skip') || readDotWord('concurrent'))) break;
			modifiers += 1;
		}
		skipTrivia();
		if (source[i] === '?' && source[i + 1] === '.') i += 2;
		skipTrivia();
		if (source[i] !== '(') {
			if (!taggedEach) return fail();
			markUnresolved();
			return true;
		}
		i += 1;
		skipTrivia();
		const quote = source[i] ?? '';
		function markUnresolved(): void {
			const end = i > start ? i : start + 1;
			hits.push({
				index: start, length: end - start, title: '',
				quote: source[end - 1] ?? '`', each: true, unresolved: true,
			});
		}
		function settle(title: string, unresolved: boolean): void {
			if (!unresolved) {
				const summed = extendConstantSum(title);
				title = summed.title;
				unresolved = summed.unresolved;
			}
			if (!unresolved && each && eachTitlePlaceholder(title)) {
				title = '';
				unresolved = true;
			}
			hits.push({
				index: start, length: i - start, title: unresolved ? '' : title,
				quote: source[i - 1] ?? quote, each, unresolved,
			});
		}
		if (quote === "'" || quote === '"') {
			const cooked = readQuoted(quote);
			if (!cooked.closed) return fail();
			settle(cooked.value ?? '', cooked.value === null);
			return true;
		}
		if (quote === '`') {
			const parsed = readTemplate(true);
			if (!parsed) return fail();
			if ('skip' in parsed) return true;
			settle(parsed.title, parsed.unresolved);
			return true;
		}
		if (titleCannotCarryCaseTag()) return fail();
		const grouped = groupedConstantTitle();
		if (grouped !== null) {
			const placeholder = each && eachTitlePlaceholder(grouped);
			hits.push({
				index: start, length: i - start, title: placeholder ? '' : grouped,
				quote: source[i - 1] ?? ')', each, unresolved: placeholder,
			});
			return true;
		}
		hits.push({ index: start, length: i - start, title: '', quote: '(', each, unresolved: true });
		return true;
	}
	function keywordAt(word: string): boolean {
		return source.startsWith(word, i) && !isIdent(source[i + word.length] ?? '');
	}
	/** A function title is the function's name, which cannot contain `@case`. */
	function titleCannotCarryCaseTag(): boolean {
		if (source[i] === ')' || source[i] === undefined) return true;
		if (keywordAt('function') || keywordAt('async')) return true;
		const saved = i;
		const savedHits = hits.length;
		let arrow = false;
		if (isIdent(source[i] ?? '')) {
			while (isIdent(source[i] ?? '')) i += 1;
			skipTrivia();
			arrow = source.startsWith('=>', i);
		} else if (source[i] === '(' && skipGroup(')')) {
			skipTrivia();
			arrow = source.startsWith('=>', i);
		}
		i = saved;
		hits.length = savedHits;
		return arrow;
	}
	function groupedConstantTitle(): string | null {
		if (source[i] !== '(') return null;
		const saved = i;
		const value = tryConstant();
		const end = i;
		skipTrivia();
		if (value !== null && (source[i] === ',' || source[i] === ')')) {
			i = end;
			return value;
		}
		i = saved;
		return null;
	}

	while (i < source.length) {
		const before = i;
		nextToken();
		if (i === before) i += 1;
	}
	hits.sort((left, right) => left.index - right.index || left.length - right.length);
	return hits;
}
