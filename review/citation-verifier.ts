// Deterministic, filesystem-backed grounding checks for critic-review findings.
//
// LLM critic reviewers occasionally cite files that do not exist, or cite real files
// with line ranges that fall outside the file's actual length (fabrication observed
// in live agent-sdlc runs: nonexistent paths like `tests/session_test.rb`, and a
// 14-line file cited with `lineRange: "50-55"`). These checks never require a model
// call: a citation either resolves to a real, in-range location on disk or it does not.
//
// This module intentionally does NOT attempt fuzzy/basename-only path resolution:
// a wrong-but-plausible-looking path must fail verification rather than silently
// resolve to an unrelated same-named file elsewhere in the repository.

import fs from 'node:fs';
import path from 'node:path';

export type ResolvedCitedFile =
	| Readonly<{ found: true; absolutePath: string; matchedCandidate: string }>
	| Readonly<{ found: false }>;

export interface ParsedLineRange {
	start: number;
	end: number;
}

export interface CitationFindingLike {
	file?: unknown;
	lineRange?: unknown;
	severity?: string;
	category?: string;
	evidence?: string;
	impact?: string;
	remediation?: string;
	[key: string]: unknown;
}

export type GroundingCheckedFinding<T extends CitationFindingLike = CitationFindingLike> = T & {
	groundingVerified: boolean;
	groundingReason: string | null;
};

/**
 * Normalize a model-cited path into a small set of candidate relative paths to try
 * against the repository root. Handles common variations: leading `./`, backslashes,
 * and unified-diff `a/`/`b/` prefixes.
 */
export function candidatePaths(rawPath: unknown): string[] {
	if (typeof rawPath !== 'string') return [];
	const trimmed = rawPath.trim().replace(/^["'`]+|["'`]+$/g, '');
	if (!trimmed) return [];

	const slashed = trimmed.replace(/\\/g, '/');
	const candidates = new Set<string>();
	candidates.add(slashed);
	candidates.add(slashed.replace(/^\.\//, ''));
	candidates.add(slashed.replace(/^[ab]\//, ''));
	candidates.add(slashed.replace(/^\.\//, '').replace(/^[ab]\//, ''));

	return [...candidates].filter((value) => value.length > 0 && !path.isAbsolute(value));
}

/**
 * Resolve a cited file path against rootDir. Returns { found: false } unless one of the
 * normalized candidates exists on disk as a regular file.
 */
export function resolveCitedFile({
	rootDir,
	file,
}: {
	rootDir: string;
	file: unknown;
}): ResolvedCitedFile {
	for (const candidate of candidatePaths(file)) {
		const absolutePath = path.join(rootDir, candidate);
		if (!absolutePath.startsWith(path.resolve(rootDir))) continue; // reject path escapes
		try {
			const stat = fs.statSync(absolutePath);
			if (stat.isFile()) {
				return Object.freeze({ found: true, absolutePath, matchedCandidate: candidate });
			}
		} catch {
			// candidate does not exist; try the next one
		}
	}
	return Object.freeze({ found: false });
}

/**
 * Parse a free-form lineRange citation ("50-55", "(50-55)", "L50-L55", "50") into
 * { start, end } integers, or null if it cannot be parsed as a numeric range.
 */
export function parseLineRange(raw: unknown): ParsedLineRange | null {
	if (typeof raw !== 'string') return null;
	const match = raw.match(/L?(\d+)\s*(?:-|to|–)\s*L?(\d+)/i);
	if (match && match[1] !== undefined && match[2] !== undefined) {
		const start = Number.parseInt(match[1], 10);
		const end = Number.parseInt(match[2], 10);
		if (Number.isSafeInteger(start) && Number.isSafeInteger(end)) {
			return { start: Math.min(start, end), end: Math.max(start, end) };
		}
		return null;
	}
	const single = raw.match(/(\d+)/);
	if (single && single[1] !== undefined) {
		const line = Number.parseInt(single[1], 10);
		if (Number.isSafeInteger(line)) return { start: line, end: line };
	}
	return null;
}

function countLines(absolutePath: string): number {
	const content = fs.readFileSync(absolutePath, 'utf8');
	if (content.length === 0) return 0;
	const lines = content.split('\n');
	// A trailing newline produces one extra empty segment; do not count it as a line.
	return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/**
 * Distinguish a literal file-path citation (e.g. `packages/example/src/foo.ts`,
 * `foo.ts:12-14`) from a symbolic/document-level citation (e.g. `plan`, `spec`,
 * `n/a`). Spec/plan-phase critics are only shown a structured document, not an
 * exhaustive file list (see packSpecDocument/packPlanDocument), so they legitimately
 * cite the document itself rather than a specific repository file. Only citations
 * that look like real paths (a path separator or a file extension) are checked
 * against the filesystem; bare symbolic words are not fabrication candidates and
 * are left ungrounded-but-unchecked (verified as-is).
 */
export function looksLikeFileCitation(rawPath: unknown): boolean {
	if (typeof rawPath !== 'string') return false;
	const trimmed = rawPath.trim();
	if (!trimmed) return false;
	return (
		trimmed.includes('/') ||
		trimmed.includes('\\') ||
		/\.[a-zA-Z0-9]{1,10}(:\d|$)/.test(trimmed)
	);
}

/**
 * Verify a single finding's `file`/`lineRange` citation against the real filesystem.
 * Returns the finding unchanged plus `groundingVerified` (boolean) and `groundingReason`
 * (string, only present when unverified).
 */
export function verifyFindingGrounding<T extends CitationFindingLike>({
	finding,
	rootDir,
}: {
	finding: T;
	rootDir: string;
}): GroundingCheckedFinding<T> {
	const file = typeof finding?.file === 'string' ? finding.file.trim() : '';
	if (!file) {
		return { ...finding, groundingVerified: false, groundingReason: 'missing-file-citation' };
	}

	if (!looksLikeFileCitation(file)) {
		// Symbolic/document-level citation (e.g. plan-phase "plan"): not a filesystem
		// claim, so there is nothing deterministic to verify it against.
		return { ...finding, groundingVerified: true, groundingReason: null };
	}

	const resolved = resolveCitedFile({ rootDir, file });
	if (!resolved.found) {
		return {
			...finding,
			groundingVerified: false,
			groundingReason: `file-not-found: '${file}' does not exist under repository root`,
		};
	}

	const range = parseLineRange(finding.lineRange);
	if (range) {
		const totalLines = countLines(resolved.absolutePath);
		if (range.start > totalLines || range.end > totalLines) {
			return {
				...finding,
				groundingVerified: false,
				groundingReason: `line-range-out-of-bounds: cited '${String(finding.lineRange)}' but '${file}' has ${totalLines} line(s)`,
			};
		}
	}

	return { ...finding, groundingVerified: true, groundingReason: null };
}

/**
 * Partition findings into filesystem-grounded and ungrounded sets. Ungrounded findings
 * are never silently discarded by this function alone: callers are expected to exclude
 * them from severity/status scoring while still surfacing them (e.g. in a review report)
 * for human audit.
 */
export function verifyFindings<T extends CitationFindingLike>({
	findings = [],
	rootDir,
}: {
	findings?: readonly T[];
	rootDir: string;
}): Readonly<{
	verified: readonly GroundingCheckedFinding<T>[];
	unverified: readonly GroundingCheckedFinding<T>[];
}> {
	const verified: GroundingCheckedFinding<T>[] = [];
	const unverified: GroundingCheckedFinding<T>[] = [];
	for (const finding of findings) {
		const checked = verifyFindingGrounding({ finding, rootDir });
		if (checked.groundingVerified) {
			verified.push(checked);
		} else {
			unverified.push(checked);
		}
	}
	return Object.freeze({
		verified: Object.freeze(verified),
		unverified: Object.freeze(unverified),
	});
}
