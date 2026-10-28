#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { resolveAggregatedAttributionLayer } from '../policy/contracts.ts';
import {
	listRunDatabases,
	readDatabaseFindings,
	readSkillsDatabaseFindings,
	readSyncArtifactFindings,
	type CriticFindingOccurrence,
	type SkillFindingOccurrence,
} from './critic-trends-sources.ts';

const DEFAULT_THRESHOLD = 3;

export interface SkillTrendItem {
	key: string;
	roleId: string;
	signalType: string;
	category: string;
	runCount: number;
	occurrences: number;
	runIds: string[];
	status: 'RECOMMENDED' | 'PROVISIONAL';
	attributionLayer: 'layer1' | 'layer3' | 'layer5';
}

export interface RecommendedSkillProposal extends SkillTrendItem {
	proposedDiff: string;
}

export interface Layer1SkillProposal extends SkillTrendItem {
	layer1Proposal: {
		description: string;
	};
}

export interface SkillsTrendsResult {
	schemaVersion: '1.0.0';
	threshold: number;
	floorEnforced: boolean;
	notice: string | null;
	databasesScanned: number;
	trends: SkillTrendItem[];
	recommendedProposals: RecommendedSkillProposal[];
	layer1Proposals: Layer1SkillProposal[];
}

export interface CriticTrendItem {
	key: string;
	source: string;
	runCount: number;
	occurrences: number;
	runIds: string[];
}

export interface CriticTrendProposal extends CriticTrendItem {
	layer1: {
		kind: 'vitest' | 'dependency-cruiser' | 'semgrep';
		description: string;
	};
	layer3: string;
}

export interface CriticTrendsResult {
	schemaVersion: '1.0.0';
	threshold: number;
	databasesScanned: number;
	trends: CriticTrendItem[];
	proposals: CriticTrendProposal[];
}

export interface ParsedTrendsCliArgs {
	skills: boolean;
	json: boolean;
	dryRun: boolean;
	threshold: number;
	rootDir: string;
}

/**
 * Aggregates durable critic and deterministic-role findings across completed run stores.
 * The scanner is intentionally read-only so trend inspection cannot mutate run evidence.
 */
export function aggregateCriticTrends({
	rootDir = REPOSITORY_ROOT,
	threshold = DEFAULT_THRESHOLD,
}: {
	rootDir?: string;
	threshold?: number;
} = {}): CriticTrendsResult {
	const occurrences: CriticFindingOccurrence[] = [];
	for (const { runId, databasePath } of listRunDatabases(rootDir)) {
		occurrences.push(...readDatabaseFindings(databasePath, runId, rootDir));
	}
	return buildResult(occurrences, threshold);
}

/**
 * Aggregates prompt friction and skill attribution findings across both local SQLite
 * databases (Source A) and git-tracked sync artifacts (Source B).
 * Enforces the anti-overfitting floor (threshold >= 3) and the Ratchet Layer Merge Rule.
 */
export function aggregateSkillsTrends({
	rootDir = REPOSITORY_ROOT,
	threshold = DEFAULT_THRESHOLD,
}: {
	rootDir?: string;
	threshold?: number;
} = {}): SkillsTrendsResult {
	let effectiveThreshold = threshold;
	let floorEnforced = false;
	if (effectiveThreshold < 3) {
		effectiveThreshold = 3;
		floorEnforced = true;
	}

	const occurrences: SkillFindingOccurrence[] = [];
	const scannedRunIds = new Set<string>();

	// Source A: Local SQLite runs
	for (const { runId, databasePath } of listRunDatabases(rootDir)) {
		scannedRunIds.add(runId);
		occurrences.push(...readSkillsDatabaseFindings(databasePath, runId));
	}

	// Source B: Committed git artifacts (.agents/trace-findings/*.json)
	const artifacts = readSyncArtifactFindings(rootDir);
	for (const runId of artifacts.runIds) scannedRunIds.add(runId);
	occurrences.push(...artifacts.occurrences);

	return buildSkillsResult(
		occurrences,
		effectiveThreshold,
		scannedRunIds.size,
		floorEnforced,
		rootDir,
	);
}

export function buildSkillsResult(
	occurrences: readonly SkillFindingOccurrence[],
	threshold = DEFAULT_THRESHOLD,
	databasesScanned = 0,
	floorEnforced = false,
	rootDir = REPOSITORY_ROOT,
): SkillsTrendsResult {
	// Deduplicate occurrences by composite key `${runId}:${findingKey}`
	const seen = new Set<string>();
	const deduped: SkillFindingOccurrence[] = [];
	for (const occ of occurrences) {
		const comp = `${occ.runId}:${occ.findingKey}`;
		if (!seen.has(comp)) {
			seen.add(comp);
			deduped.push(occ);
		}
	}

	const grouped = new Map<
		string,
		{
			key: string;
			roleId: string;
			signalType: string;
			category: string;
			runIds: Set<string>;
			occurrences: number;
			layers: string[];
			proposedDiffs: string[];
			evidences: Array<Record<string, unknown>>;
		}
	>();
	for (const occ of deduped) {
		const current = grouped.get(occ.findingKey) ?? {
			key: occ.findingKey,
			roleId: occ.roleId,
			signalType: occ.signalType,
			category: occ.category,
			runIds: new Set<string>(),
			occurrences: 0,
			layers: [],
			proposedDiffs: [],
			evidences: [],
		};
		current.runIds.add(occ.runId);
		current.occurrences += 1;
		current.layers.push(occ.attributionLayer);
		if (occ.proposedDiff) current.proposedDiffs.push(occ.proposedDiff);
		if (occ.evidence) current.evidences.push(occ.evidence);
		grouped.set(occ.findingKey, current);
	}

	const trends: SkillTrendItem[] = [];
	const recommendedProposals: RecommendedSkillProposal[] = [];
	const layer1Proposals: Layer1SkillProposal[] = [];

	for (const item of grouped.values()) {
		const runCount = item.runIds.size;
		const status: 'RECOMMENDED' | 'PROVISIONAL' = runCount >= threshold ? 'RECOMMENDED' : 'PROVISIONAL';
		// Invariant 3: Ratchet Layer Merge Rule
		const attributionLayer = resolveAggregatedAttributionLayer(item.layers);

		const trendObj: SkillTrendItem = {
			key: item.key,
			roleId: item.roleId,
			signalType: item.signalType,
			category: item.category,
			runCount,
			occurrences: item.occurrences,
			runIds: [...item.runIds].sort(),
			status,
			attributionLayer,
		};
		trends.push(trendObj);

		if (status === 'RECOMMENDED') {
			if (attributionLayer === 'layer3') {
				const proposedDiff =
					item.proposedDiffs[0] ||
					generatePromptDiff(rootDir, item.roleId, item.key, item.category);
				recommendedProposals.push({
					...trendObj,
					proposedDiff,
				});
			} else if (attributionLayer === 'layer1') {
				layer1Proposals.push({
					...trendObj,
					layer1Proposal: {
						description: `Mechanical remedy recommended for ${item.key}. Add type, contract, test, or package script. (No prompt modifications allowed).`,
					},
				});
			}
		}
	}

	trends.sort((a, b) => b.runCount - a.runCount || a.key.localeCompare(b.key));
	recommendedProposals.sort((a, b) => b.runCount - a.runCount || a.key.localeCompare(b.key));
	layer1Proposals.sort((a, b) => b.runCount - a.runCount || a.key.localeCompare(b.key));

	return {
		schemaVersion: '1.0.0',
		threshold,
		floorEnforced,
		notice: floorEnforced ? 'Enforcing anti-overfitting floor: threshold clamped to 3' : null,
		databasesScanned,
		trends,
		recommendedProposals,
		layer1Proposals,
	};
}

function generatePromptDiff(
	rootDir: string,
	roleId: string,
	findingKey: string,
	category: string,
): string {
	const relPath = `.agents/workflows/prompts/${roleId}.md`;
	const fullPath = path.join(rootDir, relPath);
	let original = '';
	if (fs.existsSync(fullPath)) {
		original = fs.readFileSync(fullPath, 'utf8');
	} else {
		original = `# ${roleId} Role Prompt\n`;
	}

	const originalLines = original.split('\n');
	const startLine = originalLines.length;

	return [
		`diff --git a/${relPath} b/${relPath}`,
		`--- a/${relPath}`,
		`+++ b/${relPath}`,
		`@@ -${startLine},1 +${startLine},4 @@`,
		`+<!-- Learned SDLC Rule: ${findingKey} -->`,
		`+- Invariant [${category}]: Always verify ${category} constraints before completing action.`,
	].join('\n');
}

export function buildResult(
	occurrences: readonly CriticFindingOccurrence[],
	threshold = DEFAULT_THRESHOLD,
): CriticTrendsResult {
	if (!Number.isSafeInteger(threshold) || threshold < 1) {
		throw new TypeError('threshold must be a positive integer');
	}
	const grouped = new Map<
		string,
		{
			key: string;
			source: string;
			runIds: Set<string>;
			occurrences: number;
		}
	>();
	for (const occurrence of occurrences) {
		const current = grouped.get(occurrence.key) ?? {
			key: occurrence.key,
			source: occurrence.source,
			runIds: new Set<string>(),
			occurrences: 0,
		};
		current.runIds.add(occurrence.runId);
		current.occurrences += 1;
		grouped.set(occurrence.key, current);
	}

	const trends: CriticTrendItem[] = [...grouped.values()]
		.map((item) => ({
			key: item.key,
			source: item.source,
			runCount: item.runIds.size,
			occurrences: item.occurrences,
			runIds: [...item.runIds].sort(),
		}))
		.sort((left, right) => right.runCount - left.runCount || left.key.localeCompare(right.key));
	const proposals: CriticTrendProposal[] = trends
		.filter((trend) => trend.runCount >= threshold)
		.map((trend) => ({
			...trend,
			layer1: layerOneProposal(trend),
			layer3: `Add ${trend.key} to the relevant role prompt as a fail-closed invariant.`,
		}));
	return {
		schemaVersion: '1.0.0',
		threshold,
		databasesScanned: new Set(occurrences.map((item) => item.runId)).size,
		trends,
		proposals,
	};
}

function layerOneProposal(trend: CriticTrendItem): CriticTrendProposal['layer1'] {
	if (trend.source === 'hardener') {
		return {
			kind: 'vitest',
			description: `Add a reusable regression test for ${trend.key}.`,
		};
	}
	if (
		trend.source === 'architect' &&
		/(cross-package|service-boundary|relative-traversal)/.test(trend.key)
	) {
		return {
			kind: 'dependency-cruiser',
			description: `Add an import-boundary rule for ${trend.key}.`,
		};
	}
	return {
		kind: 'semgrep',
		description: `Add an AST rule for ${trend.key}.`,
	};
}

export function parseCliArgs(argv: readonly string[]): ParsedTrendsCliArgs {
	let skills = false;
	let json = false;
	let dryRun = false;
	let threshold = DEFAULT_THRESHOLD;
	let rootDir = REPOSITORY_ROOT;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--skills') {
			skills = true;
		} else if (arg === '--json') {
			json = true;
		} else if (arg === '--dry-run') {
			dryRun = true;
		} else if (arg === '--threshold') {
			const nextArg = argv[i + 1];
			if (!nextArg || nextArg.startsWith('--')) {
				throw new Error("Missing value for '--threshold'");
			}
			i += 1;
			const parsed = parseInt(nextArg, 10);
			if (Number.isNaN(parsed) || parsed < 1) {
				throw new Error("Invalid value for '--threshold'");
			}
			threshold = parsed;
		} else if (arg === '--root') {
			const nextArg = argv[i + 1];
			if (!nextArg || nextArg.startsWith('--')) {
				throw new Error("Missing value for '--root'");
			}
			i += 1;
			rootDir = path.resolve(nextArg);
		} else {
			throw new Error(`Unknown argument '${String(arg)}'`);
		}
	}

	return { skills, json, dryRun, threshold, rootDir };
}

function renderHuman(result: CriticTrendsResult): string {
	if (result.proposals.length === 0) {
		return `No trends reached the ${result.threshold}-run graduation threshold.`;
	}
	return result.proposals
		.map(
			(proposal) =>
				`${proposal.key} (${proposal.runCount} runs) -> ${proposal.layer1.kind}: ${proposal.layer1.description}`,
		)
		.join('\n');
}

export function renderSkillsHuman(result: SkillsTrendsResult): string {
	const lines: string[] = [];
	if (result.notice) {
		lines.push(result.notice);
	}
	if (result.recommendedProposals.length === 0) {
		lines.push(
			`No prompt skill trends reached the ${result.threshold}-run recommendation threshold (${result.trends.length} provisional trend(s) observed).`,
		);
	} else {
		lines.push(
			`⚡ SDLC Skill Learning Proposals (${result.recommendedProposals.length} recommended):`,
		);
		for (const prop of result.recommendedProposals) {
			lines.push(`  - ${prop.key} (${prop.runCount} runs) -> RECOMMENDED`);
		}
		lines.push('');
		const topKey = result.recommendedProposals[0]?.key;
		const keyArg = topKey ? `"${topKey}"` : '<key>';
		lines.push(`Run 'agent-sdlc skills --apply --key ${keyArg}' to update prompts.`);
	}

	if (result.layer1Proposals.length > 0) {
		lines.push('');
		lines.push('⚙️  Mechanical Layer 1 Graduations:');
		for (const prop of result.layer1Proposals) {
			lines.push(`  - ${prop.key} (${prop.runCount} runs) -> ${prop.layer1Proposal.description}`);
		}
	}

	return lines.join('\n');
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
	const options = parseCliArgs(argv);
	if (options.skills) {
		const result = aggregateSkillsTrends({
			rootDir: options.rootDir,
			threshold: options.threshold,
		});
		process.stdout.write(
			options.json ? `${JSON.stringify(result, null, 2)}\n` : `${renderSkillsHuman(result)}\n`,
		);
	} else {
		const result = aggregateCriticTrends({
			rootDir: options.rootDir,
			threshold: options.threshold,
		});
		process.stdout.write(
			options.json ? `${JSON.stringify(result, null, 2)}\n` : `${renderHuman(result)}\n`,
		);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`agent-sdlc-trends failed: ${message}\n`);
		process.exitCode = 1;
	});
}
