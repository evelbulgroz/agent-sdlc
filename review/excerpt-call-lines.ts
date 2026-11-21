export interface CallLine {
	index: number;
	text: string;
}

/** Paren depth change of one source line. Quotes do not carry across lines. */
export function parenDelta(text: string): number {
	let depth = 0;
	let quote = '';
	let escape = false;
	for (const ch of text) {
		if (escape) {
			escape = false;
			continue;
		}
		if (quote) {
			if (ch === '\\') escape = true;
			else if (ch === quote) quote = '';
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') quote = ch;
		else if (ch === '(') depth += 1;
		else if (ch === ')') depth -= 1;
	}
	return depth;
}

/** Opener plus following lines until the expect( or assert( call closes. */
export function assertionCallSpan(lines: readonly string[], start: number, maxLines = 12): CallLine[] {
	const span: CallLine[] = [{ index: start, text: lines[start] ?? '' }];
	let depth = parenDelta(span[0]?.text ?? '');
	for (let i = start + 1; depth > 0 && i < lines.length && span.length < maxLines; i++) {
		const text = lines[i] ?? '';
		span.push({ index: i, text });
		depth += parenDelta(text);
	}
	return span;
}
