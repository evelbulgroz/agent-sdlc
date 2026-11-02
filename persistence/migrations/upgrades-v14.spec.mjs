import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { REPOSITORY_ROOT } from '../run-paths.ts';
import { RuntimeStore } from '../runtime-store.ts';
import { makeFixture } from '../../testing/test-support.mjs';
import { upgradesFromV14 } from './upgrades-v14.ts';

function authorization(runId, extra = {}) {
	return {
		schemaVersion: '1.0.0',
		runId,
		approvedSpecHash: 'a'.repeat(64),
		approvedPlanPolicyHash: 'b'.repeat(64),
		repositoryId: 'fixture-repo',
		baseCommitSha: 'c'.repeat(40),
		allowedPackages: ['packages/consumer'],
		allowedPathPrefixes: ['packages/consumer/'],
		allowedOperations: { editIsolatedWorktree: true, runAllowlistedCommands: true, createDetachedWorktree: true },
		maxSemanticRepairs: 2,
		modelUsageProfile: 'agent-sdlc-default',
		expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
		approvedAt: new Date().toISOString(),
		approvalMethod: 'cli_prompt',
		...extra,
	};
}

test('@ac AC-02 @case AC-02.7 preparation binding round-trips through run_authorizations', () => {
	const fixture = makeFixture('prep-binding-roundtrip', []);
	try {
		fixture.runtime.initialize({ runId: fixture.runId, goal: 'preparation binding persistence' });
		const preparationPolicyHash = 'd'.repeat(64);
		fixture.store.saveAuthorization(authorization(fixture.runId, { preparationPolicyHash }));
		assert.equal(fixture.store.getAuthorization(fixture.runId).preparationPolicyHash, preparationPolicyHash);

		fixture.store.saveAuthorization(authorization(fixture.runId));
		const legacy = fixture.store.getAuthorization(fixture.runId);
		assert.equal('preparationPolicyHash' in legacy, false);
	} finally {
		fixture.close();
	}
});

test('@ac AC-02 @case AC-02.7 a v13 store gains preparation_policy_hash on upgrade to v14', () => {
	const root = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures', `schema-v14-${crypto.randomUUID()}`);
	fs.mkdirSync(root, { recursive: true });
	const databasePath = path.join(root, 'runtime.sqlite');
	try {
		const created = new RuntimeStore(databasePath);
		created.close();
		const database = new DatabaseSync(databasePath);
		database.exec('ALTER TABLE run_authorizations DROP COLUMN preparation_policy_hash');
		database.exec('DELETE FROM schema_migrations WHERE version > 13');
		database.exec("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (13, '2026-11-01T00:00:00.000Z')");
		database.close();

		const reopened = new RuntimeStore(databasePath);
		const columns = reopened.database.prepare('PRAGMA table_info(run_authorizations)').all().map((column) => column.name);
		assert.ok(columns.includes('preparation_policy_hash'));
		assert.equal(reopened.database.prepare('SELECT max(version) AS version FROM schema_migrations').get().version, 15);
		reopened.close();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('upgrade step 14 requires hasColumn, skips a missing table, and is idempotent', () => {
	assert.deepEqual(upgradesFromV14.map((step) => step.version), [14]);
	const [step] = upgradesFromV14;
	const database = new DatabaseSync(':memory:');
	try {
		assert.throws(() => step.up(database, {}), /requires hasColumn/);
		const hasColumn = (db, table, name) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name);
		step.up(database, { hasColumn });
		database.exec('CREATE TABLE run_authorizations (run_id TEXT PRIMARY KEY)');
		step.up(database, { hasColumn });
		step.up(database, { hasColumn });
		assert.equal(hasColumn(database, 'run_authorizations', 'preparation_policy_hash'), true);
	} finally {
		database.close();
	}
});
