import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const bytesHash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
// The one sandbox launcher the evidence runtime supports; admission pins its hash.
export const LAUNCHER = '/usr/bin/bwrap';
export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export function fail(message) {
	throw new Error(`EvidenceAdmissionError: ${message}`);
}

export function relativePath(value) {
	if (typeof value !== 'string' || value.includes('\\') || value.includes('\0')
		|| path.isAbsolute(value) || value.split('/').some((part) => !part || part === '.' || part === '..')) {
		fail(`unsafe relative path: ${value}`);
	}
	return value;
}

export function regularFile(root, relative) {
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

export function verifyFile(root, record) {
	if (!record || !/^[a-f0-9]{64}$/.test(record.sha256)) fail('missing file hash');
	const file = regularFile(root, record.path);
	if (bytesHash(fs.readFileSync(file)) !== record.sha256) fail(`file changed: ${record.path}`);
	return file;
}

export function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

export function argumentsFor(argv, names) {
	const result = {};
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		if (!names.includes(key) || result[key] !== undefined || !argv[index + 1]) fail(`invalid flag: ${key}`);
		result[key] = argv[index + 1];
	}
	for (const name of names) if (!result[name]) fail(`missing ${name}`);
	return result;
}

// A case map title is either the exact runner title or an '@case AC-xx.y' tag the runner title must carry.
export function titleMatches(title, expected) {
	if (title === expected) return true;
	const tag = /^@case (AC-\d+\.\d+)$/.exec(expected);
	return Boolean(tag) && typeof title === 'string'
		&& new RegExp(`(?:^|\\s)@case ${tag[1].replace('.', '\\.')}(?=\\s|$)`).test(title);
}

// A runner may execute every test in a file; only the selected cases may influence the exit code.
export function selectionGrep(runnerTitles) {
	const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return runnerTitles.map((title) => {
		const tag = /^@case (AC-\d+\.\d+)$/.exec(title);
		return tag ? `@case ${escape(tag[1])}(?=\\s|$)` : escape(title);
	}).join('|');
}

export function normalizedCase(entry, attempts) {
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

export function runnerOutcome(value) {
	const values = {
		passed: 'passed', failed: 'failed', skipped: 'skipped', pending: 'skipped',
		todo: 'skipped', disabled: 'skipped', timedOut: 'incomplete', interrupted: 'incomplete',
	};
	if (!Object.hasOwn(values, value)) fail(`unknown runner outcome: ${value}`);
	return values[value];
}

// Loads an engine module (e.g. 'roles/role-registry') from this checkout, as .ts in source or .js in dist.
export async function engineModule(name) {
	for (const extension of ['.ts', '.js']) {
		const file = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', `${name}${extension}`);
		if (fs.existsSync(file)) return import(pathToFileURL(file).href);
	}
	return fail(`engine module not found: ${name}`);
}

export function isMain(url) {
	return process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === url;
}

export async function main(action) {
	try { await action(); }
	catch (error) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	}
}
