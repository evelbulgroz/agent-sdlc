#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { RuntimeStore } from '../persistence/runtime-store.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { resolveTraceRunDir } from './trace-summary.ts';

export interface InvariantResult {
	name: string;
	ok: boolean;
	detail: string;
}

const TERMINAL_OK = new Set(['READY_FOR_GIT_APPROVAL', 'DONE']);

/** Read-only post-run audit; works on a copy so opening the store cannot alter the run. */
export function checkRunInvariants(databasePath: string, runId: string, rootDir: string): InvariantResult[] {
	const results: InvariantResult[] = [];
	const check = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'invariants-'));
	const copy = path.join(tmp, 'runtime.sqlite');
	try {
		fs.copyFileSync(databasePath, copy);
		const store = new RuntimeStore(copy);
		try {
			let reconciled;
			try {
				reconciled = store.reconcile(runId);
				check('event-hash-chain', true, `${reconciled.transitions.length} transitions chain from persisted state`);
			} catch (error) {
				check('event-hash-chain', false, error instanceof Error ? error.message : String(error));
			}
			const state = reconciled?.state;
			check('terminal-state', Boolean(state && TERMINAL_OK.has(state.state)), `state=${state?.state ?? 'unknown'}`);
			const events = (store.database
				.prepare('SELECT event_type FROM events WHERE run_id = ? ORDER BY rowid').all(runId) as Array<{ event_type: string }>)
				.map((row) => row.event_type);
			const frozen = events.indexOf('PLAN_FROZEN');
			const firstWorktree = events.indexOf('WORKTREE_PREPARED');
			check('plan-frozen-before-worktrees', frozen >= 0 && (firstWorktree < 0 || frozen < firstWorktree),
				`PLAN_FROZEN@${frozen} WORKTREE_PREPARED@${firstWorktree}`);
			const planReview = store.database
				.prepare("SELECT artifact_hash FROM critic_reviews WHERE run_id = ? AND phase = 'plan' ORDER BY generation DESC, rowid DESC LIMIT 1")
				.get(runId) as { artifact_hash: string } | undefined;
			check('plan-critic-reviewed-frozen-plan', Boolean(state?.taskPlanHash) && planReview?.artifact_hash === state?.taskPlanHash,
				`taskPlanHash=${state?.taskPlanHash?.slice(0, 12)} reviewed=${planReview?.artifact_hash?.slice(0, 12)}`);
			const auth = reconciled?.authorization;
			if (auth && state?.targetTreeSha) {
				const changed = execFileSync('git', ['diff', '--name-only', `${auth.baseCommitSha}^{tree}`, state.targetTreeSha],
					{ cwd: rootDir, encoding: 'utf8' }).split('\n').filter(Boolean);
				const outside = changed.filter((file) => !auth.allowedPathPrefixes.some((prefix) => file === prefix || file.startsWith(prefix)));
				check('path-containment', outside.length === 0, outside.length ? `outside: ${outside.join(', ')}` : `${changed.length} changed paths within allowed prefixes`);
				const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim();
				check('canary-not-merged', head === auth.baseCommitSha && !auth.allowedOperations.createLocalCommits && !auth.allowedOperations.merge,
					`host HEAD ${head.slice(0, 12)} base ${auth.baseCommitSha.slice(0, 12)}`);
			} else {
				check('path-containment', false, 'authorization or target tree missing');
			}
		} finally {
			store.database.close();
		}
		const db = new DatabaseSync(copy, { readOnly: true });
		try {
			const open = db.prepare("SELECT count(*) AS n FROM interrupts WHERE run_id = ? AND status = 'pending'").get(runId) as { n: number } | undefined;
			check('no-pending-interrupts', (open?.n ?? 0) === 0, `${open?.n ?? 0} pending`);
		} catch {
			check('no-pending-interrupts', true, 'interrupt status not queryable; skipped');
		} finally {
			db.close();
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
	return results;
}

export function main(args: readonly string[] = process.argv.slice(2)): void {
	const runIndex = args.indexOf('--run');
	const runId = runIndex >= 0 ? args[runIndex + 1] : undefined;
	if (!runId) {
		console.error('usage: run-invariants --run <run-id> [--json]');
		process.exitCode = 64;
		return;
	}
	const databasePath = path.join(resolveTraceRunDir(REPOSITORY_ROOT, runId), 'runtime.sqlite');
	if (!fs.existsSync(databasePath)) {
		console.error(`No runtime store for run ${runId}`);
		process.exitCode = 64;
		return;
	}
	const results = checkRunInvariants(databasePath, runId, REPOSITORY_ROOT);
	console.log(args.includes('--json') ? JSON.stringify(results, null, 2)
		: results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}`).join('\n'));
	process.exitCode = results.every((r) => r.ok) ? 0 : 3;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
