const EXPECT_CALL_RE = /\bexpect\s*\(/g;
const ASSERT_CALL_RE = /\bassert(?:\.\w+)?\s*\(/g;
const LITERAL = String.raw`(?:true|false|null|undefined|\d+(?:\.\d+)?|'[^'\n]*'|"[^"\n]*")`;
const NOOP_EXPECT_RE = new RegExp(
	String.raw`\bexpect\s*\(\s*${LITERAL}\s*\)\s*\.\s*(?:not\s*\.\s*)?\w+\s*\(`,
	'g',
);
// A subject-agnostic matcher that only proves the value exists.
const EXISTENCE_EXPECT_RE =
	/\bexpect\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*\.\s*(?:toBeDefined\s*\(\s*\)|toBeTruthy\s*\(\s*\)|not\s*\.\s*toBeUndefined\s*\(\s*\)|not\s*\.\s*toBeNull\s*\(\s*\))/g;
const NOOP_ASSERT_RE = new RegExp(String.raw`\bassert(?:\.ok)?\s*\(\s*${LITERAL}\s*[,)]`, 'g');

function count(re: RegExp, text: string): number {
	return [...text.matchAll(re)].length;
}

/**
 * True when a test body has assertions and every one is a no-op: a literal subject
 * (`expect(true)`) or an existence-only matcher (`toBeDefined()`). Any assertion this
 * cannot classify counts as meaningful, so the check errs toward silence.
 */
export function hasOnlyNoopAssertions(body: string): boolean {
	const total = count(EXPECT_CALL_RE, body) + count(ASSERT_CALL_RE, body);
	if (total === 0) return false;
	const noop =
		new Set([...body.matchAll(NOOP_EXPECT_RE), ...body.matchAll(EXISTENCE_EXPECT_RE)].map((m) => m.index)).size +
		count(NOOP_ASSERT_RE, body);
	return noop >= total;
}
