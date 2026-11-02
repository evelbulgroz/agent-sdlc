import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { sha256, validateRunId } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import type { StoreContext } from './run-ledger.ts';

export function applyQualitySchema(database: { exec(sql: string): void }): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS quality_records (
			run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
			kind TEXT NOT NULL, record_id TEXT NOT NULL, content_hash TEXT NOT NULL,
			record_json TEXT NOT NULL, status TEXT,
			PRIMARY KEY(run_id, kind, record_id)
		);
		CREATE TABLE IF NOT EXISTS quality_current_revisions (
			run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
			task_id TEXT NOT NULL, execution_revision INTEGER NOT NULL,
			eligible INTEGER NOT NULL DEFAULT 1,
			PRIMARY KEY(run_id, task_id)
		);
		CREATE TABLE IF NOT EXISTS quality_task_plan_selections (
			run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
			record_id TEXT NOT NULL,
			approved_plan_policy_hash TEXT
		);
		CREATE TABLE IF NOT EXISTS quality_invalidations (
			run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
			kind TEXT NOT NULL, record_id TEXT NOT NULL, correction_id TEXT NOT NULL,
			PRIMARY KEY(run_id, kind, record_id, correction_id)
		);
		CREATE TABLE IF NOT EXISTS quality_budgets (
			run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
			ledger_json TEXT NOT NULL, policy_json TEXT NOT NULL
		);
	`);
}

export function qualityFailure(message: string): never {
	throw new SdlcError('STORE_RECONCILIATION_FAILED', message);
}

export function assertSafeQualityPath(runDir: string, relativePath: string): string {
	if (!relativePath || relativePath.includes('\\') || relativePath.includes('\0') ||
		path.isAbsolute(relativePath) || relativePath.split('/').some(s => !s || s === '.' || s === '..')) {
		qualityFailure('Unsafe quality worktree path');
	}
	const resolved = path.resolve(runDir, relativePath);
	let current = runDir;
	for (const part of relativePath.split('/')) {
		current = path.join(current, part);
		if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
			qualityFailure('Quality worktree path traverses symlink');
		}
	}
	return resolved;
}

const JsonRowSchema = z.object({ record_json: z.string() });

export function createQualityStorage(ctx: StoreContext) {
	function get<T>(runId: string, kind: string, id: string): T | null {
		ctx.assertOpen();
		validateRunId(runId);
		const row = JsonRowSchema.optional().parse(ctx.database.prepare(
			'SELECT * FROM quality_records WHERE run_id=? AND kind=? AND record_id=?',
		).get(runId, kind, id));
		return row ? JSON.parse(row.record_json) as T : null;
	}
	function put<T>(runId: string, kind: string, id: string, record: T): T {
		ctx.assertOpen();
		validateRunId(runId);
		if (!id) qualityFailure('Empty quality record identity');
		return ctx.transaction(() => {
			const hash = sha256(record);
			const existing = get<T>(runId, kind, id);
			if (existing !== null) {
				if (sha256(existing) !== hash) qualityFailure('Quality operation identity has changed contents');
				return existing;
			}
			ctx.database.prepare(`INSERT INTO quality_records
				(run_id,kind,record_id,content_hash,record_json) VALUES (?,?,?,?,?)`)
				.run(runId, kind, id, hash, JSON.stringify(record));
			return record;
		});
	}
	function list<T>(runId: string, kind: string): T[] {
		ctx.assertOpen();
		validateRunId(runId);
		return z.array(JsonRowSchema).parse(ctx.database.prepare(
			'SELECT record_json FROM quality_records WHERE run_id=? AND kind=? ORDER BY record_id',
		).all(runId, kind)).map(row => JSON.parse(row.record_json) as T);
	}
	function status(runId: string, kind: string, id: string, value?: string): string | null {
		if (value !== undefined) {
			const result = ctx.database.prepare(
				'UPDATE quality_records SET status=? WHERE run_id=? AND kind=? AND record_id=?',
			).run(value, runId, kind, id);
			if (result.changes !== 1) qualityFailure('Quality record not found');
		}
		const row = z.object({ status: z.string().nullable() }).optional().parse(ctx.database.prepare(
			'SELECT status FROM quality_records WHERE run_id=? AND kind=? AND record_id=?',
		).get(runId, kind, id));
		return row?.status ?? null;
	}
	function invalidated(runId: string, kind: string, id: string): boolean {
		return !!ctx.database.prepare(
			'SELECT 1 FROM quality_invalidations WHERE run_id=? AND kind=? AND record_id=?',
		).get(runId, kind, id);
	}
	return { ctx, get, put, list, status, invalidated };
}

export type QualityStorage = ReturnType<typeof createQualityStorage>;
