import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type ParserConfig, parseSync } from '@swc/core';
import { SdlcError } from '../policy/errors.ts';
import { assertToolPathContained, normalizeRelPath } from './tool-path-guards.ts';

export const WRITE_SHRINK_MIN_EXISTING_LINES = 40;
export const WRITE_SHRINK_KEEP_RATIO = 0.8;

export interface MutationToolParameters {
	readonly path?: unknown;
	readonly content?: unknown;
	readonly old_string?: unknown;
	readonly oldString?: unknown;
	readonly new_string?: unknown;
	readonly newString?: unknown;
	readonly expected_file_hash?: unknown;
	readonly expectedFileHash?: unknown;
	readonly start_line?: unknown;
	readonly end_line?: unknown;
	readonly acknowledgedShrink?: unknown;
	readonly [key: string]: unknown;
}

export interface MutationToolContext {
	readonly worktreeDir: string;
	readonly allowedPathPrefixes?: readonly string[] | null;
	readonly originalContentHash?: string | null;
}

export function assertWritePreservesExistingFile(
	rawPath: unknown,
	existingContent: unknown,
	nextContent: unknown,
	{ acknowledgedShrink = false }: { acknowledgedShrink?: boolean } = {},
): { acknowledgedShrink: boolean } {
	const existingLines = String(existingContent).split('\n').length;
	if (existingLines < WRITE_SHRINK_MIN_EXISTING_LINES) {
		return { acknowledgedShrink: false };
	}
	const nextLines = String(nextContent).split('\n').length;
	const minKeep = Math.ceil(existingLines * WRITE_SHRINK_KEEP_RATIO);
	if (nextLines < minKeep) {
		if (acknowledgedShrink === true) {
			return { acknowledgedShrink: true };
		}
		throw new SdlcError(
			'INVALID_INPUT',
			`write_file '${String(rawPath)}' shrinks the file from ${existingLines} to ${nextLines} lines (must keep at least ${minKeep}). Emit the full existing file plus the spec delta; do not drop unrelated methods, tests, or imports. If this shrink is an explicit, intended refactor, retry with 'acknowledgedShrink: true'.`,
		);
	}
	return { acknowledgedShrink: false };
}

const RECOGNIZED_SOURCE_EXTENSION_PATTERN = /\.(?:[cm]?[jt]sx?)$/;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*m/g;

function swcSyntaxOptionsForPath(rawPath: string): ParserConfig {
	const isTypeScript = /\.([cm]?ts|tsx)$/.test(rawPath);
	if (isTypeScript) {
		return {
			syntax: 'typescript',
			tsx: /\.tsx$/.test(rawPath),
			decorators: true,
			dynamicImport: true,
		};
	}
	return {
		syntax: 'ecmascript',
		jsx: /\.jsx$/.test(rawPath),
		decorators: true,
		dynamicImport: true,
	};
}

type BracketChar = '(' | ')' | '{' | '}' | '[' | ']';

const BRACKET_PAIRS: ReadonlyArray<readonly [BracketChar, BracketChar]> = [
	['{', '}'],
	['(', ')'],
	['[', ']'],
];

function isBracketChar(ch: string): ch is BracketChar {
	return ch === '(' || ch === ')' || ch === '{' || ch === '}' || ch === '[' || ch === ']';
}

function countBracketChars(text: string): Record<BracketChar, number> {
	const counts: Record<BracketChar, number> = {
		'(': 0,
		')': 0,
		'{': 0,
		'}': 0,
		'[': 0,
		']': 0,
	};
	for (const ch of text) {
		if (isBracketChar(ch)) counts[ch] += 1;
	}
	return counts;
}

// Diagnoses why a replace_in_file/replace_snapshot_range edit unbalances a file's
// brackets: given the text an edit removes and the text it inserts, computes, per
// bracket type, how much the edit shifts the file's open-vs-close balance.
function describeBracketBalanceShift(removedContent: string, newString: string): string | null {
	const removedCounts = countBracketChars(removedContent);
	const newCounts = countBracketChars(newString);
	const parts: string[] = [];
	for (const [open, close] of BRACKET_PAIRS) {
		const shift =
			newCounts[open] - removedCounts[open] - (newCounts[close] - removedCounts[close]);
		if (shift !== 0) {
			parts.push(`${open}${close}: ${shift > 0 ? '+' : ''}${shift}`);
		}
	}
	if (parts.length === 0) return null;
	return (
		`Edit shifts bracket balance by { ${parts.join(', ')} }. This usually means the replaced ` +
		'range starts or ends inside a block instead of at its boundary — re-read the file and ' +
		'either widen the range to fully contain the affected block(s), or add the missing ' +
		'bracket(s) to new_string.'
	);
}

export interface EditContext {
	readonly removedContent?: unknown;
	readonly newString?: unknown;
}

export function assertMutatedFileParses(
	rawPath: unknown,
	nextContent: string,
	editContext: EditContext | null = null,
): void {
	const pathStr = String(rawPath ?? '');
	if (!RECOGNIZED_SOURCE_EXTENSION_PATTERN.test(pathStr)) return;
	try {
		parseSync(nextContent, swcSyntaxOptionsForPath(pathStr));
	} catch (error) {
		const rawMsg =
			error && typeof error === 'object' && 'message' in error ? error.message : error;
		const parseError = String(rawMsg ?? error).replace(ANSI_ESCAPE_PATTERN, '');
		const bracketHint =
			editContext &&
			typeof editContext.removedContent === 'string' &&
			typeof editContext.newString === 'string'
				? describeBracketBalanceShift(editContext.removedContent, editContext.newString)
				: null;
		throw new SdlcError(
			'INVALID_INPUT',
			`Mutation to '${pathStr}' would leave the file syntactically unparseable: ${parseError}` +
				(bracketHint ? ` ${bracketHint}` : ''),
			{
				targetPath: pathStr,
				parseError,
				...(bracketHint ? { bracketBalanceHint: bracketHint } : {}),
			},
		);
	}
}

export function writeFileTool(
	parameters: MutationToolParameters | null | undefined,
	{ worktreeDir, allowedPathPrefixes }: MutationToolContext,
): {
	written: true;
	byteLength: number;
	hash: string;
	acknowledgedShrink?: true;
	requestedPath?: unknown;
	resolvedPath?: string;
} {
	const rawPath = parameters?.path;
	const canonicalPath = normalizeRelPath(rawPath);
	const content = parameters?.content;
	if (typeof content !== 'string') {
		throw new SdlcError('INVALID_INPUT', 'Content must be a string');
	}
	const resolved = assertToolPathContained(worktreeDir, canonicalPath, allowedPathPrefixes);
	let shrinkAcknowledged = false;
	if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
		const shrinkResult = assertWritePreservesExistingFile(
			rawPath,
			fs.readFileSync(resolved, 'utf8'),
			content,
			{ acknowledgedShrink: parameters?.acknowledgedShrink === true },
		);
		shrinkAcknowledged = shrinkResult.acknowledgedShrink;
	}
	assertMutatedFileParses(rawPath, content);
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	fs.writeFileSync(resolved, content, 'utf8');
	const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
	return {
		written: true,
		byteLength: Buffer.byteLength(content, 'utf8'),
		hash,
		...(shrinkAcknowledged ? { acknowledgedShrink: true } : {}),
		...(canonicalPath === rawPath ? {} : { requestedPath: rawPath, resolvedPath: canonicalPath }),
	};
}

export function replaceInFileTool(
	parameters: MutationToolParameters | null | undefined,
	{ worktreeDir, allowedPathPrefixes, originalContentHash = null }: MutationToolContext,
): {
	replaced: true;
	byteLength: number;
	hash: string;
	requestedPath?: unknown;
	resolvedPath?: string;
} {
	const rawPath = parameters?.path;
	const canonicalPath = normalizeRelPath(rawPath);
	const oldString =
		typeof parameters?.old_string === 'string' && parameters.old_string.length > 0
			? parameters.old_string
			: parameters?.oldString;
	const newString =
		typeof parameters?.new_string === 'string'
			? parameters.new_string
			: parameters?.newString;
	const expectedFileHash = parameters?.expected_file_hash ?? parameters?.expectedFileHash;
	if (typeof oldString !== 'string' || oldString.length === 0) {
		throw new SdlcError('INVALID_INPUT', 'old_string must be a non-empty string');
	}
	if (typeof newString !== 'string') {
		throw new SdlcError('INVALID_INPUT', 'new_string must be a string');
	}
	const resolved = assertToolPathContained(worktreeDir, canonicalPath, allowedPathPrefixes);
	if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
		throw new SdlcError('INVALID_INPUT', `File '${String(rawPath)}' does not exist`);
	}
	const existing = fs.readFileSync(resolved, 'utf8');
	const existingHash = crypto.createHash('sha256').update(existing, 'utf8').digest('hex');
	if (
		typeof expectedFileHash === 'string' &&
		expectedFileHash.length > 0 &&
		expectedFileHash !== existingHash
	) {
		throw new SdlcError(
			'STALE_FILE_SNAPSHOT',
			`File '${String(rawPath)}' changed since read_file. Read it again and use the new hash.`,
		);
	}
	const occurrences = existing.split(oldString).length - 1;
	if (occurrences === 0) {
		const regexHint = /\\[()[\]{}.*+?^$|]/.test(oldString)
			? ' replace_in_file uses literal text, not regex; remove regex escaping.'
			: '';
		throw new SdlcError(
			'INVALID_INPUT',
			`old_string not found in '${String(rawPath)}'. Copy an exact unique snippet from the latest read_file output.${regexHint}`,
		);
	}
	if (occurrences > 1) {
		throw new SdlcError(
			'INVALID_INPUT',
			`old_string matched ${occurrences} times in '${String(rawPath)}'. Include more surrounding lines so the snippet is unique.`,
		);
	}
	if (oldString === newString) {
		throw new SdlcError(
			'INVALID_INPUT',
			`replace_in_file '${String(rawPath)}' is a no-op: old_string equals new_string. Put the spec delta in new_string.`,
		);
	}
	const next = existing.replace(oldString, newString);
	if (next === existing) {
		throw new SdlcError(
			'INVALID_INPUT',
			`replace_in_file '${String(rawPath)}' is a no-op: the file bytes would not change. Put the spec delta in new_string.`,
		);
	}
	if (typeof originalContentHash === 'string' && originalContentHash.length === 64) {
		const nextHash = crypto.createHash('sha256').update(next, 'utf8').digest('hex');
		if (nextHash === originalContentHash) {
			throw new SdlcError(
				'INVALID_INPUT',
				`replace_in_file '${String(rawPath)}' would undo a successful earlier edit. Keep the spec delta; do not restore the original snippet.`,
			);
		}
	}
	assertWritePreservesExistingFile(rawPath, existing, next);
	assertMutatedFileParses(rawPath, next, { removedContent: oldString, newString });
	fs.writeFileSync(resolved, next, 'utf8');
	const hash = crypto.createHash('sha256').update(next, 'utf8').digest('hex');
	return {
		replaced: true,
		byteLength: Buffer.byteLength(next, 'utf8'),
		hash,
		...(canonicalPath === rawPath ? {} : { requestedPath: rawPath, resolvedPath: canonicalPath }),
	};
}

function applySnapshotRangeToContent(
	existing: string,
	{ start_line: startLine, end_line: endLine, new_string: newString }: MutationToolParameters = {},
	rawPath: unknown = '(unknown)',
): { next: string; removedContent: string; startLine: number; endLine: number } {
	if (
		typeof startLine !== 'number' ||
		typeof endLine !== 'number' ||
		!Number.isSafeInteger(startLine) ||
		!Number.isSafeInteger(endLine)
	) {
		throw new SdlcError(
			'INVALID_INPUT',
			'start_line and end_line must be safe integers',
		);
	}
	if (typeof newString !== 'string') {
		throw new SdlcError('INVALID_INPUT', 'new_string must be a string');
	}
	const lineStarts: number[] = [0];
	for (let index = 0; index < existing.length; index += 1) {
		if (existing[index] === '\n') lineStarts.push(index + 1);
	}
	const finalBoundary = lineStarts.length + 1;
	if (
		startLine < 1 ||
		endLine < startLine ||
		startLine > finalBoundary ||
		endLine > finalBoundary
	) {
		throw new SdlcError(
			'INVALID_INPUT',
			`replace_snapshot_range '${String(rawPath)}' requires 1-based half-open lines within 1..${finalBoundary}`,
		);
	}
	const offsetForBoundary = (line: number): number =>
		line === finalBoundary ? existing.length : (lineStarts[line - 1] ?? 0);
	const startOffset = offsetForBoundary(startLine);
	const endOffset = offsetForBoundary(endLine);
	if (startOffset === 0 && endOffset === existing.length) {
		throw new SdlcError(
			'INVALID_INPUT',
			`replace_snapshot_range '${String(rawPath)}' cannot rewrite the whole file`,
		);
	}
	const removedContent = existing.slice(startOffset, endOffset);
	const next = `${existing.slice(0, startOffset)}${newString}${existing.slice(endOffset)}`;
	if (next === existing) {
		throw new SdlcError(
			'INVALID_INPUT',
			`replace_snapshot_range '${String(rawPath)}' is a no-op`,
		);
	}
	return { next, removedContent, startLine, endLine };
}

export function replaceSnapshotRangeTool(
	parameters: MutationToolParameters | null | undefined,
	{ worktreeDir, allowedPathPrefixes, originalContentHash = null }: MutationToolContext,
): {
	replaced: true;
	byteLength: number;
	hash: string;
	removedContent: string;
	startLine: number;
	endLine: number;
	acknowledgedShrink?: true;
	requestedPath?: unknown;
	resolvedPath?: string;
} {
	const rawPath = parameters?.path;
	const canonicalPath = normalizeRelPath(rawPath);
	const expectedFileHash =
		parameters?.expected_file_hash ?? parameters?.expectedFileHash;
	if (typeof expectedFileHash !== 'string' || expectedFileHash.length !== 64) {
		throw new SdlcError(
			'INVALID_INPUT',
			'expected_file_hash must be the SHA-256 hash from read_file',
		);
	}
	const resolved = assertToolPathContained(
		worktreeDir,
		canonicalPath,
		allowedPathPrefixes,
	);
	if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
		throw new SdlcError('INVALID_INPUT', `File '${String(rawPath)}' does not exist`);
	}
	const existing = fs.readFileSync(resolved, 'utf8');
	const existingHash = crypto
		.createHash('sha256')
		.update(existing, 'utf8')
		.digest('hex');
	if (expectedFileHash !== existingHash) {
		throw new SdlcError(
			'STALE_FILE_SNAPSHOT',
			`File '${String(rawPath)}' changed since read_file. Read it again and use the new hash.`,
		);
	}
	const edit = applySnapshotRangeToContent(existing, parameters ?? {}, rawPath);
	if (
		typeof originalContentHash === 'string' &&
		originalContentHash.length === 64
	) {
		const nextHash = crypto
			.createHash('sha256')
			.update(edit.next, 'utf8')
			.digest('hex');
		if (nextHash === originalContentHash) {
			throw new SdlcError(
				'INVALID_INPUT',
				`replace_snapshot_range '${String(rawPath)}' would undo a successful earlier edit`,
			);
		}
	}
	const shrinkResult = assertWritePreservesExistingFile(rawPath, existing, edit.next, {
		acknowledgedShrink: parameters?.acknowledgedShrink === true,
	});
	assertMutatedFileParses(rawPath, edit.next, {
		removedContent: edit.removedContent,
		newString: parameters?.new_string,
	});
	fs.writeFileSync(resolved, edit.next, 'utf8');
	return {
		replaced: true,
		byteLength: Buffer.byteLength(edit.next, 'utf8'),
		hash: crypto.createHash('sha256').update(edit.next, 'utf8').digest('hex'),
		removedContent: edit.removedContent,
		startLine: edit.startLine,
		endLine: edit.endLine,
		...(shrinkResult.acknowledgedShrink ? { acknowledgedShrink: true } : {}),
		...(canonicalPath === rawPath
			? {}
			: { requestedPath: rawPath, resolvedPath: canonicalPath }),
	};
}

export function deleteFileTool(
	parameters: MutationToolParameters | null | undefined,
	{ worktreeDir, allowedPathPrefixes }: MutationToolContext,
): { deleted: boolean } {
	const rawPath = parameters?.path;
	const resolved = assertToolPathContained(worktreeDir, rawPath, allowedPathPrefixes);
	if (!fs.existsSync(resolved)) {
		return { deleted: false };
	}
	const stat = fs.statSync(resolved);
	if (stat.isDirectory()) {
		throw new SdlcError(
			'INVALID_INPUT',
			`Path '${String(rawPath)}' is a directory; delete_file only deletes regular files`,
		);
	}
	fs.unlinkSync(resolved);
	return { deleted: true };
}
