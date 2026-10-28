import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { REPOSITORY_ROOT, listRunDatabases } from '../persistence/run-paths.ts';
import { resolveAggregatedAttributionLayer } from '../policy/contracts.ts';

export interface FleetFrictionSummary {
	unreviewedFrictionCount: number;
	unreviewedRunIds: string[];
	staleRecommendationsCount: number;
	recommendedKeys: string[];
}

interface FrictionOccurrence {
	runId: string;
	key: string;
	roleId: unknown;
	signalType: unknown;
	category: unknown;
	status: unknown;
	attributionLayer: unknown;
	createdAt: string;
}

/**
 * Scans local live and archived run databases and committed trace findings
 * under .agents/trace-findings to calculate fleet-level friction and learning debt.
 */
export function readFleetFrictionSummary({
	rootDir = REPOSITORY_ROOT,
}: { rootDir?: string } = {}): FleetFrictionSummary {
	const traceFindingsDir = path.join(rootDir, '.agents/trace-findings');
	const appliedSkillsPath = path.join(rootDir, '.agents/applied-skills.json');

	let unreviewedFrictionCount = 0;
	const unreviewedRunIds: string[] = [];
	const occurrences: FrictionOccurrence[] = [];

	// 1. Scan local live and archived SQLite databases
	for (const { runId, databasePath } of listRunDatabases(rootDir)) {
		try {
			const database = new DatabaseSync(databasePath, { readOnly: true });
			try {
				const tables = database
					.prepare("SELECT name FROM sqlite_master WHERE type='table'")
					.all()
					.map((r) => String((r as Record<string, unknown>).name ?? ''));

				if (tables.includes('events')) {
					const hasDetected = database
						.prepare(
							"SELECT 1 FROM events WHERE event_type = 'PROMPT_FRICTION_DETECTED' LIMIT 1",
						)
						.get();
					if (hasDetected) {
						const hasAnalyzed = database
							.prepare(
								"SELECT 1 FROM events WHERE event_type = 'PROMPT_FRICTION_ANALYZED' LIMIT 1",
							)
							.get();
						if (!hasAnalyzed) {
							unreviewedFrictionCount += 1;
							unreviewedRunIds.push(runId);
						}
					}
				}

				if (tables.includes('prompt_friction_findings')) {
					const rows = database
						.prepare(
							'SELECT finding_id, run_id, role_id, signal_type, category, finding_key, status, attribution_layer, created_at FROM prompt_friction_findings',
						)
						.all() as Array<Record<string, unknown>>;
					for (const row of rows) {
						occurrences.push({
							runId: String(row.run_id ?? ''),
							key: String(row.finding_key ?? ''),
							roleId: row.role_id,
							signalType: row.signal_type,
							category: row.category,
							status: row.status,
							attributionLayer: row.attributionLayer,
							createdAt: typeof row.created_at === 'string' ? row.created_at : '',
						});
					}
				}
			} finally {
				database.close();
			}
		} catch {
			// Ignore corrupted/unreadable single run DBs gracefully
		}
	}

	// 2. Scan committed git artifacts (.agents/trace-findings/*.json)
	if (fs.existsSync(traceFindingsDir)) {
		for (const file of fs.readdirSync(traceFindingsDir)) {
			if (!file.endsWith('.json')) continue;
			const filePath = path.join(traceFindingsDir, file);
			try {
				const content = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
				if (Array.isArray(content.findings)) {
					for (const rawFinding of content.findings) {
						const finding = rawFinding as Record<string, unknown>;
						occurrences.push({
							runId:
								typeof content.runId === 'string'
									? content.runId
									: file.replace(/\.json$/, ''),
							key: String(finding.findingKey ?? ''),
							roleId: finding.roleId,
							signalType: finding.signalType,
							category: finding.category,
							status: finding.status,
							attributionLayer: finding.attributionLayer,
							createdAt:
								typeof content.analyzedAt === 'string'
									? content.analyzedAt
									: new Date().toISOString(),
						});
					}
				}
			} catch {
				// Ignore invalid JSON files gracefully
			}
		}
	}

	// 3. Deduplicate occurrences by (runId, key)
	const dedupedOccurrences = new Map<string, FrictionOccurrence>();
	for (const occ of occurrences) {
		const compositeKey = `${occ.runId}::${occ.key}`;
		if (!dedupedOccurrences.has(compositeKey)) {
			dedupedOccurrences.set(compositeKey, occ);
		}
	}

	// 4. Group by key to find recommended proposals (runCount >= 3)
	const grouped = new Map<
		string,
		{
			key: string;
			runIds: Set<string>;
			layers: Set<string>;
			firstCreatedAt: string;
			latestCreatedAt: string;
		}
	>();
	for (const occ of dedupedOccurrences.values()) {
		const current = grouped.get(occ.key) ?? {
			key: occ.key,
			runIds: new Set<string>(),
			layers: new Set<string>(),
			firstCreatedAt: occ.createdAt,
			latestCreatedAt: occ.createdAt,
		};
		current.runIds.add(occ.runId);
		if (typeof occ.attributionLayer === 'string') {
			current.layers.add(occ.attributionLayer);
		}
		if (occ.createdAt && occ.createdAt < current.firstCreatedAt) {
			current.firstCreatedAt = occ.createdAt;
		}
		if (occ.createdAt && occ.createdAt > current.latestCreatedAt) {
			current.latestCreatedAt = occ.createdAt;
		}
		grouped.set(occ.key, current);
	}

	// 5. Read applied keys
	const appliedKeys = new Set<string>();
	if (fs.existsSync(appliedSkillsPath)) {
		try {
			const appliedData = JSON.parse(fs.readFileSync(appliedSkillsPath, 'utf8')) as Record<
				string,
				unknown
			>;
			if (Array.isArray(appliedData.applied)) {
				for (const rawItem of appliedData.applied) {
					const item = rawItem as Record<string, unknown>;
					if (typeof item.findingKey === 'string' && item.findingKey) {
						appliedKeys.add(item.findingKey);
					}
				}
			}
		} catch {
			// ignore parse failure
		}
	}

	const recommendedKeys: string[] = [];
	let staleRecommendationsCount = 0;
	const nowMs = Date.now();
	const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

	for (const [key, item] of grouped.entries()) {
		if (item.runIds.size >= 3) {
			const resolvedLayer = resolveAggregatedAttributionLayer(item.layers);
			if (resolvedLayer === 'layer3') {
				recommendedKeys.push(key);
				if (!appliedKeys.has(key)) {
					const firstAgeMs =
						nowMs - Date.parse(item.firstCreatedAt || new Date().toISOString());
					if (firstAgeMs >= SEVEN_DAYS_MS || item.runIds.size >= 4) {
						staleRecommendationsCount += 1;
					}
				}
			}
		}
	}

	return {
		unreviewedFrictionCount,
		unreviewedRunIds,
		staleRecommendationsCount,
		recommendedKeys,
	};
}
