import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { withLockSync } from '@fitness-app/model-usage/atomic-file-state';
import { createDetachedWorktree } from '../workflow/worktrees.ts';
import { applyBaselineSchema } from './migrations/baseline-schema.ts';
import { sweepRuns } from './run-archive.ts';
import { archiveRoot, liveRunRoot } from './run-paths.ts';

const FIXED_NOW = '2026-11-10T00:00:00Z';
const EIGHT_DAYS_AGO = '2026-11-02T00:00:00Z';

function git(cwd, args) {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function initRepo() {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdlc-archive-'));
	git(rootDir, ['init', '-b', 'main']);
	git(rootDir, ['config', 'user.name', 'Test Operator']);
	git(rootDir, ['config', 'user.email', 'test@example.com']);
	fs.writeFileSync(path.join(rootDir, 'file-a.txt'), 'original-a\n');
	fs.writeFileSync(path.join(rootDir, 'file-b.txt'), 'original-b\n');
	git(rootDir, ['add', '.']);
	git(rootDir, ['commit', '-m', 'initial']);
	const baseCommitSha = git(rootDir, ['rev-parse', 'HEAD']);
	return { rootDir, baseCommitSha };
}

function createRunFixture(
	rootDir,
	{
		runId,
		state = 'DONE',
		updatedAt = EIGHT_DAYS_AGO,
		baseCommitSha = null,
		targetTreeSha = null,
		dagTasks = [],
		artifacts = { 'spec.json': '{"title":"test"}\n' },
		ledgerEnvelope = null,
	},
) {
	const runDir = path.join(liveRunRoot(rootDir), runId);
	fs.mkdirSync(path.join(rootDir, 'docs/specs/runs', runId), { recursive: true });
	fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
	for (const [name, content] of Object.entries(artifacts)) {
		fs.writeFileSync(path.join(runDir, 'artifacts', name), content, 'utf8');
	}

	const db = new DatabaseSync(path.join(runDir, 'runtime.sqlite'));
	try {
		applyBaselineSchema(db);
		db.prepare(
			`INSERT INTO runs (
				run_id, thread_id, runtime_revision, projection_revision,
				state, state_hash, state_json, semantic_repairs_count, created_at, updated_at
			) VALUES (?, ?, 1, 1, ?, 'hash-1', '{}', 0, ?, ?)`,
		).run(runId, `thread-${runId}`, state, updatedAt, updatedAt);
		db.prepare(
			`INSERT INTO events (event_id, run_id, runtime_revision, event_type, event_json, created_at)
			 VALUES ('evt-1', ?, 1, 'RUN_INITIALIZED', '{}', ?)`,
		).run(runId, updatedAt);
		if (baseCommitSha) {
			db.prepare(
				`INSERT INTO run_authorizations (
					run_id, approved_spec_hash, task_manifest_hash, approved_plan_policy_hash,
					repository_id, base_commit_sha, allowed_packages_json, allowed_path_prefixes_json,
					allowed_operations_json, max_semantic_repairs, model_usage_profile,
					expires_at, approved_at, approval_method, created_at
				) VALUES (?, 'spec-hash-123', NULL, 'policy-hash-123', 'fitness-app', ?, '[]', '[]', '[]', 2, 'default', ?, ?, 'operator', ?)`,
			).run(runId, baseCommitSha, updatedAt, updatedAt, updatedAt);
		}
		if (baseCommitSha && targetTreeSha) {
			db.prepare(
				`INSERT INTO generations (
					run_id, generation, base_commit_sha, target_tree_sha,
					scope_fingerprints_json, task_owned_paths_json, materialized_at
				) VALUES (?, 1, ?, ?, '{}', '[]', ?)`,
			).run(runId, baseCommitSha, targetTreeSha, updatedAt);
		}
		for (let index = 0; index < dagTasks.length; index += 1) {
			const task = dagTasks[index];
			db.prepare(
				`INSERT INTO dag_tasks (
					task_id, run_id, title, target_package, path_prefixes_json, depends_on_json,
					status, integration_order, worktree_subdir, base_commit_sha, target_tree_sha
				) VALUES (?, ?, ?, 'root', '[]', '[]', ?, ?, ?, ?, ?)`,
			).run(
				task.taskId,
				runId,
				task.title ?? task.taskId,
				task.status ?? 'COMPLETED',
				index,
				`worktrees/${task.taskId}`,
				task.baseCommitSha ?? baseCommitSha ?? '0000000',
				task.targetTreeSha ?? null,
			);
		}
		db.prepare(
			`INSERT INTO checkpoints (
				thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
				checkpoint_type, checkpoint, metadata_type, metadata
			) VALUES (?, '', 'cp-1', NULL, 'json', ?, 'json', ?)`,
		).run(`thread-${runId}`, Buffer.alloc(16384, 1), Buffer.from('{}'));
	} finally {
		db.close();
	}

	if (ledgerEnvelope) {
		const ledgerDir = path.join(rootDir, 'tools/.model-usage/runs');
		fs.mkdirSync(ledgerDir, { recursive: true });
		fs.writeFileSync(path.join(ledgerDir, `${runId}.json`), JSON.stringify(ledgerEnvelope), 'utf8');
	}
	return runDir;
}

function buildAttempt({ id, attId, resId, opId, profile, prompt, completion, cost, usageSource, tokenDetails }) {
	const charge = {
		promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion,
		physicalCalls: 1, costMicrousd: cost, premiumRequestUnits: 1,
	};
	return {
		id, usageRecordId: `usage-${attId}`, reservationId: resId, attemptId: attId, operationId: opId,
		routeId: 'openai-gpt-5', provider: 'openai', model: 'gpt-5', canonicalVendor: 'openai',
		routeClass: 'standard', consumer: 'agent-sdlc', profile, retryIndex: 0, failoverIndex: 0,
		startedAt: '2026-11-02T00:00:00.000Z', completedAt: '2026-11-02T00:00:01.000Z', durationMs: 100,
		outcome: 'succeeded', reservationCharge: charge, estimator: { name: 'char-div-4', version: '1.0.0' },
		executionProvenFalse: false, charge, usageSource, pricingVersion: '1.0.0',
		runLimitSnapshot: { maxTotalTokens: 100000, maxPhysicalCalls: 50, maxCostMicrousd: 500000, maxPremiumRequestUnits: 50 },
		remainingRunBudget: { totalTokens: 99000, physicalCalls: 47, costMicrousd: 498500, premiumRequestUnits: 47 },
		...(tokenDetails ? { tokenDetails } : {}),
	};
}

function buildValidLedgerEnvelope(runId) {
	const inputHash = 'a'.repeat(64);
	const route = { routeId: 'openai-gpt-5', provider: 'openai', model: 'gpt-5', canonicalVendor: 'openai' };
	const baseOp = {
		inputHash, state: 'succeeded', consumer: 'agent-sdlc', ownerToken: 'tok-1', ownerPid: 1234,
		firstReservedAt: '2026-11-02T00:00:00.000Z', operationDeadlineAt: '2026-11-02T00:10:00.000Z',
		route, output: { ok: true },
	};
	return {
		schemaVersion: '1.2.0', runId, policyVersion: '1.0.0', pricingVersion: '1.0.0',
		createdAt: '2026-11-02T00:00:00.000Z', runDeadlineAt: '2026-11-02T01:00:00.000Z',
		operations: {
			'op-impl': { ...baseOp, profile: 'implementer', attribution: { roleId: 'implementer', phase: 'implement' }, usageRecordIds: ['usage-att-1', 'usage-att-2'] },
			'op-qa': { ...baseOp, profile: 'critic-review', attribution: { roleId: 'qa-critic', phase: 'qa' }, usageRecordIds: ['usage-att-3'] },
		},
		reservations: [],
		attempts: [
			buildAttempt({ id: 'rec-1', attId: 'att-1', resId: 'res-1', opId: 'op-impl', profile: 'implementer', prompt: 100, completion: 50, cost: 500, usageSource: 'provider', tokenDetails: { cacheReadTokens: 0, cacheWriteTokens: null, reasoningTokens: 25 } }),
			buildAttempt({ id: 'rec-2', attId: 'att-2', resId: 'res-2', opId: 'op-impl', profile: 'implementer', prompt: 200, completion: 80, cost: 700, usageSource: 'estimated' }),
			buildAttempt({ id: 'rec-3', attId: 'att-3', resId: 'res-3', opId: 'op-qa', profile: 'critic-review', prompt: 50, completion: 20, cost: 300, usageSource: 'provider', tokenDetails: { cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null } }),
		],
	};
}

// @ac AC-04
test('AC-04: archiveRun compacts database, copies artifacts and ledger, writes unlanded.patch, and appends index.jsonl', async (t) => {
	// @case AC-04.3
	// @case AC-04.6
	await t.test('AC-04.3 & AC-04.6: archives landed run with artifacts, ledger.json, and totals in index.jsonl', () => {
		const { rootDir, baseCommitSha } = initRepo();
		try {
			git(rootDir, ['checkout', '-b', 'landed-branch']);
			fs.writeFileSync(path.join(rootDir, 'file-a.txt'), 'landed-a\n');
			git(rootDir, ['add', 'file-a.txt']);
			git(rootDir, ['commit', '-m', 'landed commit']);
			const targetTreeSha = git(rootDir, ['rev-parse', 'HEAD']);
			git(rootDir, ['checkout', 'main']);
			git(rootDir, ['merge', '--ff-only', 'landed-branch']);

			const runId = '2026-11-02-landed-archive';
			createRunFixture(rootDir, {
				runId,
				state: 'DONE',
				updatedAt: EIGHT_DAYS_AGO,
				baseCommitSha,
				targetTreeSha,
				artifacts: { 'a.json': '{"a":1}\n', 'b.txt': 'hello\n' },
				ledgerEnvelope: buildValidLedgerEnvelope(runId),
			});

			const result = sweepRuns({ rootDir, now: FIXED_NOW });
			assert.deepEqual(result.archived, [runId]);
			assert.equal(fs.existsSync(path.join(liveRunRoot(rootDir), runId)), false);

			const archivedDir = path.join(archiveRoot(rootDir), runId);
			assert.equal(fs.existsSync(path.join(archivedDir, 'runtime.sqlite')), true);
			assert.equal(fs.existsSync(path.join(archivedDir, 'artifacts', 'a.json')), true);
			assert.equal(fs.existsSync(path.join(archivedDir, 'artifacts', 'b.txt')), true);
			assert.equal(fs.existsSync(path.join(archivedDir, 'ledger.json')), true);

			const entry = JSON.parse(fs.readFileSync(path.join(archiveRoot(rootDir), 'index.jsonl'), 'utf8').trim());
			assert.equal(entry.runId, runId);
			assert.equal(entry.landed, true);
			assert.equal(entry.approvedSpecHash, 'spec-hash-123');
			assert.deepEqual(entry.totals.byRole.implementer, {
				provider: { calls: 1, promptTokens: 100, completionTokens: 50, totalTokens: 150, costMicrousd: 500 },
				estimated: { calls: 1, promptTokens: 200, completionTokens: 80, totalTokens: 280, costMicrousd: 700 },
				tokenDetails: { cacheReadTokens: 0, cacheWriteTokens: null, reasoningTokens: 25 },
			});
			assert.deepEqual(entry.totals.byRole['qa-critic'].tokenDetails, {
				cacheReadTokens: null,
				cacheWriteTokens: null,
				reasoningTokens: null,
			});
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	// @case AC-04.4
	await t.test('AC-04.4: unlanded single-worktree run writes unlanded.patch that applies cleanly to baseCommitSha', () => {
		const { rootDir, baseCommitSha } = initRepo();
		try {
			const runId = '2026-11-02-unlanded-single';
			createRunFixture(rootDir, { runId, state: 'READY_FOR_GIT_APPROVAL', updatedAt: EIGHT_DAYS_AGO, baseCommitSha });
			const wt = createDetachedWorktree({ runId, baseCommitSha, rootDir });
			fs.writeFileSync(path.join(wt.worktreeDir, 'file-a.txt'), 'modified-by-single-run\n');
			fs.writeFileSync(path.join(wt.worktreeDir, 'new-file.txt'), 'brand-new\n');
			git(wt.worktreeDir, ['add', '.']);
			git(wt.worktreeDir, ['commit', '-m', 'single task work']);

			const result = sweepRuns({ rootDir, now: FIXED_NOW });
			assert.deepEqual(result.archived, [runId]);
			const patchPath = path.join(archiveRoot(rootDir), runId, 'unlanded.patch');
			assert.ok(fs.statSync(patchPath).size > 0);
			git(rootDir, ['apply', '--check', patchPath]);
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	// @case AC-04.5
	await t.test('AC-04.5: unlanded multi-task run without integration worktree writes combined unlanded.patch in task-id order', () => {
		const { rootDir, baseCommitSha } = initRepo();
		try {
			const runId = '2026-11-02-unlanded-multi';
			const runDir = createRunFixture(rootDir, {
				runId,
				state: 'READY_FOR_GIT_APPROVAL',
				updatedAt: EIGHT_DAYS_AGO,
				baseCommitSha,
				dagTasks: [
					{ taskId: 'task-1', status: 'COMPLETED', baseCommitSha },
					{ taskId: 'task-2', status: 'COMPLETED', baseCommitSha },
				],
			});
			const wt1 = createDetachedWorktree({
				runId,
				baseCommitSha,
				rootDir,
				worktreeDir: path.join(runDir, 'worktrees', 'task-1'),
			});
			fs.writeFileSync(path.join(wt1.worktreeDir, 'file-a.txt'), 'task-1-change\n');
			git(wt1.worktreeDir, ['add', '.']);
			git(wt1.worktreeDir, ['commit', '-m', 'task 1']);

			const wt2 = createDetachedWorktree({
				runId,
				baseCommitSha,
				rootDir,
				worktreeDir: path.join(runDir, 'worktrees', 'task-2'),
			});
			fs.writeFileSync(path.join(wt2.worktreeDir, 'file-b.txt'), 'task-2-change\n');
			git(wt2.worktreeDir, ['add', '.']);
			git(wt2.worktreeDir, ['commit', '-m', 'task 2']);

			const result = sweepRuns({ rootDir, now: FIXED_NOW });
			assert.deepEqual(result.archived, [runId]);
			const patchContent = fs.readFileSync(path.join(archiveRoot(rootDir), runId, 'unlanded.patch'), 'utf8');
			assert.ok(patchContent.indexOf('# task: task-1') < patchContent.indexOf('# task: task-2'));
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});
});

// @ac AC-05
test('AC-05: sweepRuns enforces atomic staging, crash recovery, unlanded.patch guard, and sweep.lock', async (t) => {
	// @case AC-05.1
	await t.test('AC-05.1: injected compaction failure leaves live run untouched, removes .partial, and reports skipped', () => {
		const { rootDir, baseCommitSha } = initRepo();
		try {
			const runId = '2026-11-02-compaction-fail';
			const runDir = createRunFixture(rootDir, { runId, state: 'FAILED', updatedAt: EIGHT_DAYS_AGO, baseCommitSha });
			const result = sweepRuns({
				rootDir,
				now: FIXED_NOW,
				beforeVerify(compactedPath) {
					const db = new DatabaseSync(compactedPath);
					try {
						db.exec('DELETE FROM events');
					} finally {
						db.close();
					}
				},
			});
			assert.deepEqual(result.skipped, [runId]);
			assert.equal(fs.existsSync(path.join(runDir, 'runtime.sqlite')), true);
			assert.equal(fs.existsSync(path.join(archiveRoot(rootDir), `${runId}.partial`)), false);
			assert.equal(fs.existsSync(path.join(archiveRoot(rootDir), runId)), false);
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	// @case AC-05.2
	await t.test('AC-05.2: leftover .partial directory from a crashed sweep is removed and run is archived cleanly', () => {
		const { rootDir, baseCommitSha } = initRepo();
		try {
			const runId = '2026-11-02-leftover-partial';
			createRunFixture(rootDir, { runId, state: 'FAILED', updatedAt: EIGHT_DAYS_AGO, baseCommitSha });
			const leftoverPartial = path.join(archiveRoot(rootDir), `${runId}.partial`);
			fs.mkdirSync(leftoverPartial, { recursive: true });
			fs.writeFileSync(path.join(leftoverPartial, 'corrupt.txt'), 'leftover');

			const result = sweepRuns({ rootDir, now: FIXED_NOW });
			assert.deepEqual(result.archived, [runId]);
			assert.equal(fs.existsSync(leftoverPartial), false);
			assert.equal(fs.existsSync(path.join(archiveRoot(rootDir), runId, 'runtime.sqlite')), true);
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	// @case AC-05.3
	await t.test('AC-05.3: half-finished rename recovery removes live folder without duplicating index.jsonl', () => {
		const { rootDir, baseCommitSha } = initRepo();
		try {
			const runId = '2026-11-02-half-finished';
			const runDir = createRunFixture(rootDir, { runId, state: 'FAILED', updatedAt: EIGHT_DAYS_AGO, baseCommitSha });
			sweepRuns({
				rootDir,
				now: FIXED_NOW,
				afterRenameBeforeCleanup() {
					throw new Error('simulated crash after rename before live removal');
				},
			});
			assert.equal(fs.existsSync(runDir), true);

			sweepRuns({ rootDir, now: FIXED_NOW });
			assert.equal(fs.existsSync(runDir), false);
			const lines = fs.readFileSync(path.join(archiveRoot(rootDir), 'index.jsonl'), 'utf8').trim().split('\n');
			assert.equal(lines.length, 1);
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	// @case AC-05.4
	await t.test('AC-05.4: failed unlanded.patch leaves live folder and worktree untouched and reports skipped', () => {
		const { rootDir, baseCommitSha } = initRepo();
		try {
			const runId = '2026-11-02-patch-fail';
			const runDir = createRunFixture(rootDir, { runId, state: 'READY_FOR_GIT_APPROVAL', updatedAt: EIGHT_DAYS_AGO, baseCommitSha });
			const wt = createDetachedWorktree({ runId, baseCommitSha, rootDir });

			const result = sweepRuns({ rootDir, now: FIXED_NOW });
			assert.deepEqual(result.skipped, [runId]);
			assert.equal(fs.existsSync(wt.worktreeDir), true);
			assert.equal(fs.existsSync(path.join(runDir, 'runtime.sqlite')), true);
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	// @case AC-05.5
	await t.test('AC-05.5: when sweep.lock is held, sweepRuns returns locked=true and skipped without modifying any run', () => {
		const { rootDir, baseCommitSha } = initRepo();
		try {
			const runId = '2026-11-02-locked-run';
			const runDir = createRunFixture(rootDir, { runId, state: 'FAILED', updatedAt: EIGHT_DAYS_AGO, baseCommitSha });
			const lockDir = archiveRoot(rootDir);
			fs.mkdirSync(lockDir, { recursive: true });
			withLockSync(
				path.join(lockDir, 'sweep.lock'),
				() => {
					const result = sweepRuns({ rootDir, now: FIXED_NOW });
					assert.equal(result.locked, true);
					assert.deepEqual(result.skipped, ['sweep.lock']);
					assert.equal(fs.existsSync(path.join(runDir, 'runtime.sqlite')), true);
				},
				{ timeoutMs: 0 },
			);
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});
});

test('@ac AC-03 @case AC-03.2 sweepRuns on an 8-day-old co-located run copies status.json and intent.md into .archive/<runId> alongside runtime.sqlite before deleting the live run directory', () => {
	const { rootDir, baseCommitSha } = initRepo();
	try {
		const profilePath = path.join(rootDir, '.agents/sdlc-host.json');
		fs.mkdirSync(path.dirname(profilePath), { recursive: true });
		fs.writeFileSync(
			profilePath,
			JSON.stringify(
				{
					schemaVersion: '1.3.0',
					profileId: 'colocated-archive-client',
					repositoryId: 'colocated-archive-client',
					adapter: 'script',
					hydration: [['pnpm', 'install']],
					commands: [['pnpm', 'test']],
					workspace: { directories: ['.'] },
					verify: {
						argv: ['pnpm', 'run', 'verify', '--', '{baseSha}'],
						resultPath: '.agent-sdlc/verify.json',
						require: { status: 'OK', canonical: true },
						headField: 'gitHeadSha',
					},
				},
				null,
				2,
			),
			'utf8',
		);

		const runId = '2026-11-02-colocated-archive';
		const runDir = createRunFixture(rootDir, {
			runId,
			state: 'FAILED',
			updatedAt: EIGHT_DAYS_AGO,
			baseCommitSha,
		});
		fs.writeFileSync(path.join(runDir, 'status.json'), '{"state":"FAILED"}\n', 'utf8');
		fs.writeFileSync(path.join(runDir, 'intent.md'), '# Intent\n', 'utf8');
		fs.writeFileSync(path.join(runDir, 'decisions.md'), '# Decisions\n', 'utf8');
		fs.writeFileSync(path.join(runDir, 'plan.md'), '# Plan\n', 'utf8');

		const result = sweepRuns({ rootDir, now: FIXED_NOW });
		assert.deepEqual(result.archived, [runId]);
		assert.equal(fs.existsSync(runDir), false);

		const archivedDir = path.join(archiveRoot(rootDir), runId);
		assert.equal(fs.existsSync(path.join(archivedDir, 'runtime.sqlite')), true);
		assert.equal(fs.readFileSync(path.join(archivedDir, 'status.json'), 'utf8'), '{"state":"FAILED"}\n');
		assert.equal(fs.readFileSync(path.join(archivedDir, 'intent.md'), 'utf8'), '# Intent\n');
		assert.equal(fs.readFileSync(path.join(archivedDir, 'decisions.md'), 'utf8'), '# Decisions\n');
		assert.equal(fs.readFileSync(path.join(archivedDir, 'plan.md'), 'utf8'), '# Plan\n');
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});
