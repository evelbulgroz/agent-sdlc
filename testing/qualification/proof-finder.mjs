const DECLARATION_RE = /(?:^|\n)([ \t]*)(?:test|it)(?:\.\w+)?\(\s*(['"`])/g;

/** Returns the source from the top-level test or it declaration titled exactly `title` (any quote style) to the next top-level one, or null. */
export function findProofBody(source, title) {
	const declarations = [...source.matchAll(DECLARATION_RE)].map((m) => ({
		at: m[0].startsWith('\n') ? m.index + 1 : m.index,
		indent: m[1],
		quote: m[2],
		titleStart: m.index + m[0].length,
	}));
	const topLevel = declarations.filter((d) => d.indent === '');
	for (let i = 0; i < topLevel.length; i += 1) {
		const { at, quote, titleStart } = topLevel[i];
		if (source.startsWith(title + quote, titleStart)) {
			return source.slice(at, topLevel[i + 1]?.at);
		}
	}
	return null;
}
