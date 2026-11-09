import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CaseAttempt, CaseEntry, RunnerOutcome } from './types.ts';

export const bytesHash = (bytes: crypto.BinaryLike): string => crypto.createHash('sha256').update(bytes).digest('hex');
// The one sandbox launcher the evidence runtime supports; admission pins its hash.
export const LAUNCHER = '/usr/bin/bwrap';
export const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));

export function fail(message: string): never {
	throw new Error(`EvidenceAdmissionError: ${message}`);
}

export function relativePath(value: unknown): string {
	if (typeof value !== 'string' || value.includes('\\') || value.includes('\0')
		|| path.isAbsolute(value) || value.split('/').some((part) => !part || part === '.' || part === '..')) {
		fail(`unsafe relative path: ${value}`);
	}
	return value as string;
}

export function regularFile(root: string, relative: string): string {
	const resolvedRoot = fs.realpathSync.native(root);
	let current = resolvedRoot;
	const parts = relativePath(relative).split('/');
	for (const [index, part] of parts.entries()) {
		current = path.join(current, part);
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
			fail(`non-regular path: ${relative}`);
		}
	}
	return current;
}

export function verifyFile(root: string, record: { path: string; sha256: string } | null | undefined): string {
	if (!record || !/^[a-f0-9]{64}$/.test(record.sha256)) fail('missing file hash');
	const file = regularFile(root, record.path);
	if (bytesHash(fs.readFileSync(file)) !== record.sha256) fail(`file changed: ${record.path}`);
	return file;
}

export function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

export function argumentsFor(argv: readonly string[], names: readonly string[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index] as string;
		const next = argv[index + 1];
		if (!names.includes(key) || result[key] !== undefined || !next) fail(`invalid flag: ${key}`);
		result[key] = next;
	}
	for (const name of names) if (!result[name]) fail(`missing ${name}`);
	return result;
}

// A case map title is either the exact runner title or an '@case AC-xx.y' tag the runner title must carry.
export function titleMatches(title: unknown, expected: string): boolean {
	if (title === expected) return true;
	const tag = /^@case (AC-\d+\.\d+)$/.exec(expected);
	return tag !== null && typeof title === 'string'
		&& new RegExp(`(?:^|\\s)@case ${tag[1].replace('.', '\\.')}(?=\\s|$)`).test(title);
}

// A runner may execute every test in a file; only the selected cases may influence the exit code.
export function selectionGrep(runnerTitles: readonly string[]): string {
	const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return runnerTitles.map((title) => {
		const tag = /^@case (AC-\d+\.\d+)$/.exec(title);
		return tag ? `@case ${escape(tag[1])}(?=\\s|$)` : escape(title);
	}).join('|');
}

export function normalizedCase(entry: CaseEntry, attempts: readonly CaseAttempt[]) {
	const outcomes = attempts.map((attempt) => attempt.outcome);
	const outcome = outcomes.includes('failed') ? 'failed'
		: outcomes.includes('incomplete') ? 'incomplete'
			: outcomes.includes('skipped') ? 'skipped' : outcomes.length ? 'passed' : 'not-run';
	return {
		file: entry.file, caseKey: entry.caseKey, obligationIds: entry.obligationIds,
		exercisedCapabilities: outcome === 'passed' ? entry.capabilities : [], outcome,
		attempts: attempts.map((attempt, index) => ({ index, ...attempt, artifactPaths: [] })),
	};
}

export function runnerOutcome(value: string): RunnerOutcome {
	const values: Record<string, RunnerOutcome> = {
		passed: 'passed', failed: 'failed', skipped: 'skipped', pending: 'skipped',
		todo: 'skipped', disabled: 'skipped', timedOut: 'incomplete', interrupted: 'incomplete',
	};
	if (!Object.hasOwn(values, value)) fail(`unknown runner outcome: ${value}`);
	return values[value] as RunnerOutcome;
}

// Loads an engine module (e.g. 'roles/role-registry') from this checkout, as .ts in source or .js in dist.
export async function engineModule<T = Record<string, Function>>(name: string): Promise<T> {
	for (const extension of ['.ts', '.js']) {
		const file = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', `${name}${extension}`);
		if (fs.existsSync(file)) return import(pathToFileURL(file).href);
	}
	return fail(`engine module not found: ${name}`);
}

export function isMain(url: string): boolean {
	const entry = process.argv[1];
	return Boolean(entry) && pathToFileURL(fs.existsSync(entry) ? fs.realpathSync(entry) : path.resolve(entry)).href === url;
}

export async function main(action: () => unknown): Promise<void> {
	try { await action(); }
	catch (error) {
		process.stderr.write(`${(error as Error).message}\n`);
		process.exitCode = 1;
	}
}
