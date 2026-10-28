import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { REPOSITORY_ROOT } from '../run-paths.ts';
import { RuntimeStore } from '../runtime-store.ts';
import { upgradesV1ToV7 } from './upgrades-v1-v7.ts';
import {
	LEGACY_SCHEMA_V5,
} from '../../testing/legacy-store-schemas.mjs';

test('v5 database upgrades cleanly through v6 and v7 without skipping migration 7', () => {
	const root = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`migration-v5-to-v7-${crypto.randomUUID()}`,
	);
	fs.mkdirSync(root, { recursive: true });
	const v5Path = path.join(root, 'v5.sqlite');
	try {
		const db = new DatabaseSync(v5Path);
		db.exec(LEGACY_SCHEMA_V5);
		db.close();

		const store = new RuntimeStore(v5Path);
		const versions = store.database
			.prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
			.all()
			.map((r) => r.version);
		assert.deepEqual(versions, [5, 6, 7, 8, 9, 10, 11, 12, 13]);

		// Verify 3 new columns exist in model_operations
		const cols = store.database.prepare('PRAGMA table_info(model_operations)').all();
		const colNames = cols.map((c) => c.name);
		assert.ok(colNames.includes('effective_strategy'));
		assert.ok(colNames.includes('selected_quality_tier'));
		assert.ok(colNames.includes('counterfactual_tier2_cost_microusd'));

		// Verify diagnostics table exists
		const tables = store.database
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='diagnostics'")
			.all();
		assert.equal(tables.length, 1);

		store.close();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('upgrade steps 2 through 7 require hasColumn and do not record a version when the first alter fails', () => {
	assert.deepEqual(upgradesV1ToV7.map((step) => step.version), [2, 3, 4, 5, 6, 7]);
	assert.throws(() => upgradesV1ToV7[0].up(null, {}), /Migration step requires hasColumn/);
	const root = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures', `upgrade-v2-miss-${crypto.randomUUID()}`);
	fs.mkdirSync(root, { recursive: true });
	try {
		const database = new DatabaseSync(path.join(root, 'partial.sqlite'));
		database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
		assert.throws(() => upgradesV1ToV7[0].up(database, { hasColumn() { return false; } }));
		assert.equal(database.prepare('SELECT count(*) AS count FROM schema_migrations').get().count, 0);
		database.close();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
