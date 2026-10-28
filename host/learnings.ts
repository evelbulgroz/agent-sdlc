import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { type HostLearningsConfig, type HostProfile, loadHostProfileOrFallback } from './host-profile.ts';

export type LearningScope = string;
export type LearningType = string;

export interface LearningEntry {
	ts?: string;
	type: string;
	key: string;
	scope: string;
	query: string;
	insight: string;
	files?: string[];
	confidence?: number;
	source?: string;
	graduationTarget?: string;
	score?: number;
}

export interface NormalizedLearningEntry {
	ts: string;
	type: string;
	key: string;
	scope: string;
	query: string;
	insight: string;
	files?: string[];
	confidence: number;
	source: string;
	graduationTarget?: string;
}

export interface LearningValidationResult {
	valid: boolean;
	errors: string[];
	normalized: NormalizedLearningEntry | null;
}

export interface LearningSearchOptions {
	query?: string;
	scope?: string | null;
	scopes?: readonly string[] | null;
	limit?: number | string;
	types?: string[] | null;
}

export interface InferRecallScopesOptions {
	readonly rootDir?: string;
	readonly profile?: Readonly<HostProfile>;
	readonly learnings?: Readonly<HostLearningsConfig>;
}

export const DEFAULT_LEARNINGS_REL_PATH = '.learnings.jsonl';
export const VALID_TYPES: readonly string[] = Object.freeze(['pitfall', 'pattern', 'preference', 'architecture', 'operational']);
export const VALID_SOURCES: readonly string[] = Object.freeze(['observed', 'user-stated', 'inferred']);
export const VALID_GRADUATION_TARGETS: readonly string[] = Object.freeze(['test', 'semgrep', 'depcruise', 'handbook', 'skill']);

const KEBAB_CASE_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TOKEN_SPLIT_REGEX = /[\s\-_.,;:()[\]"'/]+/;

function resolveLearningsConfig(options: InferRecallScopesOptions = {}): Readonly<HostLearningsConfig> | undefined {
	if (options.learnings) return options.learnings;
	if (options.profile) return options.profile.learnings;
	try {
		const root = options.rootDir ? resolve(options.rootDir) : REPOSITORY_ROOT;
		return loadHostProfileOrFallback(root).learnings;
	} catch {
		return undefined;
	}
}

export function resolveAllowedLearningScopes(
	options: InferRecallScopesOptions & { readonly scopes?: readonly string[] } = {},
): ReadonlySet<string> {
	const config = resolveLearningsConfig(options);
	const allowed = new Set<string>(['global']);
	for (const scope of config?.scopes ?? []) allowed.add(scope);
	for (const scope of options.scopes ?? []) allowed.add(scope);
	return allowed;
}

export const VALID_SCOPES: readonly string[] = Object.freeze([...resolveAllowedLearningScopes()]);

export async function resolveLearningRepoRoot(startDir: string = process.cwd()): Promise<string> {
	try {
		const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
			cwd: startDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'],
		}).trim();
		if (gitRoot && existsSync(gitRoot)) return gitRoot;
	} catch {
		// Fall back to walking up directory tree
	}
	let current = resolve(startDir);
	while (true) {
		if (existsSync(resolve(current, '.agents/sdlc-host.json'))) return current;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return resolve(startDir);
}

export async function resolveLearningStorePath(
	options: { store?: string; rootDir?: string; profile?: Readonly<HostProfile> } = {},
	repoRoot?: string,
): Promise<string> {
	if (options.store) return isAbsolute(options.store) ? options.store : resolve(process.cwd(), options.store);
	if (process.env.FITNESS_APP_LEARNINGS_PATH) {
		return resolve(process.cwd(), process.env.FITNESS_APP_LEARNINGS_PATH);
	}
	const effectiveRoot = repoRoot ?? options.rootDir ?? (await resolveLearningRepoRoot());
	const config = resolveLearningsConfig({ rootDir: effectiveRoot, profile: options.profile });
	return resolve(effectiveRoot, config?.filePath ?? DEFAULT_LEARNINGS_REL_PATH);
}

export async function loadLearningStore(storePath: string): Promise<NormalizedLearningEntry[]> {
	if (!existsSync(storePath)) return [];
	return readFileSync(storePath, 'utf-8')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line, idx) => {
			try {
				return JSON.parse(line) as NormalizedLearningEntry;
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`Invalid JSON on line ${idx + 1} of ${storePath}: ${message}`);
			}
		});
}

function writeStore(storePath: string, learnings: readonly NormalizedLearningEntry[]): void {
	const dir = dirname(storePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const content = learnings.length > 0 ? `${learnings.map((item) => JSON.stringify(item)).join('\n')}\n` : '';
	writeFileSync(storePath, content, 'utf-8');
}

export async function validateLearningEntry(
	raw: unknown,
	options: InferRecallScopesOptions & { readonly scopes?: readonly string[] } = {},
): Promise<LearningValidationResult> {
	const errors: string[] = [];
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { valid: false, errors: ['Payload must be a non-null object'], normalized: null };
	}

	const record = raw as Record<string, unknown>;
	const { type, key, scope, query, insight, files, graduationTarget } = record;
	const confidence = record.confidence === undefined ? 8 : record.confidence;
	const source = record.source === undefined ? 'observed' : record.source;
	const ts = typeof record.ts === 'string' && record.ts ? record.ts : new Date().toISOString();
	const allowedScopes = resolveAllowedLearningScopes(options);

	if (!type || typeof type !== 'string') {
		errors.push('Missing required field: "type"');
	} else if (!VALID_TYPES.includes(type)) {
		errors.push(`Invalid type "${type}". Allowed: ${VALID_TYPES.join(', ')}`);
	}
	if (!key || typeof key !== 'string') {
		errors.push('Missing required field: "key"');
	} else if (!KEBAB_CASE_REGEX.test(key)) {
		errors.push(`Invalid key "${key}". Key must be non-empty kebab-case (lowercase letters, numbers, hyphens).`);
	}
	if (!scope || typeof scope !== 'string') {
		errors.push('Missing required field: "scope"');
	} else if (!allowedScopes.has(scope)) {
		errors.push(`Invalid scope "${scope}". Scope must match one of the valid host scopes: ${[...allowedScopes].join(', ')}`);
	}
	if (!query || typeof query !== 'string' || query.trim().length === 0) {
		errors.push('Missing required field: "query" (non-empty space-separated keywords)');
	}
	if (!insight || typeof insight !== 'string' || insight.trim().length === 0) {
		errors.push('Missing required field: "insight" (non-empty explanation)');
	} else if (insight.length > 300) {
		errors.push(`Insight exceeds maximum length of 300 characters (actual: ${insight.length})`);
	}
	if (confidence !== undefined && (typeof confidence !== 'number' || !Number.isInteger(confidence) || confidence < 1 || confidence > 10)) {
		errors.push(`Confidence must be an integer between 1 and 10 (actual: ${String(confidence)})`);
	}
	if (source !== undefined && (typeof source !== 'string' || !VALID_SOURCES.includes(source))) {
		errors.push(`Invalid source "${String(source)}". Allowed: ${VALID_SOURCES.join(', ')}`);
	}
	if (graduationTarget !== undefined && (typeof graduationTarget !== 'string' || !VALID_GRADUATION_TARGETS.includes(graduationTarget))) {
		errors.push(`Invalid graduationTarget "${String(graduationTarget)}". Allowed: ${VALID_GRADUATION_TARGETS.join(', ')}`);
	}
	if (files !== undefined && (!Array.isArray(files) || files.some((f) => typeof f !== 'string' || !f.trim()))) {
		errors.push('Field "files" must be an array of non-empty file path strings');
	}

	if (errors.length > 0) return { valid: false, errors, normalized: null };

	const normalized: NormalizedLearningEntry = {
		ts,
		type: type as string,
		key: key as string,
		scope: scope as string,
		query: (query as string).trim(),
		insight: (insight as string).trim(),
		...(Array.isArray(files) && files.length > 0 ? { files: files as string[] } : {}),
		confidence: confidence as number,
		source: source as string,
		...(typeof graduationTarget === 'string' && graduationTarget ? { graduationTarget } : {}),
	};
	return { valid: true, errors: [], normalized };
}

export const validateCandidateLearning = validateLearningEntry;

function extractTokensSync(text: unknown): string[] {
	if (!text || typeof text !== 'string') return [];
	return text.toLowerCase().split(TOKEN_SPLIT_REGEX).map((t) => t.trim()).filter(Boolean);
}

export async function extractLearningTokens(text: unknown): Promise<string[]> {
	return extractTokensSync(text);
}

export function scoreEntry(learning: LearningEntry, queryTokens: readonly string[], searchScope?: string | null): number {
	let scopeScore = 0;
	const learningScope = (learning.scope || 'global').toLowerCase();
	if (searchScope) {
		const targetScope = searchScope.toLowerCase();
		scopeScore = learningScope === targetScope ? 15 : learningScope === 'global' ? 5 : -10;
	}

	const keyTokens = new Set(extractTokensSync(learning.key));
	const queryFieldTokens = new Set(extractTokensSync(learning.query));
	const insightTokens = new Set(extractTokensSync(learning.insight));

	let keyHits = 0;
	let queryHits = 0;
	let insightHits = 0;
	for (const token of queryTokens) {
		if (keyTokens.has(token)) keyHits += 1;
		if (queryFieldTokens.has(token)) queryHits += 1;
		if (insightTokens.has(token)) insightHits += 1;
	}

	const rawScore = scopeScore + 8 * keyHits + 6 * queryHits + 3 * insightHits;
	return rawScore * ((learning.confidence || 8) / 10);
}

function parseLimit(limitInput: number | string | undefined): number {
	if (limitInput === undefined || limitInput === null || limitInput === '') return 3;
	const str = String(limitInput).trim();
	const num = Number(str);
	if (!Number.isInteger(num) || num < 1 || num > 20 || str !== String(num)) {
		throw new Error(`Invalid limit "${String(limitInput)}". Limit must be an integer between 1 and 20.`);
	}
	return num;
}

export async function searchLearningStore(
	learnings: LearningEntry[],
	options: LearningSearchOptions = {},
): Promise<Array<LearningEntry & { score: number }>> {
	const queryStr = (options.query || '').trim();
	const searchScope = options.scope ? options.scope.trim() : null;
	const limit = parseLimit(options.limit);
	const types = options.types && Array.isArray(options.types) && options.types.length > 0 ? options.types : null;

	const queryTokens = extractTokensSync(queryStr);
	const scored: Array<LearningEntry & { score: number }> = [];

	for (const item of learnings) {
		if ((item.confidence ?? 8) < 7) continue;
		if (types && !types.includes(item.type)) continue;
		const score = scoreEntry(item, queryTokens, searchScope);
		if (score > 0) scored.push({ ...item, score: Number(score.toFixed(2)) });
	}

	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return new Date(b.ts ?? 0).getTime() - new Date(a.ts ?? 0).getTime();
	});
	return scored.slice(0, limit);
}

export async function searchLearningsForScopes(
	learnings: LearningEntry[],
	options: LearningSearchOptions = {},
): Promise<Array<LearningEntry & { score: number }>> {
	return searchLearningStore(learnings, options);
}

export async function addLearningBatch(
	storePath: string,
	batchOrArray: unknown,
	options: { upsert?: boolean } & InferRecallScopesOptions = { upsert: false },
): Promise<NormalizedLearningEntry[]> {
	const rawItems = Array.isArray(batchOrArray)
		? batchOrArray
		: batchOrArray &&
			  typeof batchOrArray === 'object' &&
			  Array.isArray((batchOrArray as { candidates?: unknown }).candidates)
			? (batchOrArray as { candidates: unknown[] }).candidates
			: null;

	if (!rawItems) {
		throw new Error('addBatch payload must be an array of learnings or an object with a candidates array');
	}

	const normalizedItems: NormalizedLearningEntry[] = [];
	const batchKeys = new Set<string>();

	for (let i = 0; i < rawItems.length; i += 1) {
		const raw = rawItems[i];
		const validation = await validateLearningEntry(raw, options);
		if (!validation.valid || !validation.normalized) {
			const rawKey =
				raw && typeof raw === 'object' && typeof (raw as { key?: unknown }).key === 'string'
					? (raw as { key: string }).key
					: 'unknown';
			throw new Error(`Validation failed for item ${i + 1} (${rawKey}):\n- ${validation.errors.join('\n- ')}`);
		}
		const item = validation.normalized;
		if (batchKeys.has(item.key)) throw new Error(`Duplicate key "${item.key}" within batch payload.`);
		batchKeys.add(item.key);
		normalizedItems.push(item);
	}

	const learnings = await loadLearningStore(storePath);
	if (!options.upsert) {
		for (const item of normalizedItems) {
			if (learnings.some((existing) => existing.key === item.key)) {
				throw new Error(`Key "${item.key}" already exists. Use --upsert to replace existing entry.`);
			}
		}
	}

	for (const item of normalizedItems) {
		const existingIdx = learnings.findIndex((existing) => existing.key === item.key);
		if (existingIdx >= 0) {
			learnings[existingIdx] = { ...item, ts: new Date().toISOString() };
		} else {
			learnings.push(item);
		}
	}

	writeStore(storePath, learnings);
	return normalizedItems;
}

export async function addLearningEntry(
	storePath: string,
	rawPayload: unknown,
	options: { upsert?: boolean } & InferRecallScopesOptions = { upsert: false },
): Promise<NormalizedLearningEntry> {
	const validation = await validateLearningEntry(rawPayload, options);
	if (!validation.valid || !validation.normalized) {
		throw new Error(`Validation failed:\n- ${validation.errors.join('\n- ')}`);
	}

	const newEntry = validation.normalized;
	const learnings = await loadLearningStore(storePath);
	const existingIdx = learnings.findIndex((item) => item.key === newEntry.key);

	if (existingIdx >= 0) {
		if (!options.upsert) {
			throw new Error(`Key "${newEntry.key}" already exists. Use --upsert to replace existing entry.`);
		}
		learnings[existingIdx] = { ...newEntry, ts: new Date().toISOString() };
	} else {
		learnings.push(newEntry);
	}

	writeStore(storePath, learnings);
	return newEntry;
}

export const recordGraduatedLearning = addLearningEntry;

function isHostProfileObject(value: unknown): value is Readonly<HostProfile> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && 'schemaVersion' in (value as Record<string, unknown>) && 'adapter' in (value as Record<string, unknown>);
}

function isLearningsConfigObject(value: unknown): value is Readonly<HostLearningsConfig> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && ('scopeInference' in (value as Record<string, unknown>) || 'filePath' in (value as Record<string, unknown>) || 'scopes' in (value as Record<string, unknown>)) && !('schemaVersion' in (value as Record<string, unknown>));
}

function normalizeRecallInput(
	first: unknown,
	second?: unknown,
	third?: unknown,
): { targetPaths: readonly string[]; options: InferRecallScopesOptions } {
	let targetPaths: readonly string[] = [];
	let rawOptions: unknown;

	if (Array.isArray(first)) {
		targetPaths = first.filter((item): item is string => typeof item === 'string');
		rawOptions = second;
	} else if (typeof first === 'string') {
		if (Array.isArray(second)) {
			targetPaths = [...second.filter((item): item is string => typeof item === 'string'), first];
			rawOptions = third;
		} else {
			targetPaths = [first];
			rawOptions = second;
		}
	} else if (first && typeof first === 'object' && !isHostProfileObject(first) && !isLearningsConfigObject(first)) {
		const record = first as Record<string, unknown>;
		const list = record.targetPaths ?? record.touchedSurfaces ?? record.paths ?? record.files ?? [];
		const items = Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
		if (typeof record.prompt === 'string' && record.prompt.trim().length > 0) items.push(record.prompt);
		targetPaths = items;
		rawOptions = first;
	}

	if (typeof rawOptions === 'string') return { targetPaths, options: { rootDir: rawOptions } };
	if (isHostProfileObject(rawOptions)) return { targetPaths, options: { profile: rawOptions } };
	if (isLearningsConfigObject(rawOptions)) return { targetPaths, options: { learnings: rawOptions } };
	if (rawOptions && typeof rawOptions === 'object') {
		const optRecord = rawOptions as Record<string, unknown>;
		return {
			targetPaths,
			options: {
				rootDir: typeof optRecord.rootDir === 'string' ? optRecord.rootDir : undefined,
				profile: isHostProfileObject(optRecord.profile) ? optRecord.profile : undefined,
				learnings: isLearningsConfigObject(optRecord.learnings) ? optRecord.learnings : undefined,
			},
		};
	}
	return { targetPaths, options: {} };
}

export function inferRecallScopes(
	first:
		| readonly string[]
		| string
		| ({ readonly targetPaths?: readonly string[]; readonly touchedSurfaces?: readonly string[]; readonly paths?: readonly string[]; readonly files?: readonly string[]; readonly prompt?: string } & InferRecallScopesOptions),
	second?: readonly string[] | string | Readonly<HostProfile> | InferRecallScopesOptions,
	third?: string | Readonly<HostProfile> | InferRecallScopesOptions,
): string[] {
	const { targetPaths, options } = normalizeRecallInput(first, second, third);
	const config = resolveLearningsConfig(options);
	const configuredScopes = config?.scopes ?? [];
	const allowedScopes = resolveAllowedLearningScopes(options);
	const inferenceRules = config?.scopeInference ?? [];
	const detected = new Set<string>();

	for (const rawPath of targetPaths) {
		if (!rawPath || typeof rawPath !== 'string') continue;
		const normalized = rawPath.trim().replace(/\\/g, '/').replace(/^\.?\/?/, '');
		if (!normalized) continue;

		let matchedRule = false;
		for (const rule of inferenceRules) {
			if (rule.exact !== undefined) {
				const cleanExact = rule.exact.replace(/\/+$/, '');
				if ((normalized === cleanExact || normalized.startsWith(`${cleanExact}/`)) && rule.scope) {
					detected.add(rule.scope);
					matchedRule = true;
				}
			}
			const rawPrefix = rule.prefix ?? rule.pathPrefix;
			if (rawPrefix !== undefined) {
				const cleanPrefix = rawPrefix.replace(/\/+$/, '');
				if (normalized === cleanPrefix || normalized.startsWith(`${cleanPrefix}/`)) {
					if (rule.extractSegment || (!rule.scope && rawPrefix.endsWith('/'))) {
						const seg = normalized.slice(cleanPrefix.length + 1).split('/')[0];
						if (seg && (configuredScopes.length === 0 || allowedScopes.has(seg))) {
							detected.add(seg);
							matchedRule = true;
						}
					}
					if (rule.scope) {
						detected.add(rule.scope);
						matchedRule = true;
					}
				}
			}
			if (rule.pattern !== undefined) {
				try {
					const match = new RegExp(rule.pattern).exec(normalized);
					if (match && (rule.scope || match[1])) {
						detected.add((rule.scope ?? match[1]) as string);
						matchedRule = true;
					}
				} catch {
					// Ignore malformed regex if profile loader was bypassed
				}
			}
		}
		if (!matchedRule && allowedScopes.has(normalized)) detected.add(normalized);
	}
	return [...detected];
}
