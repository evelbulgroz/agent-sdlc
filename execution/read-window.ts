import path from 'node:path';
import { SdlcError } from '../policy/errors.ts';

export interface ReadWindowParameters {
	readonly path?: unknown;
	readonly start_line?: unknown;
	readonly end_line?: unknown;
	readonly [key: string]: unknown;
}

export interface ReadWindowResult {
	readonly content?: unknown;
	readonly byteLength?: number;
	readonly totalLines?: number;
	readonly shownStartLine?: number;
	readonly shownEndLine?: number;
	readonly truncated?: boolean;
	readonly error?: unknown;
	readonly code?: unknown;
	readonly resolvedPath?: unknown;
	readonly candidatePath?: unknown;
	readonly candidates?: readonly unknown[];
	readonly [key: string]: unknown;
}

export interface ToolHistoryItem {
	readonly toolName?: string;
	readonly parameters?: {
		readonly path?: unknown;
		readonly command?: unknown;
		readonly args?: unknown;
		readonly start_line?: number | null;
		readonly end_line?: number | null;
		readonly [key: string]: unknown;
	};
	readonly result?: ReadWindowResult;
	readonly [key: string]: unknown;
}

export interface SelectedReadWindow {
	readonly content: string;
	readonly totalLines: number;
	readonly shownStartLine: number;
	readonly shownEndLine: number;
	readonly truncated: boolean;
}

export function normalizeRepoPath(value: unknown): string | null {
	const normalized = path.posix.normalize(
		String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\/+/, ''),
	);
	return normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)
		? null
		: normalized;
}

/** Numbered read_file text kept in one prompt window. */
export const READ_FILE_WINDOW_CHAR_CAP = 8000;
/** Distinct successful windows of one path before another read is rejected. */
export const MAX_READ_WINDOWS_PER_PATH = 4;
/**
 * A head read of an authored split target at or under this size is returned
 * once. Larger files stay on the 8000-character window.
 */
export const WHOLE_FILE_READ_BYTE_CAP = 60 * 1024;

function isOmittedLine(value: unknown): value is null | undefined {
	return value === null || value === undefined;
}

function cleanRepoPath(value: unknown): string {
	return String(value ?? '')
		.replaceAll('\\', '/')
		.replace(/^\.\//, '')
		.replace(/\/+$/, '');
}

/** True when `repoPath` is the authored path or a file under that directory. */
export function pathIsSplitTarget(
	repoPath: unknown,
	authoredPaths: readonly unknown[] = [],
): boolean {
	const clean = cleanRepoPath(repoPath);
	if (!clean) return false;
	return (authoredPaths ?? []).some((candidate) => {
		const prefix = cleanRepoPath(candidate);
		if (!prefix) return false;
		return clean === prefix || clean.startsWith(`${prefix}/`);
	});
}

/** Head read: start_line omitted or 1, and end_line omitted. */
export function isHeadRead(parameters: ReadWindowParameters = {}): boolean {
	const start = parameters?.start_line;
	const end = parameters?.end_line;
	const headStart = isOmittedLine(start) || start === 1;
	return headStart && isOmittedLine(end);
}

export interface LeanWholeFileOptions {
	readonly capabilityIsLean?: boolean;
	readonly parameters?: ReadWindowParameters;
	readonly byteLength?: number | null;
	readonly authoredPaths?: readonly unknown[];
	readonly path?: unknown;
}

/**
 * Lean loop only. Programmer-turn passes `wholeFile: true` straight through
 * and must not be capped here.
 */
export function leanWholeFileRequested({
	capabilityIsLean = false,
	parameters = {},
	byteLength = null,
	authoredPaths = [],
	path: targetPath = '',
}: LeanWholeFileOptions = {}): boolean {
	if (capabilityIsLean !== true) return false;
	if (!isHeadRead(parameters)) return false;
	if (!pathIsSplitTarget(targetPath, authoredPaths)) return false;
	if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
		return false;
	}
	return byteLength <= WHOLE_FILE_READ_BYTE_CAP;
}

/** A kept read that already showed every line of a file at or under the cap. */
export function isWholeFileReadResult(result: ReadWindowResult | null | undefined): boolean {
	if (!result || result.error || result.truncated === true) return false;
	const start = result.shownStartLine;
	const end = result.shownEndLine;
	const total = result.totalLines;
	if (
		start !== 1 ||
		typeof end !== 'number' ||
		!Number.isSafeInteger(end) ||
		typeof total !== 'number' ||
		!Number.isSafeInteger(total)
	) {
		return false;
	}
	if (end !== total + 1) return false;
	const bytes =
		typeof result.byteLength === 'number' && Number.isSafeInteger(result.byteLength)
			? result.byteLength
			: Buffer.byteLength(String(result.content ?? ''), 'utf8');
	return bytes <= WHOLE_FILE_READ_BYTE_CAP;
}

/**
 * Half-open 1-based window over `content.split('\n')`, sized so the
 * numbered gutter form fits `charCap`. The returned `content` is the
 * unnumbered slice. `shownEndLine` is exclusive.
 */
export function selectReadWindow(
	content: unknown,
	parameters: ReadWindowParameters = {},
	charCap = READ_FILE_WINDOW_CHAR_CAP,
): SelectedReadWindow {
	const lines = String(content ?? '').split('\n');
	const totalLines = lines.length;
	const startLine = parameters?.start_line;
	const endLine = parameters?.end_line;
	const start = isOmittedLine(startLine) ? 1 : startLine;
	if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 1 || start > totalLines) {
		throw new SdlcError(
			'INVALID_INPUT',
			`start_line must be an integer from 1 to ${totalLines}.`,
		);
	}
	const requestedEnd = isOmittedLine(endLine) ? totalLines + 1 : endLine;
	if (
		typeof requestedEnd !== 'number' ||
		!Number.isSafeInteger(requestedEnd) ||
		requestedEnd <= start ||
		requestedEnd > totalLines + 1
	) {
		throw new SdlcError(
			'INVALID_INPUT',
			`end_line must be an integer from ${start + 1} to ${totalLines + 1} (exclusive).`,
		);
	}
	const width = String(totalLines).length;
	let shownEnd = start;
	let renderedLength = 0;
	for (let lineNo = start; lineNo < requestedEnd; lineNo += 1) {
		const lineText = lines[lineNo - 1] ?? '';
		const pieceLength = width + 3 + lineText.length;
		const next =
			renderedLength === 0 ? pieceLength : renderedLength + 1 + pieceLength;
		if (next > charCap && lineNo > start) break;
		renderedLength = next;
		shownEnd = lineNo + 1;
		if (next > charCap) break;
	}
	return {
		content: lines.slice(start - 1, shownEnd - 1).join('\n'),
		totalLines,
		shownStartLine: start,
		shownEndLine: shownEnd,
		truncated: shownEnd < requestedEnd,
	};
}

const MUTATION_TOOLS: ReadonlySet<string> = new Set([
	'write_file',
	'replace_in_file',
	'replace_snapshot_range',
]);

function historyPath(item: ToolHistoryItem | null | undefined): string | null {
	return (
		normalizeRepoPath(item?.parameters?.path) ??
		normalizeRepoPath(item?.result?.resolvedPath)
	);
}

/** A later mutation of this path invalidates earlier windows so one refresh read is allowed. */
function mutationFollows(
	toolHistory: readonly ToolHistoryItem[],
	readIndex: number,
	normalizedPath: string,
): boolean {
	for (let index = readIndex + 1; index < toolHistory.length; index += 1) {
		const item = toolHistory[index];
		if (!item?.toolName || !MUTATION_TOOLS.has(item.toolName)) continue;
		if (historyPath(item) === normalizedPath) return true;
	}
	return false;
}

function windowIdentity(item: ToolHistoryItem | null | undefined): string | null {
	const start = item?.result?.shownStartLine;
	const end = item?.result?.shownEndLine;
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
	return `${start}:${end}`;
}

function successfulWindows(
	toolHistory: readonly ToolHistoryItem[] | null | undefined,
	normalizedPath: string,
): Array<{ shownStartLine: number; shownEndLine: number }> {
	const history = toolHistory ?? [];
	const windows: Array<{ shownStartLine: number; shownEndLine: number }> = [];
	for (let index = 0; index < history.length; index += 1) {
		const item = history[index];
		if (item?.toolName !== 'read_file' || !item.result || item.result.error) {
			continue;
		}
		if (historyPath(item) !== normalizedPath) continue;
		const identity = windowIdentity(item);
		if (!identity) continue;
		if (mutationFollows(history, index, normalizedPath)) continue;
		const parts = identity.split(':').map((part) => Number(part));
		windows.push({ shownStartLine: parts[0] ?? 1, shownEndLine: parts[1] ?? 1 });
	}
	return windows;
}

/**
 * Latest entry for each distinct unmutated read window, at most
 * `maxWindows` per path. A later write_file, replace_in_file, or
 * replace_snapshot_range of that path drops its windows. The executor
 * pins these entries past the short tool-history slice so a window the
 * four-window guard still counts remains readable.
 */
export function retainedReadWindowEntries<T extends ToolHistoryItem>(
	toolHistory: readonly T[] | null | undefined,
	maxWindows = MAX_READ_WINDOWS_PER_PATH,
): T[] {
	const history = toolHistory ?? [];
	const byPath = new Map<string, Map<string, T>>();
	for (let index = 0; index < history.length; index += 1) {
		const item = history[index];
		if (!item || item.toolName !== 'read_file' || !item.result || item.result.error) continue;
		const normalizedPath = historyPath(item);
		const identity = windowIdentity(item);
		if (!normalizedPath || !identity) continue;
		if (mutationFollows(history, index, normalizedPath)) continue;
		let windows = byPath.get(normalizedPath);
		if (!windows) {
			windows = new Map<string, T>();
			byPath.set(normalizedPath, windows);
		}
		windows.set(identity, item);
	}
	const retained: T[] = [];
	for (const windows of byPath.values()) {
		const entries = [...windows.values()];
		const capped = entries.length > maxWindows ? entries.slice(-maxWindows) : entries;
		retained.push(...capped);
	}
	return retained.sort((left, right) => history.indexOf(left) - history.indexOf(right));
}

export interface RepeatedReadWindowErrorOptions {
	readonly content?: unknown;
	readonly normalizedPath?: string | null;
	readonly parameters?: ReadWindowParameters;
	readonly toolHistory?: readonly ToolHistoryItem[];
	readonly charCap?: number;
	readonly maxWindows?: number;
	readonly wholeFile?: boolean;
}

/**
 * Rejects a second read of a window already returned for this path, and
 * a fifth distinct window. A window no longer counts after a later
 * write_file, replace_in_file, or replace_snapshot_range of that path,
 * so one post-mutation refresh read is allowed. Returns null when the
 * read may proceed. Invalid ranges return null so `readFileTool` can
 * report them.
 */
export function repeatedReadWindowError({
	content,
	normalizedPath,
	parameters = {},
	toolHistory = [],
	charCap = READ_FILE_WINDOW_CHAR_CAP,
	maxWindows = MAX_READ_WINDOWS_PER_PATH,
	wholeFile = false,
}: RepeatedReadWindowErrorOptions = {}): string | null {
	if (!normalizedPath) return null;
	const prior = successfulWindows(toolHistory, normalizedPath);
	if (prior.length === 0) return null;
	const lines = String(content ?? '').split('\n');
	const fullEnd = lines.length + 1;
	if (prior.some((item) => item.shownStartLine === 1 && item.shownEndLine === fullEnd)) {
		return `File '${normalizedPath}' was already read in full (lines 1–${lines.length}). Edit from that snapshot. Do not read it again.`;
	}
	let window: SelectedReadWindow;
	if (wholeFile === true) {
		window = {
			content: String(content ?? ''),
			totalLines: lines.length,
			shownStartLine: 1,
			shownEndLine: fullEnd,
			truncated: false,
		};
	} else {
		try {
			window = selectReadWindow(content, parameters, charCap);
		} catch {
			return null;
		}
	}

	const same = prior.some(
		(item) =>
			item.shownStartLine === window.shownStartLine &&
			item.shownEndLine === window.shownEndLine,
	);
	const inclusiveEnd = window.shownEndLine - 1;
	if (same) {
		if (window.truncated) {
			return `Lines ${window.shownStartLine}–${inclusiveEnd} of ${window.totalLines} in '${normalizedPath}' were already read. Edit from that window, or read_file with start_line ${window.shownEndLine}. Do not repeat this window.`;
		}
		return `File '${normalizedPath}' was already read in full (lines ${window.shownStartLine}–${inclusiveEnd}). Edit from that snapshot. Do not read it again.`;
	}
	const distinct = new Set(
		prior.map((item) => `${item.shownStartLine}:${item.shownEndLine}`),
	);
	if (distinct.size >= maxWindows) {
		return `${maxWindows} windows of '${normalizedPath}' were already read. Edit from those snapshots. Do not read it again.`;
	}
	return null;
}

/** Paths whose latest unmutated read_file already returned every line. */
export function pathsReadInFull(
	toolHistory: readonly ToolHistoryItem[] | null | undefined,
): string[] {
	const paths: string[] = [];
	const history = toolHistory ?? [];
	for (let index = 0; index < history.length; index += 1) {
		const item = history[index];
		if (item?.toolName !== 'read_file' || !item.result || item.result.error) continue;
		const normalizedPath = historyPath(item);
		if (!normalizedPath || mutationFollows(history, index, normalizedPath)) continue;
		const start = item.result.shownStartLine;
		const end = item.result.shownEndLine;
		const total = item.result.totalLines;
		const coversAll =
			start === 1 &&
			typeof end === 'number' &&
			Number.isSafeInteger(end) &&
			typeof total === 'number' &&
			Number.isSafeInteger(total) &&
			end === total + 1;
		if (coversAll && !paths.includes(normalizedPath)) paths.push(normalizedPath);
	}
	return paths;
}

function commandArgvKey(item: ToolHistoryItem | null | undefined): string | null {
	if (item?.toolName !== 'run_allowlisted_command') return null;
	const command = item.parameters?.command;
	const args = item.parameters?.args;
	if (typeof command !== 'string' || !Array.isArray(args)) return null;
	return JSON.stringify([command, ...args]);
}

/**
 * Latest allowlisted command for each exact argv, including a failure.
 * The short history slice otherwise drops an earlier contract check.
 */
export function retainedPassingCommandEntries<T extends ToolHistoryItem>(
	toolHistory: readonly T[] | null | undefined,
): T[] {
	const history = toolHistory ?? [];
	const byArgv = new Map<string, T>();
	for (const item of history) {
		const key = commandArgvKey(item);
		if (!key) continue;
		byArgv.set(key, item);
	}
	return [...byArgv.values()];
}

function hintedPaths(item: ToolHistoryItem | null | undefined): string[] {
	const hints: string[] = [];
	const candidate = normalizeRepoPath(item?.result?.candidatePath);
	if (candidate) hints.push(candidate);
	if (Array.isArray(item?.result?.candidates)) {
		for (const candidatePath of item.result.candidates) {
			const normalized = normalizeRepoPath(candidatePath);
			if (normalized && !hints.includes(normalized)) hints.push(normalized);
		}
	}
	return hints;
}

function missingHintResolved(
	history: readonly ToolHistoryItem[],
	readIndex: number,
	requested: string,
	hints: readonly string[],
): boolean {
	for (let index = readIndex + 1; index < history.length; index += 1) {
		const item = history[index];
		const itemPath = historyPath(item);
		if (item?.toolName && MUTATION_TOOLS.has(item.toolName) && itemPath === requested) return true;
		if (
			item?.toolName === 'read_file' &&
			item.result &&
			!item.result.error &&
			itemPath !== null &&
			hints.includes(itemPath)
		) {
			return true;
		}
	}
	return false;
}

/**
 * Latest missed read_file that named a candidate. Kept until a later
 * successful read of that candidate, or a write of the missing path.
 */
export function retainedMissingPathEntries<T extends ToolHistoryItem>(
	toolHistory: readonly T[] | null | undefined,
): T[] {
	const history = toolHistory ?? [];
	const byPath = new Map<string, T>();
	for (let index = 0; index < history.length; index += 1) {
		const item = history[index];
		if (!item || item.toolName !== 'read_file' || !item.result?.error) continue;
		const requested = historyPath(item);
		const hints = hintedPaths(item);
		if (!requested || hints.length === 0) continue;
		if (missingHintResolved(history, index, requested, hints)) continue;
		byPath.set(requested, item);
	}
	return [...byPath.values()];
}
