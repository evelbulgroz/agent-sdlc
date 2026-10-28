import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RUNTIME_STATES, validateRunId } from '../policy/contracts.ts';
import type { SqlParam } from './run-ledger.ts';
import { REPOSITORY_ROOT, liveRunRoot } from './run-paths.ts';

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const KNOWN_STATES: ReadonlySet<string> = new Set<string>([
	...RUNTIME_STATES,
	'ABORTED',
	'WAITING_FOR_SPEC_APPROVAL',
	'RUNNING',
]);
const LANDED_ELIGIBLE_STATES: ReadonlySet<string> = new Set<string>([
	'DONE',
	'READY_FOR_GIT_APPROVAL',
]);

export interface RunRetentionDecision {
	action: 'keep' | 'archive' | 'clean-merged';
	skipped: boolean;
	reason: string;
}

export interface RecordedDagTaskRow {
	task_id: string;
	status: string;
	worktree_subdir: string;
	base_commit_sha: string;
	target_tree_sha: string | null;
}

export interface RecordedRun {
	runId: string;
	runDir: string;
	databasePath: string;
	state: string;
	createdAt: string;
	updatedAt: string;
	approvedSpecHash: string | null;
	baseCommitSha: string | null;
	targetTreeSha: string | null;
	branchName: string | null;
	stateDoc: Record<string, unknown>;
	dagTasks: RecordedDagTaskRow[];
	hasWorktree: boolean;
}

function isValidRunId(runId: string): boolean {
	try {
		validateRunId(runId);
		return true;
	} catch {
		return false;
	}
}

export function decideRunRetention({
	state,
	updatedAt,
	now,
	landed = false,
	hasWorktree = false,
}: {
	state?: string;
	updatedAt?: number | string;
	now?: number | string;
	landed?: boolean | 'unknown';
	hasWorktree?: boolean;
} = {}): Readonly<RunRetentionDecision> {
	if (!state || !KNOWN_STATES.has(state)) {
		return Object.freeze({
			action: 'keep',
			skipped: true,
			reason: 'unknown-state',
		});
	}
	if (LANDED_ELIGIBLE_STATES.has(state) && landed === 'unknown') {
		return Object.freeze({
			action: 'keep',
			skipped: true,
			reason: 'landed-unknown',
		});
	}
	const nowMs = typeof now === 'number' ? now : Date.parse(String(now ?? ''));
	const updatedAtMs =
		typeof updatedAt === 'number' ? updatedAt : Date.parse(String(updatedAt ?? ''));
	if (!Number.isFinite(nowMs) || !Number.isFinite(updatedAtMs)) {
		return Object.freeze({
			action: 'keep',
			skipped: true,
			reason: 'invalid-timestamp',
		});
	}
	if (nowMs - updatedAtMs >= SEVEN_DAYS_MS) {
		return Object.freeze({
			action: 'archive',
			skipped: false,
			reason: 'idle-7d',
		});
	}
	if (LANDED_ELIGIBLE_STATES.has(state) && landed === true && hasWorktree === true) {
		return Object.freeze({
			action: 'clean-merged',
			skipped: false,
			reason: 'landed-on-main',
		});
	}
	return Object.freeze({
		action: 'keep',
		skipped: false,
		reason: 'recent-or-active',
	});
}

export function hasRunWorktrees(runDir: string): boolean {
	const singleWorktree = path.join(runDir, 'worktree');
	if (fs.existsSync(singleWorktree)) return true;
	const multiWorktrees = path.join(runDir, 'worktrees');
	if (!fs.existsSync(multiWorktrees)) return false;
	try {
		const entries = fs.readdirSync(multiWorktrees, { withFileTypes: true });
		return entries.some((entry) => entry.isDirectory() || entry.isSymbolicLink());
	} catch {
		return false;
	}
}

function safeGet<T>(db: DatabaseSync, sql: string, ...params: SqlParam[]): T | null {
	try {
		const raw: unknown = db.prepare(sql).get(...params);
		return (raw as T | undefined) ?? null;
	} catch {
		return null;
	}
}

function safeAll<T>(db: DatabaseSync, sql: string, ...params: SqlParam[]): T[] {
	try {
		const raw: unknown = db.prepare(sql).all(...params);
		return raw as T[];
	} catch {
		return [];
	}
}

export function readRecordedRun(runDir: string, runId: string): Readonly<RecordedRun> | null {
	const databasePath = path.join(runDir, 'runtime.sqlite');
	if (!fs.existsSync(databasePath)) return null;
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(databasePath, { readOnly: true });
		const row = safeGet<{
			run_id: string;
			state: string;
			state_json: string;
			created_at: string;
			updated_at: string;
		}>(
			db,
			'SELECT run_id, state, state_json, created_at, updated_at FROM runs WHERE run_id = ?',
			runId,
		);
		if (!row) return null;
		let stateDoc: {
			authorization?: { approvedSpecHash?: string; baseCommitSha?: string };
			approvedSpecHash?: string;
			baseCommitSha?: string;
			targetTreeSha?: string;
			reconciledTreeSha?: string;
			branchName?: string;
			[key: string]: unknown;
		} = {};
		try {
			stateDoc = (JSON.parse(row.state_json || '{}') ?? {}) as typeof stateDoc;
		} catch {
			stateDoc = {};
		}
		const authRow = safeGet<{ approved_spec_hash: string; base_commit_sha: string }>(
			db,
			'SELECT approved_spec_hash, base_commit_sha FROM run_authorizations WHERE run_id = ?',
			runId,
		);
		const genRow = safeGet<{ base_commit_sha: string; target_tree_sha: string }>(
			db,
			'SELECT base_commit_sha, target_tree_sha FROM generations WHERE run_id = ? ORDER BY generation DESC LIMIT 1',
			runId,
		);
		const recRow = safeGet<{ reconciled_tree_sha: string }>(
			db,
			'SELECT reconciled_tree_sha FROM reconciliations WHERE run_id = ? ORDER BY reconciled_at DESC LIMIT 1',
			runId,
		);
		const commitRow = safeGet<{
			target_branch: string;
			commit_sha: string;
			tree_sha: string;
			parent_sha: string;
		}>(
			db,
			'SELECT target_branch, commit_sha, tree_sha, parent_sha FROM git_commits WHERE run_id = ?',
			runId,
		);
		const dagTasks = safeAll<RecordedDagTaskRow>(
			db,
			'SELECT task_id, status, worktree_subdir, base_commit_sha, target_tree_sha FROM dag_tasks WHERE run_id = ? ORDER BY integration_order ASC',
			runId,
		);
		const approvedSpecHash =
			authRow?.approved_spec_hash ??
			stateDoc?.authorization?.approvedSpecHash ??
			stateDoc?.approvedSpecHash ??
			null;
		const baseCommitSha =
			genRow?.base_commit_sha ??
			authRow?.base_commit_sha ??
			commitRow?.parent_sha ??
			stateDoc?.authorization?.baseCommitSha ??
			stateDoc?.baseCommitSha ??
			null;
		const targetTreeSha =
			commitRow?.tree_sha ??
			commitRow?.commit_sha ??
			recRow?.reconciled_tree_sha ??
			genRow?.target_tree_sha ??
			stateDoc?.targetTreeSha ??
			stateDoc?.reconciledTreeSha ??
			null;
		const branchName = commitRow?.target_branch ?? stateDoc?.branchName ?? null;
		return Object.freeze({
			runId: row.run_id,
			runDir,
			databasePath,
			state: row.state,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			approvedSpecHash,
			baseCommitSha,
			targetTreeSha,
			branchName,
			stateDoc,
			dagTasks,
			hasWorktree: hasRunWorktrees(runDir),
		});
	} catch {
		return null;
	} finally {
		try {
			db?.close();
		} catch {
			// Ignore close errors on read-only inspection.
		}
	}
}

export function listRecordedRuns(rootDir = REPOSITORY_ROOT): Readonly<RecordedRun>[] {
	const root = liveRunRoot(rootDir);
	if (!fs.existsSync(root)) return [];
	const entries = fs
		.readdirSync(root, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() &&
				!entry.isSymbolicLink() &&
				!entry.name.startsWith('.') &&
				entry.name !== 'test-fixtures' &&
				isValidRunId(entry.name),
		)
		.sort((left, right) => left.name.localeCompare(right.name));
	const runs: Readonly<RecordedRun>[] = [];
	for (const entry of entries) {
		const runDir = path.join(root, entry.name);
		const record = readRecordedRun(runDir, entry.name);
		if (record) runs.push(record);
	}
	return runs;
}
