/**
 * tools/agent-sdlc/roles/upstream-recall.ts — Upstream knowledge recall & scope mapping
 */

import { existsSync } from 'node:fs';
import {
	type InferRecallScopesOptions,
	type LearningEntry,
	type LearningScope,
	type LearningType,
	inferRecallScopes,
	loadLearningStore,
	resolveLearningRepoRoot,
	resolveLearningStorePath,
	searchLearningStore,
} from '../host/learnings.ts';

export interface CandidateLearningLike {
	learning_key?: string;
	key?: string;
	learning_type?: LearningType;
	type?: LearningType;
	scope?: LearningScope;
	query?: string;
	insight?: string;
	confidence?: number;
	source?: LearningEntry['source'];
}

export interface ResolveScopeLearningsOptions {
	rootDir?: string;
	targetPaths?: readonly string[];
	roleId?: string;
	roleKind?: string;
	taskDescription?: string;
	modelProfile?: string;
	requestedLimits?: { maxPromptTokens?: number } | null;
	storePath?: string | null;
	candidateLearnings?: readonly CandidateLearningLike[];
}

/**
 * Deterministically maps target file paths or package names to a configured host scope.
 * If paths cross multiple scopes or cannot be localized, returns 'global'.
 */
export function resolveTargetScope(
	targetPaths: readonly string[] = [],
	options?: InferRecallScopesOptions,
): LearningScope {
	if (!Array.isArray(targetPaths) || targetPaths.length === 0) {
		return 'global';
	}

	const detectedScopes = inferRecallScopes(targetPaths, options).filter(
		(scope) => scope !== 'global',
	);

	if (detectedScopes.length === 1) {
		return detectedScopes[0];
	}

	return 'global';
}

/**
 * Returns role-affinity knowledge types according to spec.
 */
export function getRoleAffinityTypes(roleKind: string | null | undefined): LearningType[] {
	const normalized = (roleKind || '').toLowerCase();
	switch (normalized) {
		case 'architect':
			return ['architecture', 'preference'];
		case 'hardener':
			return ['pitfall', 'pattern'];
		case 'implementer':
		case 'repairer':
			return ['pitfall', 'pattern', 'architecture'];
		case 'specifier':
			return ['architecture', 'operational'];
		default:
			return ['pitfall', 'pattern'];
	}
}

/**
 * Formats recalled learnings into prompt context block.
 */
export function formatScopeLearnings(learnings: readonly LearningEntry[] | null | undefined): string {
	if (!Array.isArray(learnings) || learnings.length === 0) {
		return '';
	}

	const lines = ['## Institutional Memory & Scope Pitfalls'];
	for (const item of learnings.slice(0, 3)) {
		const rawInsight = item.insight || '';
		const truncated = rawInsight.length > 300 ? rawInsight.slice(0, 300) : rawInsight;
		lines.push(`- [${item.type}] (${item.scope || 'global'}) ${item.key}: ${truncated}`);
	}

	return lines.join('\n');
}

/**
 * Resolves upstream scope learnings for a given role and target scope.
 * Bypasses store lookup immediately for deterministic profiles.
 */
export async function resolveScopeLearnings({
	rootDir,
	targetPaths = [],
	roleId = '',
	roleKind = '',
	taskDescription = '',
	modelProfile = '',
	requestedLimits = null,
	storePath: explicitStorePath = null,
	candidateLearnings = [],
}: ResolveScopeLearningsOptions = {}): Promise<string> {
	if (
		modelProfile === 'agent-sdlc-deterministic' ||
		requestedLimits?.maxPromptTokens === 0
	) {
		return '';
	}

	const resolvedRootDir = rootDir ?? (await resolveLearningRepoRoot());
	const storePath = explicitStorePath || (await resolveLearningStorePath({}, resolvedRootDir));
	const repoStorePath = await resolveLearningStorePath({});
	const pool: LearningEntry[] = existsSync(storePath) ? await loadLearningStore(storePath) : [];
	if (!explicitStorePath && repoStorePath !== storePath && existsSync(repoStorePath)) {
		const repoLearnings = await loadLearningStore(repoStorePath);
		const existingKeys = new Set(pool.map((e) => e.key));
		for (const entry of repoLearnings) {
			if (!existingKeys.has(entry.key)) {
				pool.push(entry);
				existingKeys.add(entry.key);
			}
		}
	}
	if (Array.isArray(candidateLearnings) && candidateLearnings.length > 0) {
		const existingKeys = new Set(pool.map((e) => e.key));
		for (const candidate of candidateLearnings) {
			const key = candidate.learning_key || candidate.key;
			if (key && !existingKeys.has(key)) {
				pool.push({
					type: candidate.learning_type || candidate.type || 'pitfall',
					key,
					scope: candidate.scope ?? 'global',
					query: candidate.query || '',
					insight: candidate.insight || '',
					confidence: candidate.confidence ?? 9,
					source: candidate.source || 'user-stated',
				});
				existingKeys.add(key);
			}
		}
	}

	if (pool.length === 0) {
		return '';
	}

	const effectiveRole = roleKind || roleId;
	const types = getRoleAffinityTypes(effectiveRole);
	const scope = resolveTargetScope(targetPaths, { rootDir: resolvedRootDir });

	const results = await searchLearningStore(pool, {
		query: taskDescription || '',
		scope,
		types,
		limit: 3,
	});

	return formatScopeLearnings(results);
}
