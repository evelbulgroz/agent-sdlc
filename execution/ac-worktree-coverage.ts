import fs from 'node:fs';
import path from 'node:path';
import { SdlcError } from '../policy/errors.ts';
import { isOraclePath, parseTestCitations } from './ac-citations.ts';
import {
	type AcCoverageReport,
	type BaselineCitationItem,
	type TouchedTestFile,
	type UntouchedOracleFile,
	evaluateAcCoverage,
} from './ac-coverage.ts';

const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', '.git', 'coverage']);

export interface SpecificationDraftLike {
	readonly acceptanceCriteria?: readonly string[];
	readonly knownAcceptanceCriteria?: readonly string[];
}

export type GitShowFn = (
	command: string,
	args: readonly string[],
	options?: Record<string, unknown>,
) => string | Buffer;

export interface EvaluateAcCoverageFromWorktreeOptions {
	readonly draft?: SpecificationDraftLike | null;
	readonly knownAcceptanceCriteria?: readonly string[];
	readonly baselineTestCitations?: readonly BaselineCitationItem[];
	readonly baseCommitSha?: string | null;
	readonly gitCli?: GitShowFn | null;
	readonly worktreeDir?: string;
	readonly touchedTestFiles?: readonly string[];
	readonly allowedPathPrefixes?: readonly string[];
	readonly searchDirs?: readonly string[];
	readonly readFile?: (filePath: string) => string;
	readonly listFiles?: (dir: string) => string[];
}

export function evaluateAcCoverageFromWorktree({
	draft,
	knownAcceptanceCriteria,
	baselineTestCitations = [],
	baseCommitSha = null,
	gitCli = null,
	worktreeDir,
	touchedTestFiles = [],
	allowedPathPrefixes = [],
	searchDirs = [],
	readFile = (filePath: string) => fs.readFileSync(filePath, 'utf8'),
	listFiles = listFilesRecursive,
}: EvaluateAcCoverageFromWorktreeOptions = {}): Readonly<AcCoverageReport> {
	if (draft == null) {
		throw new SdlcError('INVALID_INPUT', 'AC coverage requires an approved specification draft');
	}
	if (!worktreeDir) {
		throw new SdlcError('INVALID_INPUT', 'AC coverage requires a worktree directory');
	}
	const dirs = [worktreeDir, ...searchDirs].filter(
		(dir, index, all): dir is string => Boolean(dir) && all.indexOf(dir) === index,
	);
	const touchedFiles: TouchedTestFile[] = [];
	for (const relativePath of touchedTestFiles) {
		const content = readFirstExisting(relativePath, dirs, readFile);
		if (typeof content !== 'string') {
			throw new SdlcError(
				'POLICY_VIOLATION',
				`Touched test file is missing from the worktree: '${relativePath}'`,
				{ filePath: relativePath },
			);
		}
		touchedFiles.push({ path: posixPath(relativePath), content });
	}

	const collectedBaselineCitations: BaselineCitationItem[] = [...baselineTestCitations];
	if (baseCommitSha && typeof gitCli === 'function') {
		for (const relativePath of touchedTestFiles) {
			try {
				const baseContent = gitCli('git', ['show', `${baseCommitSha}:${relativePath}`], {
					cwd: worktreeDir,
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
				});
				if (typeof baseContent === 'string' && baseContent.length > 0) {
					const baseTests = parseTestCitations(baseContent, relativePath);
					collectedBaselineCitations.push(...baseTests);
				}
			} catch {
				// File did not exist in baseCommitSha or git show failed; ignore
			}
		}
	}

	const touchedSet = new Set(touchedFiles.map((file) => file.path));
	const untouchedOracleFiles = collectUntouchedOracles({
		worktreeDir,
		allowedPathPrefixes,
		touchedSet,
		readFile,
		listFiles,
	});
	return evaluateAcCoverage({
		acceptanceCriteria: draft.acceptanceCriteria ?? [],
		knownAcceptanceCriteria:
			knownAcceptanceCriteria ??
			draft.knownAcceptanceCriteria ??
			draft.acceptanceCriteria ??
			[],
		baselineTestCitations: collectedBaselineCitations,
		touchedFiles,
		untouchedOracleFiles,
	});
}

function readFirstExisting(
	relativePath: string,
	dirs: readonly string[],
	readFile: (filePath: string) => string,
): string | null {
	let lastError: unknown = null;
	for (const dir of dirs) {
		try {
			const content = readFile(path.join(dir, relativePath));
			if (typeof content === 'string') return content;
		} catch (error) {
			lastError = error;
		}
	}
	if (lastError) {
		const causeCode =
			lastError && typeof lastError === 'object' && 'code' in lastError && typeof lastError.code === 'string'
				? lastError.code
				: 'ENOENT';
		throw new SdlcError(
			'POLICY_VIOLATION',
			`Touched test file is missing from the worktree: '${relativePath}'`,
			{ filePath: relativePath, cause: causeCode },
		);
	}
	return null;
}

function collectUntouchedOracles({
	worktreeDir,
	allowedPathPrefixes,
	touchedSet,
	readFile,
	listFiles,
}: {
	worktreeDir: string;
	allowedPathPrefixes: readonly string[];
	touchedSet: ReadonlySet<string>;
	readFile: (filePath: string) => string;
	listFiles: (dir: string) => string[];
}): UntouchedOracleFile[] {
	const files: UntouchedOracleFile[] = [];
	for (const prefix of allowedPathPrefixes) {
		const root = path.join(worktreeDir, prefix);
		let listed: string[] = [];
		try {
			listed = listFiles(root);
		} catch {
			continue;
		}
		for (const absolute of listed) {
			const relative = posixPath(path.relative(worktreeDir, absolute));
			if (!isOraclePath(relative) || touchedSet.has(relative)) continue;
			try {
				files.push({ path: relative, content: readFile(absolute) });
			} catch {
				// Skip unreadable leftover oracles; advisory scan is best-effort per file.
			}
		}
	}
	return files;
}

export function listFilesRecursive(dir: string): string[] {
	const results: string[] = [];
	if (!fs.existsSync(dir)) return results;
	const stack: string[] = [dir];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (SKIP_DIR_NAMES.has(entry.name)) continue;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.isFile()) results.push(full);
		}
	}
	return results;
}

function posixPath(filePath: unknown): string {
	return String(filePath).split(path.sep).join('/');
}
