import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	type InferRecallScopesOptions,
	type NormalizedLearningEntry,
	loadLearningStore,
	validateLearningEntry,
	writeLearningStore,
} from './learnings.ts';

export interface PruneOptions extends InferRecallScopesOptions {
	readonly key?: string;
	readonly missingFiles?: boolean;
	readonly apply?: boolean;
	readonly repoRoot: string;
}

export interface PruneResult {
	readonly prunedKey?: string;
	readonly staleEntries: ReadonlyArray<{ key: string; missingFile: string }>;
	readonly applied: boolean;
	readonly prunedCount: number;
}

export interface StoreValidation {
	readonly valid: boolean;
	readonly total: number;
	readonly errors: readonly string[];
}

export interface StoreStats {
	readonly total: number;
	readonly byType: Record<string, number>;
	readonly byScope: Record<string, number>;
	readonly byGraduationTarget: Record<string, number>;
}

/** Removes one entry by key, or the entries whose `files` no longer exist (dry run unless `apply`). */
export async function pruneLearningStore(storePath: string, options: PruneOptions): Promise<PruneResult> {
	const { key, missingFiles, apply = false, repoRoot } = options;
	if ((!key && !missingFiles) || (key && missingFiles)) {
		throw new Error('Prune requires exactly one of --key <key> or --missing-files');
	}
	const learnings = await loadLearningStore(storePath);
	if (key) {
		const index = learnings.findIndex((item) => item.key === key);
		if (index === -1) throw new Error(`Key "${key}" not found in learnings store.`);
		learnings.splice(index, 1);
		writeLearningStore(storePath, learnings);
		return { prunedKey: key, staleEntries: [], applied: true, prunedCount: 1 };
	}
	const staleEntries: Array<{ key: string; missingFile: string }> = [];
	for (const item of learnings) {
		for (const relPath of item.files ?? []) {
			if (!existsSync(resolve(repoRoot, relPath))) staleEntries.push({ key: item.key, missingFile: relPath });
		}
	}
	const staleKeys = new Set(staleEntries.map((entry) => entry.key));
	if (apply && staleKeys.size > 0) {
		writeLearningStore(storePath, learnings.filter((item) => !staleKeys.has(item.key)));
	}
	return { staleEntries, applied: apply, prunedCount: apply ? staleKeys.size : 0 };
}

/** Validates every line of the store: JSON syntax, entry schema and key uniqueness. */
export async function validateLearningStore(
	storePath: string,
	options: InferRecallScopesOptions = {},
): Promise<StoreValidation> {
	if (!existsSync(storePath)) return { valid: true, total: 0, errors: [] };
	const lines = readFileSync(storePath, 'utf-8').split('\n');
	const errors: string[] = [];
	const keysSeen = new Set<string>();
	let total = 0;
	for (const [index, rawLine] of lines.entries()) {
		if (!rawLine.trim()) continue;
		total += 1;
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawLine);
		} catch (error: unknown) {
			errors.push(`Line ${index + 1}: Malformed JSON (${error instanceof Error ? error.message : String(error)})`);
			continue;
		}
		const validation = await validateLearningEntry(parsed, options);
		if (!validation.valid || !validation.normalized) {
			const label = (parsed as { key?: unknown } | null)?.key;
			errors.push(`Line ${index + 1} (${typeof label === 'string' ? label : 'unknown'}): ${validation.errors.join('; ')}`);
		} else if (keysSeen.has(validation.normalized.key)) {
			errors.push(`Line ${index + 1}: Duplicate key "${validation.normalized.key}"`);
		} else {
			keysSeen.add(validation.normalized.key);
		}
	}
	return { valid: errors.length === 0, total, errors };
}

export function learningStoreStats(learnings: readonly NormalizedLearningEntry[]): StoreStats {
	const byType: Record<string, number> = {};
	const byScope: Record<string, number> = {};
	const byGraduationTarget: Record<string, number> = {};
	for (const item of learnings) {
		byType[item.type] = (byType[item.type] ?? 0) + 1;
		const scope = item.scope || 'global';
		byScope[scope] = (byScope[scope] ?? 0) + 1;
		if (item.graduationTarget) {
			byGraduationTarget[item.graduationTarget] = (byGraduationTarget[item.graduationTarget] ?? 0) + 1;
		}
	}
	return { total: learnings.length, byType, byScope, byGraduationTarget };
}
