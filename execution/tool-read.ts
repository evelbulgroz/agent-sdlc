import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SdlcError } from '../policy/errors.ts';
import { type ReadWindowParameters, selectReadWindow } from './read-window.ts';
import { assertToolPathContained, normalizeRelPath } from './tool-path-guards.ts';
import {
	type FindFilesResult,
	type GrepResult,
	type ListDirResult,
	type SearchToolParameters,
	executeSearchTool,
} from './tool-search.ts';

const WORKTREE_WALK_SKIP: ReadonlySet<string> = new Set([
	'node_modules',
	'.git',
	'.agent-sdlc',
	'dist',
	'coverage',
	'.tmp',
	'.turbo',
]);
const PAIRED_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
	'.js',
	'.jsx',
	'.ts',
	'.tsx',
	'.mjs',
	'.cjs',
]);

export interface ReadFileToolResult {
	readonly content: string;
	readonly byteLength: number;
	readonly hash: string;
	readonly totalLines: number;
	readonly shownStartLine: number;
	readonly shownEndLine: number;
	readonly truncated: boolean;
	readonly pagedPath?: string | null;
	readonly requestedPath?: unknown;
	readonly resolvedPath?: string | null;
}

export interface ReadToolContext {
	readonly worktreeDir: string;
	readonly wholeFile?: boolean;
	readonly pageOverflow?: boolean;
	readonly [key: string]: unknown;
}

export interface PagedTextResult {
	readonly text: string;
	readonly byteLength: number;
	readonly pagedPath: string | null;
}

function normalizedFileStem(fileName: string): string {
	const extension = path.extname(fileName);
	return path
		.basename(fileName, extension)
		.replace(/[^a-z0-9]/gi, '')
		.toLowerCase();
}

/**
 * Basename matches outside the missing path's directory. A unique match is
 * returned as a candidate and is not read. Same-directory correction stays
 * in `uniqueSourceFileCandidate`.
 */
function workspaceBasenameCandidates(requestedRelPath: string, worktreeDir: string): string[] {
	const requestedName = path.basename(requestedRelPath);
	const requestedExtension = path.extname(requestedName).toLowerCase();
	const stem = normalizedFileStem(requestedName);
	if (stem.length < 3) return [];
	const sourceRequest = PAIRED_SOURCE_EXTENSIONS.has(requestedExtension);
	const matches: string[] = [];
	const walk = (directory: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (WORKTREE_WALK_SKIP.has(entry.name)) continue;
				walk(absolute);
				continue;
			}
			if (!entry.isFile()) continue;
			const extension = path.extname(entry.name).toLowerCase();
			if (normalizedFileStem(entry.name) !== stem) continue;
			if (sourceRequest) {
				if (!PAIRED_SOURCE_EXTENSIONS.has(extension)) continue;
			} else if (extension !== requestedExtension) {
				continue;
			}
			matches.push(path.relative(worktreeDir, absolute).split(path.sep).join('/'));
		}
	};
	walk(worktreeDir);
	matches.sort();
	return matches;
}

function throwMissingRead(
	rawPath: unknown,
	canonicalPath: string,
	suggestion: string,
	metadata: Record<string, unknown> = {},
): never {
	const extensionHint =
		path.extname(canonicalPath).toLowerCase() === '.js'
			? ' TypeScript source paths use .ts/.tsx; .js is for ESM import specifiers.'
			: '';
	throw new SdlcError(
		'INVALID_INPUT',
		`File '${String(rawPath)}' does not exist.${suggestion}${extensionHint} Do not repeat the same read_file call.`,
		metadata,
	);
}

function missingFileCandidates(resolvedPath: string, worktreeDir: string): string[] {
	const parent = path.dirname(resolvedPath);
	if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) return [];

	const requestedName = path.basename(resolvedPath);
	const requestedStem = path.basename(requestedName, path.extname(requestedName));
	const normalizedStem = requestedStem.replace(/[^a-z0-9]/gi, '').toLowerCase();
	if (!normalizedStem) return [];

	return fs
		.readdirSync(parent, { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => {
			const stem = path.basename(entry.name, path.extname(entry.name));
			const normalized = stem.replace(/[^a-z0-9]/gi, '').toLowerCase();
			return {
				path: path.relative(worktreeDir, path.join(parent, entry.name)).split(path.sep).join('/'),
				score:
					normalized === normalizedStem
						? 0
						: normalized.includes(normalizedStem) || normalizedStem.includes(normalized)
							? 1
							: 2,
			};
		})
		.filter((candidate) => candidate.score < 2)
		.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
		.slice(0, 5)
		.map((candidate) => candidate.path);
}

function uniqueSourceFileCandidate(rawPath: unknown, candidates: readonly string[]): string | null {
	const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx']);
	const requestedExtension = path.extname(String(rawPath)).toLowerCase();
	if (!sourceExtensions.has(requestedExtension)) return null;
	const requestedStem = path
		.basename(String(rawPath), requestedExtension)
		.replace(/[^a-z0-9]/gi, '')
		.toLowerCase();
	const exactSourceCandidates = candidates.filter((candidate) => {
		const candidateExtension = path.extname(candidate).toLowerCase();
		const candidateStem = path
			.basename(candidate, candidateExtension)
			.replace(/[^a-z0-9]/gi, '')
			.toLowerCase();
		return sourceExtensions.has(candidateExtension) && candidateStem === requestedStem;
	});
	return exactSourceCandidates.length === 1 ? (exactSourceCandidates[0] ?? null) : null;
}

export const EXECUTOR_PAGE_DIR = '.tmp/executor-pages';
export const EXECUTOR_INLINE_BYTE_CAP = 32_000;
export const EXECUTOR_PAGE_EDGE_LINES = 40;

export function isExecutorPagePath(relPath: unknown): boolean {
	const normalized = normalizeRelPath(relPath);
	return normalized === EXECUTOR_PAGE_DIR || normalized.startsWith(`${EXECUTOR_PAGE_DIR}/`);
}

// Oversized tool text stays in the worktree. The model sees the path plus the
// first and last 40 lines, then reads a bounded range. Callers that omit
// pageOverflow keep the existing truncation path.
export function presentPagedText(
	text: unknown,
	{ worktreeDir, name }: { worktreeDir: string; name?: unknown },
): PagedTextResult {
	const value = String(text ?? '');
	const byteLength = Buffer.byteLength(value, 'utf8');
	if (byteLength <= EXECUTOR_INLINE_BYTE_CAP) {
		return { text: value, byteLength, pagedPath: null };
	}
	const safeName =
		String(name ?? 'page')
			.replace(/[^a-zA-Z0-9._-]+/g, '-')
			.slice(0, 80) || 'page';
	const rel = `${EXECUTOR_PAGE_DIR}/${safeName}.txt`;
	const absolute = path.join(worktreeDir, ...rel.split('/'));
	try {
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, value, 'utf8');
	} catch (error) {
		if (error instanceof SdlcError) throw error;
		const msg = error instanceof Error ? error.message : String(error);
		throw new SdlcError('TASK_EXECUTION_FAILED', `page-write-failed: ${msg}`, {
			path: rel,
		});
	}
	const lines = value.split('\n');
	const head = lines.slice(0, EXECUTOR_PAGE_EDGE_LINES);
	const tail = lines.slice(-EXECUTOR_PAGE_EDGE_LINES);
	return {
		text: `${rel}\n${head.join('\n')}\n${tail.join('\n')}`,
		byteLength,
		pagedPath: rel,
	};
}

function selectExecutorLineRange(
	content: string,
	parameters: ReadWindowParameters | null | undefined,
): {
	text: string;
	totalLines: number;
	shownStartLine: number;
	shownEndLine: number;
} {
	const lines = content.split('\n');
	const totalLines = lines.length;
	const start = parameters?.start_line == null ? 1 : parameters.start_line;
	const end = parameters?.end_line == null ? totalLines + 1 : parameters.end_line;
	if (typeof start !== 'number' || !Number.isInteger(start) || start < 1 || start > totalLines) {
		throw new SdlcError(
			'INVALID_INPUT',
			`start_line must be an integer from 1 to ${totalLines}`,
		);
	}
	if (typeof end !== 'number' || !Number.isInteger(end) || end < start || end > totalLines + 1) {
		throw new SdlcError(
			'INVALID_INPUT',
			`end_line must be an exclusive integer from ${start} to ${totalLines + 1}`,
		);
	}
	return {
		text: lines.slice(start - 1, end - 1).join('\n'),
		totalLines,
		shownStartLine: start,
		shownEndLine: end,
	};
}

function readFilePageOverflow(
	content: string,
	parameters: ReadWindowParameters | null | undefined,
	{
		worktreeDir,
		rawPath,
		resolvedPath,
		sourcePath,
	}: {
		worktreeDir: string;
		rawPath: unknown;
		resolvedPath: string | null;
		sourcePath: string;
	},
): ReadFileToolResult {
	const range = selectExecutorLineRange(content, parameters);
	const bytes = Buffer.byteLength(range.text, 'utf8');
	let visible = range.text;
	let pagedPath: string | null = null;
	let truncated = false;
	if (!isExecutorPagePath(sourcePath) && bytes > EXECUTOR_INLINE_BYTE_CAP) {
		const paged = presentPagedText(range.text, {
			worktreeDir,
			name: `read-${crypto.createHash('sha256').update(sourcePath).digest('hex').slice(0, 12)}-${range.shownStartLine}-${range.shownEndLine}`,
		});
		visible = paged.text;
		pagedPath = paged.pagedPath;
		truncated = pagedPath !== null;
	}
	return {
		content: visible,
		byteLength: bytes,
		hash: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
		totalLines: range.totalLines,
		shownStartLine: range.shownStartLine,
		shownEndLine: range.shownEndLine,
		truncated,
		pagedPath,
		...(resolvedPath ? { requestedPath: rawPath, resolvedPath } : {}),
	};
}

export function readFileTool(
	parameters: ReadWindowParameters | null | undefined,
	{ worktreeDir, wholeFile = false, pageOverflow = false }: ReadToolContext,
): ReadFileToolResult {
	const rawPath = parameters?.path;
	const canonicalPath = normalizeRelPath(rawPath);
	let resolved = assertToolPathContained(worktreeDir, canonicalPath);
	let resolvedPath: string | null = canonicalPath === rawPath ? null : canonicalPath;
	if (!fs.existsSync(resolved)) {
		const candidates = missingFileCandidates(resolved, worktreeDir);
		resolvedPath = uniqueSourceFileCandidate(canonicalPath, candidates);
		if (resolvedPath) {
			resolved = assertToolPathContained(worktreeDir, resolvedPath);
		} else {
			const workspace =
				candidates.length === 0 ? workspaceBasenameCandidates(canonicalPath, worktreeDir) : [];
			const shown = candidates.length > 0 ? candidates : workspace.slice(0, 5);
			const uniqueWorkspace = workspace.length === 1 ? (workspace[0] ?? null) : null;
			const extra =
				workspace.length > shown.length ? ` (${workspace.length} matches)` : '';
			const suggestion =
				shown.length > 0
					? ` Did you mean ${shown.map((candidate) => `'${candidate}'`).join(' or ')}?${extra}`
					: ' Use list_dir or find_files to discover the actual path before retrying.';
			const metadata = uniqueWorkspace
				? { candidatePath: uniqueWorkspace }
				: shown.length > 0
					? { candidates: shown }
					: {};
			throwMissingRead(rawPath, canonicalPath, suggestion, metadata);
		}
	}
	const stat = fs.statSync(resolved);
	if (!stat.isFile()) {
		throw new SdlcError('INVALID_INPUT', `Path '${String(rawPath)}' is not a file`);
	}
	const content = fs.readFileSync(resolved, 'utf8');
	if (pageOverflow === true) {
		return readFilePageOverflow(content, parameters, {
			worktreeDir,
			rawPath,
			resolvedPath,
			sourcePath: resolvedPath ?? canonicalPath,
		});
	}
	if (wholeFile === true) {
		const lines = content.split('\n');
		return {
			content,
			byteLength: Buffer.byteLength(content, 'utf8'),
			hash: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
			totalLines: lines.length,
			shownStartLine: 1,
			shownEndLine: lines.length + 1,
			truncated: false,
			...(resolvedPath ? { requestedPath: rawPath, resolvedPath } : {}),
		};
	}
	const window = selectReadWindow(content, parameters ?? {});
	return {
		content: window.content,
		byteLength: Buffer.byteLength(content, 'utf8'),
		hash: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
		totalLines: window.totalLines,
		shownStartLine: window.shownStartLine,
		shownEndLine: window.shownEndLine,
		truncated: window.truncated,
		...(resolvedPath ? { requestedPath: rawPath, resolvedPath } : {}),
	};
}

export function executeReadTool(
	toolName: string,
	parameters: (ReadWindowParameters & SearchToolParameters) | null | undefined,
	context: ReadToolContext,
): ReadFileToolResult | ListDirResult | GrepResult | FindFilesResult | null {
	if (toolName === 'read_file') return readFileTool(parameters, context);
	return executeSearchTool(toolName, parameters, context);
}
