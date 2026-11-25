import { caseIdsInTitle, staticTestTitles, type StaticTestTitle } from '../acceptance/test-titles.ts';
import { extractBraced, maskIgnoredBraces, unmaskIgnoredBraces } from './brace-span.ts';
import { extractTestExcerpts } from './excerpt-extractor.ts';

function quotedTitle(title: string): string {
	if (!title.includes('"')) return `"${title}"`;
	if (!title.includes("'")) return `'${title}'`;
	if (!title.includes('`')) return `\`${title}\``;
	return `"${title.replaceAll('"', "'").replaceAll('`', "'")}"`;
}

/** Rewrites the call with the rendered title so the excerpt contains `@case ID`. */
function excerptSlice(source: string, hit: StaticTestTitle): string {
	const rest = callbackSlice(source, hit.index + hit.length);
	return `test(${quotedTitle(hit.title)}${rest}`;
}

function callbackSlice(source: string, fromIndex: number): string {
	const rest = source.slice(fromIndex);
	const brace = rest.indexOf('{');
	const arrow = rest.indexOf('=>');
	if (arrow !== -1 && (brace === -1 || arrow < brace)) {
		const after = rest.slice(arrow + 2);
		const trimmed = after.trimStart();
		const pad = after.length - trimmed.length;
		if (trimmed.startsWith('{')) {
			const open = fromIndex + arrow + 2 + pad;
			return source.slice(fromIndex, open + extractBraced(source, open).length);
		}
		const lineEnd = trimmed.indexOf('\n');
		const end = fromIndex + arrow + 2 + pad + (lineEnd === -1 ? trimmed.length : lineEnd);
		return source.slice(fromIndex, end);
	}
	if (brace === -1) return rest.slice(0, 500);
	const open = fromIndex + brace;
	return source.slice(fromIndex, open + extractBraced(source, open).length);
}

/** Keeps the it/test bodies whose titles cite the obligated case ids. */
export function excerptObligatedCases({
	filePath, source, caseIds, maxBytes,
}: {
	filePath: string;
	source: string;
	caseIds: readonly string[];
	maxBytes: number;
}): { text: string; missingCaseIds: readonly string[] } {
	const requested = new Set(caseIds);
	const found = new Set<string>();
	const slices: string[] = [];
	for (const hit of staticTestTitles(source)) {
		if (hit.unresolved) continue;
		const cited = caseIdsInTitle(hit.title).filter((id) => requested.has(id));
		if (cited.length === 0) continue;
		for (const id of cited) found.add(id);
		slices.push(excerptSlice(source, hit));
	}
	const missingCaseIds = caseIds.filter((id) => !found.has(id));
	if (missingCaseIds.length > 0 || slices.length === 0) {
		return { text: '', missingCaseIds: missingCaseIds.length > 0 ? missingCaseIds : [...caseIds] };
	}
	const extracted = extractTestExcerpts({
		touchedFiles: [{ path: filePath, content: maskIgnoredBraces(slices.join('\n')) }],
		acceptanceCriteria: [...new Set(caseIds.map((id) => id.replace(/\.\d+$/, '')))],
		maxBytes,
		maxLines: 1000,
		softCapPerFile: 1000,
	});
	const text = unmaskIgnoredBraces(extracted.text);
	const absent = caseIds.filter((id) => !text.includes(`@case ${id}`));
	return { text: absent.length > 0 ? '' : text, missingCaseIds: absent };
}
