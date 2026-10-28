import fs from 'node:fs';
import path from 'node:path';

export interface SemanticFindingInput {
	path?: unknown;
	file?: unknown;
	lineRange?: unknown;
	evidence?: unknown;
}

export interface SemanticFindingEvidenceAssessment {
	citationGrounded: boolean;
	deterministicallyCorroborated: boolean;
	reason:
		| 'MISSING_PATH'
		| 'OUT_OF_SCOPE_PATH'
		| 'FILE_NOT_FOUND'
		| 'OUT_OF_SCOPE_REAL_PATH'
		| 'MISSING_OR_INVALID_LINE_RANGE'
		| 'LINE_RANGE_OUT_OF_BOUNDS'
		| 'EMPTY_EVIDENCE'
		| 'CITATION_MATCHED'
		| 'EVIDENCE_NOT_IN_CITED_RANGE';
	path: string | null;
	lineRange: readonly [number, number] | null;
	excerpt?: string;
}

function isWithin(candidate: string, parent: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeEvidence(value: unknown): string {
	return String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim();
}

function asFinding(finding: unknown): SemanticFindingInput | null {
	return finding && typeof finding === 'object' ? (finding as SemanticFindingInput) : null;
}

function citedPath(finding: unknown): unknown {
	const rec = asFinding(finding);
	return rec?.path || rec?.file || null;
}

function citedRange(finding: unknown): readonly [number, number] | null {
	const rec = asFinding(finding);
	const range = rec?.lineRange;
	if (
		!Array.isArray(range) ||
		range.length !== 2 ||
		typeof range[0] !== 'number' ||
		typeof range[1] !== 'number' ||
		!Number.isInteger(range[0]) ||
		!Number.isInteger(range[1]) ||
		range[0] < 1 ||
		range[1] < range[0]
	) {
		return null;
	}
	return [range[0], range[1]];
}

function authorizedRoots(
	worktreeDir: string,
	allowedPathPrefixes: readonly string[] | null | undefined,
): { worktreeRoot: string; roots: string[] } {
	const worktreeRoot = fs.realpathSync(worktreeDir);
	return {
		worktreeRoot,
		roots: (allowedPathPrefixes ?? []).map((prefix) =>
			path.resolve(worktreeRoot, prefix),
		),
	};
}

export function assessSemanticFindingEvidence({
	finding,
	worktreeDir,
	allowedPathPrefixes,
}: {
	finding: unknown;
	worktreeDir: string;
	allowedPathPrefixes?: readonly string[] | null;
}): Readonly<SemanticFindingEvidenceAssessment> {
	const relativePath = citedPath(finding);
	if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
		return Object.freeze({
			citationGrounded: false,
			deterministicallyCorroborated: false,
			reason: 'MISSING_PATH',
			path: null,
			lineRange: citedRange(finding),
		});
	}

	const { worktreeRoot, roots } = authorizedRoots(worktreeDir, allowedPathPrefixes);
	const candidate = path.resolve(worktreeRoot, relativePath);
	if (
		!isWithin(candidate, worktreeRoot) ||
		!roots.some((root) => isWithin(candidate, root))
	) {
		return Object.freeze({
			citationGrounded: false,
			deterministicallyCorroborated: false,
			reason: 'OUT_OF_SCOPE_PATH',
			path: relativePath,
			lineRange: citedRange(finding),
		});
	}

	if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
		return Object.freeze({
			citationGrounded: false,
			deterministicallyCorroborated: false,
			reason: 'FILE_NOT_FOUND',
			path: relativePath,
			lineRange: citedRange(finding),
		});
	}

	const realCandidate = fs.realpathSync(candidate);
	if (
		!isWithin(realCandidate, worktreeRoot) ||
		!roots.some((root) => isWithin(realCandidate, root))
	) {
		return Object.freeze({
			citationGrounded: false,
			deterministicallyCorroborated: false,
			reason: 'OUT_OF_SCOPE_REAL_PATH',
			path: relativePath,
			lineRange: citedRange(finding),
		});
	}

	const lineRange = citedRange(finding);
	if (!lineRange) {
		return Object.freeze({
			citationGrounded: false,
			deterministicallyCorroborated: false,
			reason: 'MISSING_OR_INVALID_LINE_RANGE',
			path: relativePath,
			lineRange: null,
		});
	}

	const lines = fs.readFileSync(realCandidate, 'utf8').split(/\r?\n/);
	if (lineRange[1] > lines.length) {
		return Object.freeze({
			citationGrounded: false,
			deterministicallyCorroborated: false,
			reason: 'LINE_RANGE_OUT_OF_BOUNDS',
			path: relativePath,
			lineRange,
		});
	}

	const rec = asFinding(finding);
	const evidence = normalizeEvidence(rec?.evidence);
	if (evidence.length === 0) {
		return Object.freeze({
			citationGrounded: false,
			deterministicallyCorroborated: false,
			reason: 'EMPTY_EVIDENCE',
			path: relativePath,
			lineRange,
		});
	}

	const excerpt = normalizeEvidence(lines.slice(lineRange[0] - 1, lineRange[1]).join('\n'));
	const citationGrounded =
		excerpt.length > 0 &&
		(excerpt.includes(evidence) || evidence.includes(excerpt));
	return Object.freeze({
		citationGrounded,
		deterministicallyCorroborated: false,
		reason: citationGrounded ? 'CITATION_MATCHED' : 'EVIDENCE_NOT_IN_CITED_RANGE',
		path: relativePath,
		lineRange,
		excerpt,
	});
}

export function assessSemanticFindings<TFinding = unknown, TSource = string>({
	findings,
	worktreeDir,
	allowedPathPrefixes,
	source,
}: {
	findings?: readonly TFinding[] | null;
	worktreeDir: string;
	allowedPathPrefixes?: readonly string[] | null;
	source?: TSource;
}): Array<{
	source: TSource | undefined;
	finding: TFinding;
	assessment: Readonly<SemanticFindingEvidenceAssessment>;
}> {
	return (findings ?? []).map((finding) => ({
		source,
		finding,
		assessment: assessSemanticFindingEvidence({
			finding,
			worktreeDir,
			allowedPathPrefixes,
		}),
	}));
}
