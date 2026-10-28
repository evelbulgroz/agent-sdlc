import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { applyBaselineSchema } from '../../persistence/migrations/baseline-schema.ts';
import {
	REPOSITORY_ROOT,
	archiveRoot,
	liveRunRoot,
} from '../../persistence/run-paths.ts';
import { FakeModelGovernor } from '../../testing/fake-model-governor.mjs';
import { createDetachedWorktree } from '../../workflow/worktrees.ts';
import { runCli } from '../cli.ts';

function git(cwd, args) {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function seedMaintenanceRepo() {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdlc-maint-'));
	git(rootDir, ['init', '-b', 'main']);
	git(rootDir, ['config', 'user.name', 'Test Operator']);
	git(rootDir, ['config', 'user.email', 'test@example.com']);
	fs.writeFileSync(path.join(rootDir, 'file.txt'), 'landed-content\n');
	git(rootDir, ['add', 'file.txt']);
	git(rootDir, ['commit', '-m', 'base']);
	const baseCommitSha = git(rootDir, ['rev-parse', 'HEAD']);

	git(rootDir, ['checkout', '-b', 'landed-branch']);
	fs.writeFileSync(path.join(rootDir, 'file.txt'), 'landed-change\n');
	git(rootDir, ['add', 'file.txt']);
	git(rootDir, ['commit', '-m', 'landed']);
	const landedTreeSha = git(rootDir, ['rev-parse', 'HEAD']);
	git(rootDir, ['checkout', 'main']);
	git(rootDir, ['merge', '--ff-only', 'landed-branch']);

	const nowIso = new Date().toISOString();
	const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
	const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

	function addRun(runId, state, updatedAt, { targetTreeSha = null, withWorktree = false } = {}) {
		const runDir = path.join(liveRunRoot(rootDir), runId);
		fs.mkdirSync(path.join(rootDir, 'docs/specs/runs', runId), { recursive: true });
		fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
		fs.writeFileSync(path.join(runDir, 'artifacts', 'note.txt'), `${runId}\n`);
		const db = new DatabaseSync(path.join(runDir, 'runtime.sqlite'));
		try {
			applyBaselineSchema(db);
			db.prepare(
				`INSERT INTO runs (
					run_id, thread_id, runtime_revision, projection_revision,
					state, state_hash, state_json, semantic_repairs_count, created_at, updated_at
				) VALUES (?, ?, 1, 1, ?, 'hash-1', '{}', 0, ?, ?)`,
			).run(runId, `thread-${runId}`, state, updatedAt, updatedAt);
			if (targetTreeSha) {
				db.prepare(
					`INSERT INTO generations (
						run_id, generation, base_commit_sha, target_tree_sha,
						scope_fingerprints_json, task_owned_paths_json, materialized_at
					) VALUES (?, 1, ?, ?, '{}', '[]', ?)`,
				).run(runId, baseCommitSha, targetTreeSha, updatedAt);
			}
		} finally {
			db.close();
		}
		if (withWorktree) {
			createDetachedWorktree({ runId, baseCommitSha, rootDir });
		}
	}

	addRun('2026-11-08-merged-run', 'DONE', twoDaysAgo, {
		targetTreeSha: landedTreeSha,
		withWorktree: true,
	});
	addRun('2026-11-01-old-failed', 'FAILED', eightDaysAgo);
	addRun('2026-11-09-recent-failed', 'FAILED', nowIso);

	return rootDir;
}

function snapshotTree(dir) {
	if (!fs.existsSync(dir)) return [];
	const entries = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			entries.push(`D:${entry.name}`, ...snapshotTree(full).map((sub) => `${entry.name}/${sub}`));
		} else if (entry.isFile()) {
			entries.push(`F:${entry.name}:${fs.statSync(full).size}`);
		}
	}
	return entries;
}

test('CLI reliability replay is provider-free and canary check reports every exceeded limit', async () => {
	const replay = await runCli(['reliability', 'replay', '--json'], {
		rootDir: REPOSITORY_ROOT,
	});
	assert.equal(replay.exitCode, 0);
	assert.equal(replay.result.status, 'PASSED');
	assert.equal(replay.result.providerOperations, 0);

	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-canary-check-'));
	try {
		const goalFile = path.join(tempDir, 'goal.json');
		const manifestFile = path.join(tempDir, 'tasks.json');
		const { completeSpecJson } = await import('../../testing/cli-test-support.mjs');
		const { pinnedToolsManifest } = await import('../../testing/task-planner-fixtures.mjs');
		fs.writeFileSync(
			goalFile,
			JSON.stringify(
				completeSpecJson({
					touchedSurfaces: [
						'tools/agent-sdlc/a.mjs',
						'tools/agent-sdlc/b.mjs',
						'tools/agent-sdlc/c.mjs',
						'tools/agent-sdlc/d.mjs',
					],
				}),
			),
		);
		const manifest = pinnedToolsManifest();
		manifest.tasks = [
			{
				...manifest.tasks[0],
				taskId: 'task-1',
				authoredPaths: [
					'tools/agent-sdlc/a.mjs',
					'tools/agent-sdlc/b.mjs',
					'tools/agent-sdlc/c.mjs',
					'tools/agent-sdlc/d.mjs',
				],
				pathPrefixes: ['tools/agent-sdlc'],
				dependsOn: [],
			},
			{
				...manifest.tasks[0],
				taskId: 'task-2',
				authoredPaths: ['tools/agent-sdlc/a.mjs'],
				pathPrefixes: ['tools/agent-sdlc'],
				dependsOn: ['task-1'],
			},
		];
		fs.writeFileSync(manifestFile, JSON.stringify(manifest));
		const checked = await runCli(
			[
				'canary',
				'check',
				'--goal-file',
				goalFile,
				'--task-plan-file',
				manifestFile,
				'--json',
			],
			{ rootDir: REPOSITORY_ROOT },
		);
		assert.equal(checked.exitCode, 2);
		assert.equal(checked.result.status, 'CANARY_INELIGIBLE');
		assert.ok(checked.result.violations.length > 1);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-06 @case AC-06.3 canary step is retired before a model call', async () => {
	const governor = new FakeModelGovernor([]);
	const result = await runCli(['canary', 'step', '--role', 'implementer', '--json'], {
		rootDir: REPOSITORY_ROOT,
		governor,
		env: {},
	});
	assert.equal(result.exitCode, 64);
	assert.equal(result.result.error.code, 'INVALID_INPUT');
	assert.match(result.result.error.message, /canary step is retired/);
	assert.equal(governor.calls.length, 0);
});

// @ac AC-06
test('AC-06: prune-runs CLI reports cleaned, archived, kept, and skipped and supports --dry-run', async (t) => {
	// @case AC-06.2
	await t.test('AC-06.2: prune-runs --dry-run --json reports planned actions without modifying any files', async () => {
		const rootDir = seedMaintenanceRepo();
		try {
			const before = snapshotTree(liveRunRoot(rootDir));
			const dryRes = await runCli(['prune-runs', '--dry-run', '--json'], { rootDir });
			const after = snapshotTree(liveRunRoot(rootDir));

			assert.equal(dryRes.exitCode, 0);
			assert.equal(dryRes.result.dryRun, true);
			assert.deepEqual(dryRes.result.cleaned, ['2026-11-08-merged-run']);
			assert.deepEqual(dryRes.result.archived, ['2026-11-01-old-failed']);
			assert.deepEqual(dryRes.result.kept, ['2026-11-09-recent-failed']);
			assert.deepEqual(dryRes.result.skipped, []);
			assert.deepEqual(after, before);
			assert.equal(fs.existsSync(archiveRoot(rootDir)), false);
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});

	// @case AC-06.1
	await t.test('AC-06.1: prune-runs --json executes the sweep and reports cleaned, archived, kept, and skipped', async () => {
		const rootDir = seedMaintenanceRepo();
		try {
			const res = await runCli(['prune-runs', '--json'], { rootDir });
			assert.equal(res.exitCode, 0);
			assert.equal(res.result.dryRun, false);
			assert.deepEqual(res.result.cleaned, ['2026-11-08-merged-run']);
			assert.deepEqual(res.result.archived, ['2026-11-01-old-failed']);
			assert.deepEqual(res.result.kept, ['2026-11-09-recent-failed']);
			assert.deepEqual(res.result.skipped, []);

			assert.equal(
				fs.existsSync(path.join(liveRunRoot(rootDir), '2026-11-08-merged-run', 'worktree')),
				false,
			);
			assert.equal(
				fs.existsSync(path.join(liveRunRoot(rootDir), '2026-11-08-merged-run', 'runtime.sqlite')),
				true,
			);
			assert.equal(
				fs.existsSync(path.join(archiveRoot(rootDir), '2026-11-01-old-failed', 'runtime.sqlite')),
				true,
			);
			assert.equal(
				fs.existsSync(path.join(liveRunRoot(rootDir), '2026-11-01-old-failed')),
				false,
			);
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});
});
