// Run-database and sync-artifact readers for critic and skills trend aggregation.
// Leaf module: it never imports the aggregation script. `listRunDatabases` delegates
// to `persistence/run-paths.ts` for live and archived run discovery.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { listRunDatabases as listAllRunDatabases } from '../persistence/run-paths.ts';
import { SkillFindingsSyncArtifactSchema } from '../policy/contracts.ts';

export interface RunDatabaseRef {
	runId: string;
	databasePath: string;
}

export interface SkillFindingOccurrence {
	runId: string;
	findingKey: string;
	roleId: string;
	signalType: string;
	category: string;
	attributionLayer: string;
	status: string;
	evidence: Record<string, unknown>;
	proposedDiff: string | null;
	source: 'artifact' | 'sqlite';
}

export interface CriticFindingOccurrence {
	runId: string;
	source: string;
	key: string;
}

/**
 * Lists the live and archived run databases under `rootDir`, in deterministic order.
 * Symlinked entries and directories without `runtime.sqlite` are skipped.
 */
export function listRunDatabases(rootDir: string): RunDatabaseRef[] {
	return listAllRunDatabases(rootDir).map(({ runId, databasePath }) => ({
		runId,
		databasePath,
	}));
}

/**
 * Reads git-tracked skill findings sync artifacts (`.agents/trace-findings/*.json`).
 * Files that do not match the artifact schema are ignored.
 */
export function readSyncArtifactFindings(rootDir: string): {
	occurrences: SkillFindingOccurrence[];
	runIds: string[];
} {
	const occurrences: SkillFindingOccurrence[] = [];
	const runIds: string[] = [];
	const findingsDir = path.join(rootDir, '.agents/trace-findings');
	if (!fs.existsSync(findingsDir)) return { occurrences, runIds };
	for (const entry of fs.readdirSync(findingsDir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
		const artifactPath = path.join(findingsDir, entry.name);
		try {
			const content: unknown = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
			const validated = SkillFindingsSyncArtifactSchema.safeParse(content);
			if (validated.success) {
				runIds.push(validated.data.runId);
				for (const f of validated.data.findings) {
					occurrences.push({
						runId: validated.data.runId,
						findingKey: f.findingKey,
						roleId: f.roleId,
						signalType: f.signalType,
						category: f.category,
						attributionLayer: f.attributionLayer,
						status: f.status,
						evidence: f.evidence ?? {},
						proposedDiff: f.proposedDiff ?? null,
						source: 'artifact',
					});
				}
			}
		} catch {
			// Ignore non-compliant files
		}
	}
	return { occurrences, runIds };
}

export function readSkillsDatabaseFindings(
	databasePath: string,
	runId: string,
): SkillFindingOccurrence[] {
	const database = new DatabaseSync(databasePath, { readOnly: true });
	try {
		const findings: SkillFindingOccurrence[] = [];
		if (tableExists(database, 'prompt_friction_findings')) {
			const rows = database
				.prepare(
					'SELECT finding_id, role_id, signal_type, category, finding_key, status, attribution_layer, evidence_json, proposed_diff_json FROM prompt_friction_findings',
				)
				.all() as Array<{
				finding_id?: string;
				role_id?: string;
				signal_type?: string;
				category?: string;
				finding_key?: string;
				status?: string;
				attribution_layer?: string;
				evidence_json?: string | null;
				proposed_diff_json?: string | null;
			}>;
			for (const row of rows) {
				let evidence: Record<string, unknown> = {};
				try {
					const parsedEvidence: unknown = row.evidence_json ? JSON.parse(row.evidence_json) : {};
					if (parsedEvidence && typeof parsedEvidence === 'object' && !Array.isArray(parsedEvidence)) {
						evidence = parsedEvidence as Record<string, unknown>;
					}
				} catch {
					// Keep empty evidence
				}
				let proposedDiff: string | null = null;
				if (row.proposed_diff_json) {
					try {
						const parsedDiff: unknown = JSON.parse(row.proposed_diff_json);
						proposedDiff = typeof parsedDiff === 'string' ? parsedDiff : row.proposed_diff_json;
					} catch {
						proposedDiff = row.proposed_diff_json;
					}
				}
				findings.push({
					runId,
					findingKey: String(row.finding_key ?? ''),
					roleId: String(row.role_id ?? ''),
					signalType: String(row.signal_type ?? ''),
					category: String(row.category ?? ''),
					attributionLayer: String(row.attribution_layer ?? ''),
					status: String(row.status ?? ''),
					evidence,
					proposedDiff,
					source: 'sqlite',
				});
			}
		}
		return findings;
	} finally {
		database.close();
	}
}

export function readDatabaseFindings(
	databasePath: string,
	runId: string,
	rootDir: string,
): CriticFindingOccurrence[] {
	const database = new DatabaseSync(databasePath, { readOnly: true });
	try {
		const findings: CriticFindingOccurrence[] = [];
		if (tableExists(database, 'critic_reviews')) {
			const columns = tableColumns(database, 'critic_reviews');
			if (columns.has('findings_json')) {
				const rows = database
					.prepare('SELECT review_id, phase, findings_json, manifest_path FROM critic_reviews')
					.all() as Array<{
					review_id?: string;
					phase?: string;
					findings_json?: string | null;
					manifest_path?: string | null;
				}>;
				for (const row of rows) {
					const values = row.findings_json
						? parseFindingsJson(row.findings_json, databasePath)
						: readLegacyCriticFindings(row, rootDir);
					for (const finding of values) {
						const rule = normalizeSegment(
							finding.ruleId ?? finding.rule_id ?? finding.category ?? 'unknown',
						);
						findings.push({
							runId,
							source: `critic:${String(row.phase ?? '')}`,
							key: `[critic:${normalizeSegment(row.phase)}] rule:${rule}`,
						});
					}
				}
			}
		}
		if (tableExists(database, 'optional_role_executions')) {
			const columns = tableColumns(database, 'optional_role_executions');
			if (columns.has('structured_findings_json')) {
				const rows = database
					.prepare(
						`SELECT role_id, structured_findings_json
						 FROM optional_role_executions
						 WHERE structured_findings_json IS NOT NULL`,
					)
					.all() as Array<{
					role_id?: string;
					structured_findings_json?: string | null;
				}>;
				for (const row of rows) {
					if (!row.structured_findings_json) continue;
					const structured = parseJson(row.structured_findings_json, databasePath);
					const record =
						structured && typeof structured === 'object'
							? (structured as {
									violations?: Array<{ boundary?: unknown }>;
									shadowPathsCovered?: unknown[];
							  })
							: {};
					if (row.role_id === 'architect') {
						for (const violation of record.violations ?? []) {
							const boundary = normalizeSegment(violation?.boundary ?? 'unknown');
							findings.push({
								runId,
								source: 'architect',
								key: `[architect] boundary:${boundary}`,
							});
						}
					} else if (row.role_id === 'hardener') {
						for (const shadowPath of record.shadowPathsCovered ?? []) {
							findings.push({
								runId,
								source: 'hardener',
								key: `[hardener] shadow_path:${normalizeSegment(shadowPath)}`,
							});
						}
					}
				}
			}
		}
		return findings;
	} finally {
		database.close();
	}
}

function readLegacyCriticFindings(
	row: { review_id?: string; manifest_path?: string | null },
	rootDir: string,
): Array<Record<string, unknown>> {
	if (!row.manifest_path) return [];
	const manifestPath = resolveContainedPath(rootDir, row.manifest_path);
	if (!manifestPath || !fs.existsSync(manifestPath)) return [];
	const manifestRaw = parseJson(fs.readFileSync(manifestPath, 'utf8'), manifestPath);
	const manifest =
		manifestRaw && typeof manifestRaw === 'object'
			? (manifestRaw as {
					reviews?: Array<{ reviewId?: string; reportPath?: string }>;
			  })
			: {};
	const review = manifest.reviews?.find((item) => item.reviewId === row.review_id);
	if (!review?.reportPath) return [];
	const reportPath = resolveContainedPath(rootDir, review.reportPath);
	if (!reportPath || !fs.existsSync(reportPath)) return [];
	const reportRaw = parseJson(fs.readFileSync(reportPath, 'utf8'), reportPath);
	const report =
		reportRaw && typeof reportRaw === 'object'
			? (reportRaw as { findings?: unknown })
			: {};
	return Array.isArray(report.findings) ? (report.findings as Array<Record<string, unknown>>) : [];
}

function parseFindingsJson(value: string, source: string): Array<Record<string, unknown>> {
	const parsed = parseJson(value, source);
	if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
	if (parsed && typeof parsed === 'object' && 'findings' in parsed && Array.isArray(parsed.findings)) {
		return parsed.findings as Array<Record<string, unknown>>;
	}
	return [];
}

function parseJson(value: string, source: string): unknown {
	try {
		return JSON.parse(value);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid structured findings JSON in ${source}: ${message}`, {
			cause: error,
		});
	}
}

function resolveContainedPath(rootDir: string, candidate: string): string | null {
	const resolved = path.resolve(rootDir, candidate);
	const root = path.resolve(rootDir);
	return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

function tableExists(database: DatabaseSync, tableName: string): boolean {
	return Boolean(
		database
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(tableName),
	);
}

function tableColumns(database: DatabaseSync, tableName: string): Set<string> {
	const rows = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
	return new Set(rows.map((column) => String(column.name ?? '')));
}

function normalizeSegment(value: unknown): string {
	const normalized = String(value ?? '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return normalized || 'unknown';
}
