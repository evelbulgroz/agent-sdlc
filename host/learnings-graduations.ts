import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { HostGraduationsConfig } from './graduations-config.ts';
import type { NormalizedLearningEntry } from './learnings.ts';

const requireModule = createRequire(import.meta.url);

export interface GraduationCandidate {
	key: string;
	scope: string;
	type: string;
	graduationTarget: string;
	insight: string;
	reason: string;
}

export interface GraduationReport {
	ok: boolean;
	total: number;
	candidates: GraduationCandidate[];
}

const GENERIC_STOPWORDS = new Set([
	'spec', 'test', 'tests', 'ok', 'fail', 'pass', 'error', 'errors', 'summary', 'unit', 'e2e', 'all', 'app', 'apps', 'global', 'package', 'packages',
]);
const TEST_FILE = /\.(spec|test|e2e-spec)\.(ts|js|mjs|sh)$/;
const SKIPPED_DIRS = new Set(['node_modules', 'dist']);

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isGenericKey = (key: string): boolean => GENERIC_STOPWORDS.has(key.toLowerCase()) || key.length < 3;

/** Active Semgrep rule ids; commented-out rules are excluded. */
export function extractSemgrepRuleIds(content: string): Set<string> {
	const ids = new Set<string>();
	for (const rawLine of content.split('\n')) {
		if (rawLine.trim().startsWith('#')) continue;
		const match = /^\s*(?:-\s+)?id:\s*([a-zA-Z0-9_.-]+)/.exec(rawLine.split('#')[0] ?? '');
		if (match?.[1]) ids.add(match[1].trim());
	}
	return ids;
}

/** Active dependency-cruiser rule names, loaded from the config and falling back to text parsing. */
export function extractDepcruiseRuleNames(configPath: string): Set<string> {
	const names = new Set<string>();
	try {
		delete requireModule.cache[requireModule.resolve(configPath)];
		const config: unknown = requireModule(configPath);
		if (typeof config === 'object' && config !== null) {
			for (const list of [Reflect.get(config, 'forbidden'), Reflect.get(config, 'allowed'), Reflect.get(config, 'required')]) {
				if (!Array.isArray(list)) continue;
				for (const rule of list) {
					const name: unknown = typeof rule === 'object' && rule !== null ? Reflect.get(rule, 'name') : undefined;
					if (typeof name === 'string') names.add(name);
				}
			}
			return names;
		}
	} catch {
		// fall through to text parsing
	}
	const stripped = readFileSync(configPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	for (const match of stripped.matchAll(/\bname:\s*['"]([^'"]+)['"]/g)) if (match[1]) names.add(match[1]);
	return names;
}

function* walkFiles(dir: string): Generator<string> {
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined) break;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
			const entryPath = path.join(current, entry.name);
			if (entry.isDirectory()) stack.push(entryPath);
			else yield entryPath;
		}
	}
}

function findIdentifier(dirs: readonly string[] | undefined, rootDir: string, matcher: (name: string) => boolean, identifier: RegExp): string | null {
	for (const dir of dirs ?? []) {
		const full = path.join(rootDir, dir);
		if (!existsSync(full)) continue;
		for (const file of walkFiles(full)) {
			if (!matcher(path.basename(file))) continue;
			try {
				if (identifier.test(readFileSync(file, 'utf8'))) return path.relative(rootDir, file);
			} catch {
				// unreadable files cannot graduate an entry
			}
		}
	}
	return null;
}

/** Cross-references store entries against the host's static gates; sources and match prefix come from the profile. */
export function checkGraduations(entries: readonly NormalizedLearningEntry[], rootDir: string, config: HostGraduationsConfig = {}): GraduationReport {
	const readSet = (file: string | undefined, extract: (p: string) => Set<string>): Set<string> => {
		const full = file === undefined ? undefined : path.join(rootDir, file);
		return full !== undefined && existsSync(full) ? extract(full) : new Set();
	};
	const semgrepIds = readSet(config.semgrepRules, (p) => extractSemgrepRuleIds(readFileSync(p, 'utf8')));
	const depcruiseNames = readSet(config.dependencyCruiserConfig, extractDepcruiseRuleNames);
	const prefix = config.identifierPrefix;
	const candidates: GraduationCandidate[] = [];

	for (const entry of entries) {
		const { key, graduationTarget: target } = entry;
		let reason: string | null = null;
		const identifier = prefix === undefined || isGenericKey(key)
			? null
			: new RegExp(`(?:^|[^a-zA-Z0-9_-])${escapeRegex(prefix)}[.:-]${escapeRegex(key)}(?![a-zA-Z0-9_-])`, 'i');

		if (target === 'semgrep' && (semgrepIds.has(key) || (prefix !== undefined && semgrepIds.has(`${prefix}.${key}`)))) {
			reason = `Semgrep rule '${key}' exists in ${config.semgrepRules}`;
		} else if (target === 'depcruise' && depcruiseNames.has(key)) {
			reason = `Dependency-Cruiser rule '${key}' exists in ${config.dependencyCruiserConfig}`;
		} else if (target === 'test' && identifier) {
			const file = findIdentifier(config.testDirs, rootDir, (name) => TEST_FILE.test(name), identifier);
			if (file) reason = `Explicit test invariant '${prefix}:${key}' found in ${file}`;
		} else if (target === 'handbook' && identifier) {
			const file = findIdentifier(config.handbookDirs, rootDir, (name) => name.endsWith('.md'), identifier);
			if (file) reason = `Explicit documentation '${prefix}:${key}' found in ${file}`;
		} else if (target === 'skill') {
			const dir = (config.skillDirs ?? []).find((d) => existsSync(path.join(rootDir, d, key, 'SKILL.md')));
			if (dir !== undefined) reason = `Skill directory exists at ${dir}/${key}/SKILL.md`;
		}

		if (reason !== null) candidates.push({ key, scope: entry.scope, type: entry.type, graduationTarget: target ?? '', insight: entry.insight, reason });
	}
	return { ok: candidates.length === 0, total: entries.length, candidates };
}
