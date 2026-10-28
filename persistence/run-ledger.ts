import {
	type RuntimeEvent,
	type RuntimeState,
	canonicalJson,
	sha256,
	validateEvent,
	validateRuntimeState,
} from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';

export type SqlParam = null | number | bigint | string | NodeJS.ArrayBufferView;

export interface SqlStatement {
	get(...params: SqlParam[]): Record<string, unknown> | undefined;
	all(...params: SqlParam[]): Record<string, unknown>[];
	run(...params: SqlParam[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

export interface StoreDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqlStatement;
}

export interface StoreContext {
	readonly database: StoreDatabase;
	readonly transaction: <T>(operation: () => T) => T;
	readonly assertOpen: () => void;
}

export interface ArtifactInput {
	hash: string;
	type: string;
	mediaType: string;
	byteLength: number;
	storagePath: string;
	redactionStatus: string;
}

export interface ArtifactRecord extends ArtifactInput {
	createdAt: string;
}

interface RunRow {
	run_id: string;
	thread_id: string;
	runtime_revision: number;
	projection_revision: number;
	state: string;
	state_hash: string;
	state_json: string;
	semantic_repairs_count: number | null;
	created_at: string;
	updated_at: string;
}

interface ArtifactRow {
	hash: string;
	type: string;
	media_type: string;
	byte_length: number;
	storage_path: string;
	redaction_status: string;
	created_at: string;
}

export interface RunLedger {
	getRun(runId: string): Readonly<RuntimeState>;
	hasRun(runId: string): boolean;
	insertEvent(event: RuntimeEvent): void;
	getEvent(eventId: string): RuntimeEvent | null;
	listEvents(runId: string): RuntimeEvent[];
	appendEvent(eventInput: unknown): Readonly<RuntimeEvent>;
	recordEvent(eventInput: unknown): Readonly<RuntimeEvent>;
	eventLogHash(runId: string): string;
	registerArtifact(artifact: ArtifactInput): ArtifactRecord;
	getArtifact(hash: string): ArtifactRecord | null;
	incrementSemanticRepairs(runId: string): number;
	getSemanticRepairsCount(runId: string): number;
	insertRun(state: RuntimeState): void;
	updateRunRow(
		nextState: RuntimeState,
		nextHash: string,
		semanticRepairsCount: number,
		expectedRevision: number,
	): { changes: number | bigint; lastInsertRowid: number | bigint };
}

export function createRunLedger(ctx: StoreContext): RunLedger {
	function getRun(runId: string): Readonly<RuntimeState> {
		ctx.assertOpen();
		const rawRow: unknown = ctx.database.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
		const row = rawRow as RunRow | undefined;
		if (!row) throw new SdlcError('RUN_NOT_FOUND', `Run '${runId}' was not found`);
		try {
			const state = validateRuntimeState(JSON.parse(row.state_json));
			if (
				row.run_id !== state.runId ||
				row.thread_id !== state.threadId ||
				row.runtime_revision !== state.runtimeRevision ||
				row.state !== state.state ||
				row.state_hash !== sha256(state) ||
				row.created_at !== state.createdAt ||
				row.updated_at !== state.updatedAt ||
				(state.semanticRepairsCount !== undefined &&
					row.semantic_repairs_count !== state.semanticRepairsCount)
			) {
				throw new SdlcError(
					'STORE_RECONCILIATION_FAILED',
					`Run '${runId}' columns and canonical state diverged`,
				);
			}

			return state;
		} catch (error: unknown) {
			if (error instanceof SdlcError) throw error;
			throw new SdlcError(
				'STORE_CORRUPT',
				`Run '${runId}' contains invalid state`,
				{},
				{
					cause: error,
				},
			);
		}
	}

	function hasRun(runId: string): boolean {
		ctx.assertOpen();
		return Boolean(ctx.database.prepare('SELECT 1 FROM runs WHERE run_id = ?').get(runId));
	}

	function insertEvent(event: RuntimeEvent): void {
		ctx.transaction(() => {
			const existing = getEvent(event.eventId);
			if (existing) {
				if (canonicalJson(existing) !== canonicalJson(event)) {
					throw new SdlcError('STORE_RECONCILIATION_FAILED', 'Event ID collision detected');
				}
				return;
			}
			ctx.database
				.prepare(
					`
					INSERT INTO events (
						event_id, run_id, runtime_revision, event_type, event_json, created_at
					) VALUES (?, ?, ?, ?, ?, ?)
				`,
				)
				.run(
					event.eventId,
					event.runId,
					event.runtimeRevision,
					event.eventType,
					canonicalJson(event),
					event.timestamp,
				);
		});
	}

	function getEvent(eventId: string): RuntimeEvent | null {
		const rawRow: unknown = ctx.database
			.prepare('SELECT event_json FROM events WHERE event_id = ?')
			.get(eventId);
		const row = rawRow as { event_json: string } | undefined;
		return row ? (JSON.parse(row.event_json) as RuntimeEvent) : null;
	}

	function listEvents(runId: string): RuntimeEvent[] {
		const rawRows: unknown = ctx.database
			.prepare('SELECT event_json FROM events WHERE run_id = ? ORDER BY runtime_revision, rowid')
			.all(runId);
		const rows = rawRows as { event_json: string }[];
		return rows.map((row) => JSON.parse(row.event_json) as RuntimeEvent);
	}

	function appendEvent(eventInput: unknown): Readonly<RuntimeEvent> {
		const event = validateEvent(eventInput);
		return ctx.transaction(() => {
			insertEvent(event);
			return event;
		});
	}

	function recordEvent(eventInput: unknown): Readonly<RuntimeEvent> {
		return appendEvent(eventInput);
	}

	function eventLogHash(runId: string): string {
		return sha256(listEvents(runId));
	}

	function registerArtifact(artifact: ArtifactInput): ArtifactRecord {
		return ctx.transaction(() => {
			const now = new Date().toISOString();
			const existing = getArtifact(artifact.hash);
			if (existing) {
				if (
					existing.byteLength !== artifact.byteLength ||
					existing.storagePath !== artifact.storagePath ||
					existing.mediaType !== artifact.mediaType
				) {
					throw new SdlcError('ARTIFACT_CORRUPT', `Artifact metadata mismatch for ${artifact.hash}`);
				}
				return existing;
			}
			ctx.database
				.prepare(
					`
					INSERT INTO artifacts (
						hash, type, media_type, byte_length, storage_path, redaction_status, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?)
				`,
				)
				.run(
					artifact.hash,
					artifact.type,
					artifact.mediaType,
					artifact.byteLength,
					artifact.storagePath,
					artifact.redactionStatus,
					now,
				);
			return { ...artifact, createdAt: now };
		});
	}

	function getArtifact(hash: string): ArtifactRecord | null {
		const rawRow: unknown = ctx.database.prepare('SELECT * FROM artifacts WHERE hash = ?').get(hash);
		const row = rawRow as ArtifactRow | undefined;
		if (!row) return null;
		return {
			hash: row.hash,
			type: row.type,
			mediaType: row.media_type,
			byteLength: row.byte_length,
			storagePath: row.storage_path,
			redactionStatus: row.redaction_status,
			createdAt: row.created_at,
		};
	}

	function incrementSemanticRepairs(runId: string): number {
		ctx.assertOpen();
		return ctx.transaction(() => {
			const rawRow: unknown = ctx.database
				.prepare('SELECT state_json, semantic_repairs_count FROM runs WHERE run_id = ?')
				.get(runId);
			const row = rawRow as
				| { state_json: string; semantic_repairs_count: number | null }
				| undefined;
			if (!row) throw new SdlcError('RUN_NOT_FOUND', `Run '${runId}' was not found`);
			const newCount = (row.semantic_repairs_count ?? 0) + 1;
			const state = JSON.parse(row.state_json) as Record<string, unknown>;
			state.semanticRepairsCount = newCount;
			const nextHash = sha256(state);
			ctx.database
				.prepare(
					'UPDATE runs SET semantic_repairs_count = ?, state_hash = ?, state_json = ? WHERE run_id = ?',
				)
				.run(newCount, nextHash, canonicalJson(state), runId);
			return newCount;
		});
	}

	function getSemanticRepairsCount(runId: string): number {
		ctx.assertOpen();
		const rawRow: unknown = ctx.database
			.prepare('SELECT semantic_repairs_count FROM runs WHERE run_id = ?')
			.get(runId);
		const row = rawRow as { semantic_repairs_count: number | null } | undefined;
		return row?.semantic_repairs_count ?? 0;
	}

	function insertRun(state: RuntimeState): void {
		ctx.transaction(() => {
			ctx.database
				.prepare(
					`
					INSERT INTO runs (
						run_id, thread_id, runtime_revision, state, state_hash,
						state_json, semantic_repairs_count, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				`,
				)
				.run(
					state.runId,
					state.threadId,
					state.runtimeRevision,
					state.state,
					sha256(state),
					canonicalJson(state),
					state.semanticRepairsCount ?? 0,
					state.createdAt,
					state.updatedAt,
				);
		});
	}

	function updateRunRow(
		nextState: RuntimeState,
		nextHash: string,
		semanticRepairsCount: number,
		expectedRevision: number,
	): { changes: number | bigint; lastInsertRowid: number | bigint } {
		return ctx.transaction(() =>
			ctx.database
				.prepare(
					`
					UPDATE runs SET
						runtime_revision = ?, state = ?, state_hash = ?, state_json = ?,
						semantic_repairs_count = ?, updated_at = ?
					WHERE run_id = ? AND runtime_revision = ?
				`,
				)
				.run(
					nextState.runtimeRevision,
					nextState.state,
					nextHash,
					canonicalJson(nextState),
					semanticRepairsCount,
					nextState.updatedAt,
					nextState.runId,
					expectedRevision,
				),
		);
	}

	return {
		getRun,
		hasRun,
		insertEvent,
		getEvent,
		listEvents,
		appendEvent,
		recordEvent,
		eventLogHash,
		registerArtifact,
		getArtifact,
		incrementSemanticRepairs,
		getSemanticRepairsCount,
		insertRun,
		updateRunRow,
	};
}
