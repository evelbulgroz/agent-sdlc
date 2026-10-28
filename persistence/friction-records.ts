import crypto from 'node:crypto';
import {
	type RuntimeEvent,
	createEvent,
	validateFindingKey,
} from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import type { RunLedger, StoreContext } from './run-ledger.ts';

interface PromptFrictionFindingRow {
	finding_id: string;
	run_id: string;
	role_id: string;
	signal_type: string;
	category: string;
	finding_key: string;
	status: string;
	attribution_layer: string;
	evidence_json: string;
	proposed_diff_json: string | null;
	created_at: string;
	updated_at: string;
}

export interface PromptFrictionFindingInput {
	findingId?: string;
	runId: string;
	roleId: string;
	signalType: string;
	category: string;
	findingKey: string;
	status: string;
	attributionLayer: string;
	evidenceJson?: string;
	evidence?: unknown;
	proposedDiffJson?: string | null;
	proposedDiff?: unknown;
	createdAt?: string;
	updatedAt?: string;
}

export interface PromptFrictionFindingRecord {
	findingId: string;
	runId: string;
	roleId: string;
	signalType: string;
	category: string;
	findingKey: string;
	status: string;
	attributionLayer: string;
	evidenceJson: string;
	evidence: unknown;
	proposedDiffJson: string | null;
	proposedDiff: unknown;
	createdAt: string;
	updatedAt: string;
}

export interface FrictionRecords {
	insertPromptFrictionFinding(
		finding: PromptFrictionFindingInput,
	): Readonly<PromptFrictionFindingRecord> | null;
	getPromptFrictionFinding(
		runId: string,
		findingKey: string,
	): Readonly<PromptFrictionFindingRecord> | null;
	listPromptFrictionFindings(runId: string): Readonly<PromptFrictionFindingRecord>[];
	hasUnreviewedFriction(runId: string): boolean;
	recordFrictionAnalyzed(params: {
		runId: string;
		findings?: Omit<PromptFrictionFindingInput, 'runId'>[];
		now?: string;
	}): {
		findings: (Readonly<PromptFrictionFindingRecord> | null)[];
		event: Readonly<RuntimeEvent>;
	};
}

function mapPromptFrictionFindingRow(
	row: PromptFrictionFindingRow,
): Readonly<PromptFrictionFindingRecord> {
	let proposedDiff: unknown = null;
	if (row.proposed_diff_json) {
		try {
			proposedDiff = JSON.parse(row.proposed_diff_json);
		} catch {
			proposedDiff = row.proposed_diff_json;
		}
	}
	let evidence: unknown = {};
	if (row.evidence_json) {
		try {
			evidence = JSON.parse(row.evidence_json);
		} catch {
			evidence = {};
		}
	}
	return Object.freeze({
		findingId: row.finding_id,
		runId: row.run_id,
		roleId: row.role_id,
		signalType: row.signal_type,
		category: row.category,
		findingKey: row.finding_key,
		status: row.status,
		attributionLayer: row.attribution_layer,
		evidenceJson: row.evidence_json,
		evidence,
		proposedDiffJson: row.proposed_diff_json,
		proposedDiff,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	});
}

export function createFrictionRecords(ctx: StoreContext, ledger: RunLedger): FrictionRecords {
	function insertPromptFrictionFinding(
		finding: PromptFrictionFindingInput,
	): Readonly<PromptFrictionFindingRecord> | null {
		ctx.assertOpen();
		validateFindingKey(finding.findingKey);
		const now = finding.createdAt ?? new Date().toISOString();
		const updated = finding.updatedAt ?? now;
		const findingId = finding.findingId ?? crypto.randomUUID();
		const evidenceJson =
			typeof finding.evidenceJson === 'string'
				? finding.evidenceJson
				: JSON.stringify(finding.evidence ?? {});
		const proposedDiffJson =
			typeof finding.proposedDiffJson === 'string'
				? finding.proposedDiffJson
				: finding.proposedDiff
					? JSON.stringify(finding.proposedDiff)
					: null;

		return ctx.transaction(() => {
			ctx.database
				.prepare(
					`INSERT INTO prompt_friction_findings (
						finding_id, run_id, role_id, signal_type, category, finding_key,
						status, attribution_layer, evidence_json, proposed_diff_json,
						created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(run_id, finding_key) DO UPDATE SET
						role_id = excluded.role_id,
						signal_type = excluded.signal_type,
						category = excluded.category,
						status = excluded.status,
						attribution_layer = excluded.attribution_layer,
						evidence_json = excluded.evidence_json,
						proposed_diff_json = excluded.proposed_diff_json,
						updated_at = excluded.updated_at`,
				)
				.run(
					findingId,
					finding.runId,
					finding.roleId,
					finding.signalType,
					finding.category,
					finding.findingKey,
					finding.status,
					finding.attributionLayer,
					evidenceJson,
					proposedDiffJson,
					now,
					updated,
				);
			return getPromptFrictionFinding(finding.runId, finding.findingKey);
		});
	}

	function getPromptFrictionFinding(
		runId: string,
		findingKey: string,
	): Readonly<PromptFrictionFindingRecord> | null {
		ctx.assertOpen();
		const raw: unknown = ctx.database
			.prepare('SELECT * FROM prompt_friction_findings WHERE run_id = ? AND finding_key = ?')
			.get(runId, findingKey);
		const row = raw as PromptFrictionFindingRow | undefined;
		return row ? mapPromptFrictionFindingRow(row) : null;
	}

	function listPromptFrictionFindings(runId: string): Readonly<PromptFrictionFindingRecord>[] {
		ctx.assertOpen();
		const raw: unknown = ctx.database
			.prepare(
				'SELECT * FROM prompt_friction_findings WHERE run_id = ? ORDER BY created_at ASC',
			)
			.all(runId);
		const rows = raw as PromptFrictionFindingRow[];
		return rows.map(mapPromptFrictionFindingRow);
	}

	function hasUnreviewedFriction(runId: string): boolean {
		ctx.assertOpen();
		const detected = ctx.database
			.prepare(
				"SELECT 1 FROM events WHERE run_id = ? AND event_type = 'PROMPT_FRICTION_DETECTED' LIMIT 1",
			)
			.get(runId);
		if (!detected) return false;
		const analyzed = ctx.database
			.prepare(
				"SELECT 1 FROM events WHERE run_id = ? AND event_type = 'PROMPT_FRICTION_ANALYZED' LIMIT 1",
			)
			.get(runId);
		return !analyzed;
	}

	function recordFrictionAnalyzed({
		runId,
		findings = [],
		now = new Date().toISOString(),
	}: {
		runId: string;
		findings?: Omit<PromptFrictionFindingInput, 'runId'>[];
		now?: string;
	}) {
		ctx.assertOpen();
		return ctx.transaction(() => {
			const rawRun: unknown = ctx.database
				.prepare('SELECT runtime_revision, state FROM runs WHERE run_id = ?')
				.get(runId);
			const run = rawRun as { runtime_revision: number; state: string } | undefined;
			if (!run) {
				throw new SdlcError('RUN_NOT_FOUND', `Run ${runId} not found`, { runId });
			}
			const insertedFindings: (Readonly<PromptFrictionFindingRecord> | null)[] = [];
			for (const finding of findings) {
				insertedFindings.push(
					insertPromptFrictionFinding({
						...finding,
						runId,
						createdAt: finding.createdAt ?? now,
						updatedAt: finding.updatedAt ?? now,
					}),
				);
			}
			const event = createEvent({
				eventType: 'PROMPT_FRICTION_ANALYZED',
				runId,
				runtimeRevision: run.runtime_revision,
				causalId: crypto.randomUUID(),
				payload: { findingsCount: insertedFindings.length },
				now: new Date(now),
			});
			ledger.insertEvent(event);
			return { findings: insertedFindings, event };
		});
	}

	return {
		insertPromptFrictionFinding,
		getPromptFrictionFinding,
		listPromptFrictionFindings,
		hasUnreviewedFriction,
		recordFrictionAnalyzed,
	};
}
