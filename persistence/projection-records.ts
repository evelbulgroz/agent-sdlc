import {
	type RuntimeEvent,
	canonicalJson,
	validateEvent,
	validateRunId,
} from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import type { RunLedger, StoreContext } from './run-ledger.ts';

interface ProjectionOutboxDbRow {
	run_id: string;
	runtime_revision: number;
	projection_revision: number | null;
	reservation_json: string | null;
	projection_event_json: string | null;
	status_json: string | null;
	intent_text: string | null;
	published_at: string | null;
}

interface ContinuationProjectionDbRow {
	runtime_revision: number;
	projection_revision: number;
	status_json: string;
}

export interface ProjectionReservationRecord {
	projectionRevision: number;
	runtimeRevision: number;
	[key: string]: unknown;
}

export interface ProjectionRecord {
	runId: string;
	runtimeRevision: number;
	projectionRevision: number | null;
	reservation: ProjectionReservationRecord | null;
	projectionEvent: RuntimeEvent | null;
	status: Record<string, unknown> | null;
	intent: string | null;
	publishedAt: string | null;
}

export interface PendingProjectionItem {
	runtimeRevision: number;
	projectionRevision: number | null;
}

export interface DurableProjectionRecord {
	runId: string;
	runtimeRevision: number;
	projectionRevision: number;
	status: Record<string, unknown>;
	intent: string;
	publishedAt: string | null;
}

export function createProjectionRecords(ctx: StoreContext, ledger: RunLedger) {
	function queueProjection(runId: string, runtimeRevision: number): void {
		ctx.transaction(() => {
			ctx.database
				.prepare('INSERT OR IGNORE INTO projection_outbox (run_id, runtime_revision) VALUES (?, ?)')
				.run(runId, runtimeRevision);
		});
	}

	function reserveProjection(
		runId: string,
		runtimeRevision: number,
		reservationInput: Record<string, unknown>,
	): ProjectionReservationRecord {
		return ctx.transaction(() => {
			const rawRow: unknown = ctx.database
				.prepare(
					'SELECT projection_revision, reservation_json FROM projection_outbox WHERE run_id = ? AND runtime_revision = ?',
				)
				.get(runId, runtimeRevision);
			const row = rawRow as
				| { projection_revision: number | null; reservation_json: string | null }
				| undefined;
			if (!row) {
				throw new SdlcError('STORE_RECONCILIATION_FAILED', 'Projection outbox entry is missing');
			}
			if (row.reservation_json !== null) {
				return JSON.parse(row.reservation_json) as ProjectionReservationRecord;
			}
			const rawRun: unknown = ctx.database
				.prepare('SELECT projection_revision FROM runs WHERE run_id = ?')
				.get(runId);
			const run = rawRun as { projection_revision: number } | undefined;
			if (!run) {
				throw new SdlcError('STORE_RECONCILIATION_FAILED', 'Projection run is missing');
			}
			const projectionRevision = row.projection_revision ?? run.projection_revision + 1;
			const reservation: ProjectionReservationRecord = {
				...structuredClone(reservationInput),
				projectionRevision,
				runtimeRevision,
			};
			ctx.database
				.prepare('UPDATE runs SET projection_revision = ? WHERE run_id = ?')
				.run(Math.max(run.projection_revision, projectionRevision), runId);
			ctx.database
				.prepare(
					'UPDATE projection_outbox SET projection_revision = ?, reservation_json = ? WHERE run_id = ? AND runtime_revision = ?',
				)
				.run(projectionRevision, canonicalJson(reservation), runId, runtimeRevision);
			return reservation;
		});
	}

	function appendProjectionEvent(
		runId: string,
		runtimeRevision: number,
		eventInput: unknown,
	): string {
		const event = validateEvent(eventInput);
		return ctx.transaction(() => {
			const rawRow: unknown = ctx.database
				.prepare(
					'SELECT reservation_json, projection_event_json FROM projection_outbox WHERE run_id = ? AND runtime_revision = ?',
				)
				.get(runId, runtimeRevision);
			const row = rawRow as
				| { reservation_json: string | null; projection_event_json: string | null }
				| undefined;
			if (!row?.reservation_json) {
				throw new SdlcError(
					'STORE_RECONCILIATION_FAILED',
					'Projection event has no durable reservation',
				);
			}
			if (
				row.projection_event_json !== null &&
				row.projection_event_json !== canonicalJson(event)
			) {
				throw new SdlcError(
					'STORE_RECONCILIATION_FAILED',
					'Projection event diverged from its durable reservation',
				);
			}
			ledger.insertEvent(event);
			if (row.projection_event_json === null) {
				ctx.database
					.prepare(
						'UPDATE projection_outbox SET projection_event_json = ? WHERE run_id = ? AND runtime_revision = ?',
					)
					.run(canonicalJson(event), runId, runtimeRevision);
			}
			return ledger.eventLogHash(runId);
		});
	}

	function saveProjectionPayload(
		runId: string,
		runtimeRevision: number,
		{ status, intent }: { status: unknown; intent: string },
	): { status: Record<string, unknown>; intent: string } {
		return ctx.transaction(() => {
			const rawRow: unknown = ctx.database
				.prepare(
					'SELECT projection_event_json, status_json, intent_text FROM projection_outbox WHERE run_id = ? AND runtime_revision = ?',
				)
				.get(runId, runtimeRevision);
			const row = rawRow as
				| {
						projection_event_json: string | null;
						status_json: string | null;
						intent_text: string | null;
				  }
				| undefined;
			if (!row?.projection_event_json) {
				throw new SdlcError(
					'STORE_RECONCILIATION_FAILED',
					'Projection payload has no durable event',
				);
			}
			const statusJson = canonicalJson(status);
			if (
				(row.status_json !== null && row.status_json !== statusJson) ||
				(row.intent_text !== null && row.intent_text !== intent)
			) {
				throw new SdlcError(
					'STORE_RECONCILIATION_FAILED',
					'Projection payload diverged from its durable reservation',
				);
			}
			if (row.status_json === null) {
				ctx.database
					.prepare(
						'UPDATE projection_outbox SET status_json = ?, intent_text = ? WHERE run_id = ? AND runtime_revision = ?',
					)
					.run(statusJson, intent, runId, runtimeRevision);
			}
			return { status: JSON.parse(statusJson) as Record<string, unknown>, intent };
		});
	}

	function getProjectionRecord(runId: string, runtimeRevision: number): ProjectionRecord | null {
		const raw: unknown = ctx.database
			.prepare('SELECT * FROM projection_outbox WHERE run_id = ? AND runtime_revision = ?')
			.get(runId, runtimeRevision);
		const row = raw as ProjectionOutboxDbRow | undefined;
		if (!row) return null;
		return {
			runId: row.run_id,
			runtimeRevision: row.runtime_revision,
			projectionRevision: row.projection_revision,
			reservation: row.reservation_json
				? (JSON.parse(row.reservation_json) as ProjectionReservationRecord)
				: null,
			projectionEvent: row.projection_event_json
				? (JSON.parse(row.projection_event_json) as RuntimeEvent)
				: null,
			status: row.status_json ? (JSON.parse(row.status_json) as Record<string, unknown>) : null,
			intent: row.intent_text,
			publishedAt: row.published_at,
		};
	}

	function markProjectionPublished(
		runId: string,
		runtimeRevision: number,
		now = new Date(),
	): ProjectionRecord | null {
		return ctx.transaction(() => {
			const current = getProjectionRecord(runId, runtimeRevision);
			if (!current?.status || current.intent === null || !current.projectionEvent) {
				throw new SdlcError(
					'STORE_RECONCILIATION_FAILED',
					'Projection cannot publish without durable materialization',
				);
			}
			ctx.database
				.prepare(
					'UPDATE projection_outbox SET published_at = ? WHERE run_id = ? AND runtime_revision <= ? AND published_at IS NULL',
				)
				.run(now.toISOString(), runId, runtimeRevision);
			return getProjectionRecord(runId, runtimeRevision);
		});
	}

	function listPendingProjections(runId: string): PendingProjectionItem[] {
		const raw: unknown = ctx.database
			.prepare(
				'SELECT runtime_revision, projection_revision FROM projection_outbox WHERE run_id = ? AND published_at IS NULL ORDER BY runtime_revision',
			)
			.all(runId);
		const rows = raw as { runtime_revision: number; projection_revision: number | null }[];
		return rows.map((row) => ({
			runtimeRevision: row.runtime_revision,
			projectionRevision: row.projection_revision,
		}));
	}

	function getProjectionRevision(runId: string): number {
		const raw: unknown = ctx.database
			.prepare('SELECT projection_revision FROM runs WHERE run_id = ?')
			.get(runId);
		const row = raw as { projection_revision: number } | undefined;
		return row?.projection_revision ?? 0;
	}

	function appendContinuationProjection(
		runId: string,
		status: {
			revision?: number;
			orchestration?: { runtimeRevision?: number };
			[key: string]: unknown;
		},
	): Record<string, unknown> {
		return ctx.transaction(() => {
			const revision = status?.revision;
			const runtimeRevision = status?.orchestration?.runtimeRevision;
			if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
				throw new SdlcError('INVALID_CONTRACT', 'Continuation projection revision is invalid');
			}
			if (
				typeof runtimeRevision !== 'number' ||
				!Number.isSafeInteger(runtimeRevision) ||
				runtimeRevision < 0
			) {
				throw new SdlcError(
					'INVALID_CONTRACT',
					'Continuation projection runtime revision is invalid',
				);
			}
			const statusJson = canonicalJson(status);
			const rawExisting: unknown = ctx.database
				.prepare(
					'SELECT status_json FROM continuation_projections WHERE run_id = ? AND projection_revision = ?',
				)
				.get(runId, revision);
			const existing = rawExisting as { status_json: string } | undefined;
			if (existing) {
				if (existing.status_json !== statusJson) {
					throw new SdlcError(
						'STORE_RECONCILIATION_FAILED',
						'Continuation projection diverged from its durable payload',
					);
				}
				return JSON.parse(statusJson) as Record<string, unknown>;
			}
			const collision = ctx.database
				.prepare(
					'SELECT 1 AS present FROM projection_outbox WHERE run_id = ? AND projection_revision = ?',
				)
				.get(runId, revision);
			if (collision) {
				throw new SdlcError(
					'STORE_RECONCILIATION_FAILED',
					'Continuation projection collides with an outbox revision',
				);
			}
			ctx.database
				.prepare(
					'INSERT INTO continuation_projections (run_id, runtime_revision, projection_revision, status_json, created_at) VALUES (?, ?, ?, ?, ?)',
				)
				.run(runId, runtimeRevision, revision, statusJson, new Date().toISOString());
			ctx.database
				.prepare(
					'UPDATE runs SET projection_revision = ? WHERE run_id = ? AND projection_revision < ?',
				)
				.run(revision, runId, revision);
			return JSON.parse(statusJson) as Record<string, unknown>;
		});
	}

	function findContinuationProjection(
		runId: string,
		status: { revision?: number; [key: string]: unknown } | null | undefined,
	): Record<string, unknown> | null {
		if (!status || typeof status.revision !== 'number') return null;
		const raw: unknown = ctx.database
			.prepare(
				'SELECT status_json FROM continuation_projections WHERE run_id = ? AND projection_revision = ?',
			)
			.get(runId, status.revision);
		const row = raw as { status_json: string } | undefined;
		if (!row || row.status_json !== canonicalJson(status)) return null;
		return JSON.parse(row.status_json) as Record<string, unknown>;
	}

	function latestDurableProjection(runId: string): DurableProjectionRecord | null {
		validateRunId(runId);
		ctx.assertOpen();
		const rawOutbox: unknown = ctx.database
			.prepare(
				'SELECT runtime_revision, projection_revision, status_json, intent_text, published_at FROM projection_outbox WHERE run_id = ? AND status_json IS NOT NULL AND intent_text IS NOT NULL ORDER BY projection_revision',
			)
			.all(runId);
		const outboxRows = rawOutbox as {
			runtime_revision: number;
			projection_revision: number;
			status_json: string;
			intent_text: string;
			published_at: string | null;
		}[];
		const rawContinuation: unknown = ctx.database
			.prepare(
				'SELECT runtime_revision, projection_revision, status_json FROM continuation_projections WHERE run_id = ? ORDER BY projection_revision',
			)
			.all(runId);
		const continuationRows = rawContinuation as ContinuationProjectionDbRow[];
		const outboxByRuntime = new Map(outboxRows.map((row) => [row.runtime_revision, row]));
		let best: Omit<DurableProjectionRecord, 'runId'> | null = null;
		const consider = (candidate: Omit<DurableProjectionRecord, 'runId'>): void => {
			if (!Number.isSafeInteger(candidate.projectionRevision)) return;
			if (best && candidate.projectionRevision <= best.projectionRevision) return;
			best = candidate;
		};
		for (const row of outboxRows) {
			consider({
				projectionRevision: row.projection_revision,
				runtimeRevision: row.runtime_revision,
				status: JSON.parse(row.status_json) as Record<string, unknown>,
				intent: row.intent_text,
				publishedAt: row.published_at,
			});
		}
		for (const row of continuationRows) {
			const owner = outboxByRuntime.get(row.runtime_revision);
			if (!owner) {
				throw new SdlcError(
					'STORE_RECONCILIATION_FAILED',
					'Continuation projection has no outbox intent',
				);
			}
			consider({
				projectionRevision: row.projection_revision,
				runtimeRevision: row.runtime_revision,
				status: JSON.parse(row.status_json) as Record<string, unknown>,
				intent: owner.intent_text,
				publishedAt: owner.published_at,
			});
		}
		if (!best) return null;
		const winner: Omit<DurableProjectionRecord, 'runId'> = best;
		return {
			runId,
			runtimeRevision: winner.runtimeRevision,
			projectionRevision: winner.projectionRevision,
			status: winner.status,
			intent: winner.intent,
			publishedAt: winner.publishedAt,
		};
	}

	return {
		queueProjection,
		reserveProjection,
		appendProjectionEvent,
		saveProjectionPayload,
		getProjectionRecord,
		markProjectionPublished,
		listPendingProjections,
		getProjectionRevision,
		appendContinuationProjection,
		findContinuationProjection,
		latestDurableProjection,
	};
}

export type ProjectionRecords = ReturnType<typeof createProjectionRecords>;
