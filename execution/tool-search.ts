import fs from 'node:fs';
import path from 'node:path';
import { SdlcError } from '../policy/errors.ts';
import { FORBIDDEN_COMPONENTS, assertToolPathContained } from './tool-path-guards.ts';

export interface SearchToolParameters {
	readonly path?: unknown;
	readonly pattern?: unknown;
	readonly query?: unknown;
	readonly [key: string]: unknown;
}

export interface SearchToolContext {
	readonly worktreeDir: string;
	readonly [key: string]: unknown;
}

export interface GrepMatch {
	readonly path: string;
	readonly line: number;
	readonly text: string;
}

export interface ListDirResult {
	readonly entries: string[];
}

export interface GrepResult {
	readonly matches: GrepMatch[];
}

export interface FindFilesResult {
	readonly matches: Array<string | GrepMatch>;
}

function listDirTool(
	parameters: SearchToolParameters | null | undefined,
	{ worktreeDir }: SearchToolContext,
): ListDirResult {
	const rawPath = parameters?.path ?? '.';
	const resolved = assertToolPathContained(worktreeDir, rawPath);
	if (!fs.existsSync(resolved)) {
		throw new SdlcError('INVALID_INPUT', `Directory '${rawPath}' does not exist`);
	}
	const stat = fs.statSync(resolved);
	if (!stat.isDirectory()) {
		throw new SdlcError('INVALID_INPUT', `Path '${rawPath}' is not a directory`);
	}
	const entries = fs
		.readdirSync(resolved)
		.filter((name) => !FORBIDDEN_COMPONENTS.has(name))
		.sort();
	return { entries };
}

function findFilesByQuery(
	parameters: SearchToolParameters,
	{ worktreeDir }: SearchToolContext,
): GrepResult {
	const query = String(parameters.query ?? '');
	if (query.includes('\0')) {
		throw new SdlcError('INVALID_INPUT', 'Query must not contain a NUL character');
	}
	const rawPath = parameters?.path ?? '.';
	const resolved = assertToolPathContained(worktreeDir, rawPath);
	if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
		throw new SdlcError('INVALID_INPUT', `Directory '${rawPath}' does not exist`);
	}
	const matches: GrepMatch[] = [];
	const stack: string[] = [resolved];
	while (stack.length > 0 && matches.length < 30) {
		const current = stack.pop();
		if (!current) continue;
		const entries = fs.readdirSync(current, { withFileTypes: true });
		for (const entry of entries) {
			if (matches.length >= 30) break;
			if (
				entry.name === '.git' ||
				entry.name === 'node_modules' ||
				entry.name === '.agent-sdlc'
			) {
				continue;
			}
			const absolute = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(absolute);
				continue;
			}
			if (!entry.isFile()) continue;
			const stat = fs.statSync(absolute);
			if (stat.size > 1_000_000) continue;
			const text = fs.readFileSync(absolute, 'utf8');
			if (text.includes('\0')) continue;
			const lines = text.split('\n');
			for (let index = 0; index < lines.length; index += 1) {
				const lineText = lines[index] ?? '';
				if (!lineText.includes(query)) continue;
				const rel = path.relative(worktreeDir, absolute).split(path.sep).join('/');
				assertToolPathContained(worktreeDir, rel);
				matches.push({
					path: rel,
					line: index + 1,
					text: lineText.slice(0, 200),
				});
				if (matches.length >= 30) break;
			}
		}
	}
	matches.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
	return { matches };
}

function grepFiles(_worktreeDir: string, resolved: string): string[] {
	const stat = fs.statSync(resolved);
	if (stat.isFile()) return [resolved];
	if (!stat.isDirectory()) return [];
	const files: string[] = [];
	const stack: string[] = [resolved];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			if (
				entry.name === '.git' ||
				entry.name === '.agent-sdlc' ||
				entry.name === 'node_modules'
			) {
				continue;
			}
			const absolute = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(absolute);
				continue;
			}
			if (entry.isFile()) files.push(absolute);
		}
	}
	return files;
}

export function grepTool(
	parameters: SearchToolParameters | null | undefined,
	{ worktreeDir }: SearchToolContext,
): GrepResult {
	const pattern = parameters?.pattern;
	if (typeof pattern !== 'string' || pattern.length === 0) {
		throw new SdlcError('INVALID_INPUT', 'Pattern must be a non-empty string');
	}
	let regex: RegExp;
	try {
		regex = new RegExp(pattern);
	} catch {
		throw new SdlcError('INVALID_INPUT', `Pattern '${pattern}' is not a valid regular expression`);
	}
	const rawPath = parameters?.path;
	const resolved = assertToolPathContained(worktreeDir, rawPath);
	if (!fs.existsSync(resolved)) {
		throw new SdlcError('INVALID_INPUT', `Path '${String(rawPath)}' does not exist`);
	}
	const matches: GrepMatch[] = [];
	for (const absolute of grepFiles(worktreeDir, resolved)) {
		const rel = path.relative(worktreeDir, absolute).split(path.sep).join('/');
		assertToolPathContained(worktreeDir, rel);
		const stat = fs.statSync(absolute);
		if (stat.size > 1_000_000) continue;
		const text = fs.readFileSync(absolute, 'utf8');
		if (text.includes('\0')) continue;
		const lines = text.split('\n');
		for (let index = 0; index < lines.length; index += 1) {
			const lineText = lines[index] ?? '';
			if (!regex.test(lineText)) continue;
			matches.push({ path: rel, line: index + 1, text: lineText });
		}
	}
	matches.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
	return { matches };
}

function findFilesTool(
	parameters: SearchToolParameters | null | undefined,
	{ worktreeDir }: SearchToolContext,
): FindFilesResult {
	const query = parameters?.query;
	if (typeof query === 'string' && query.length > 0 && parameters) {
		return findFilesByQuery(parameters, { worktreeDir });
	}
	const pattern = parameters?.pattern;
	if (typeof pattern !== 'string' || pattern.length === 0) {
		throw new SdlcError('INVALID_INPUT', 'Pattern must be a non-empty string');
	}
	if (
		pattern.includes('..') ||
		pattern.includes('\0') ||
		pattern.startsWith('/') ||
		pattern.startsWith('\\')
	) {
		throw new SdlcError(
			'PATH_CONTAINMENT_VIOLATION',
			`Glob pattern '${pattern}' contains forbidden traversal characters`,
		);
	}
	const rawPath = parameters?.path ?? '.';
	const resolved = assertToolPathContained(worktreeDir, rawPath);
	if (!fs.existsSync(resolved)) {
		throw new SdlcError('INVALID_INPUT', `Directory '${rawPath}' does not exist`);
	}

	const rawMatches = fs.globSync(pattern, {
		cwd: resolved,
		exclude: (entry) =>
			entry.includes('.git') || entry.includes('.agent-sdlc') || entry.includes('node_modules'),
	});

	const matches: string[] = [];
	for (const entry of rawMatches) {
		const candidatePath = path.resolve(resolved, entry);
		const relCandidate = path.relative(worktreeDir, candidatePath);
		try {
			assertToolPathContained(worktreeDir, relCandidate);
			const rel =
				rawPath === '.' || rawPath === ''
					? entry
					: path.posix.join(String(rawPath).replace(/^\.\//, ''), entry);
			matches.push(rel);
		} catch {
			// drop any out-of-worktree matches
		}
	}
	matches.sort();

	return { matches };
}

export function executeSearchTool(
	toolName: string,
	parameters: SearchToolParameters | null | undefined,
	context: SearchToolContext,
): ListDirResult | GrepResult | FindFilesResult | null {
	switch (toolName) {
		case 'grep':
			return grepTool(parameters, context);
		case 'list_dir':
			return listDirTool(parameters, context);
		case 'find_files':
			return findFilesTool(parameters, context);
		default:
			return null;
	}
}
