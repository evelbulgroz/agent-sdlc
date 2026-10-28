import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { REPOSITORY_ROOT } from '../run-paths.ts';
import { RuntimeStore } from '../runtime-store.ts';
import { upgradesV8ToV13 } from './upgrades-v8-v13.ts';
import {
	LEGACY_LEARNING_TABLES_V7,
	LEGACY_SCHEMA_V8_WITHOUT_FRICTION,
} from '../../testing/legacy-store-schemas.mjs';

test('schema v8 migrates legacy learning tables to contracted columns and uniqueness', () => {
	const root = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`migration-v7-to-v8-${crypto.randomUUID()}`,
	);
	const databasePath = path.join(root, 'runtime.sqlite');
	fs.mkdirSync(root, { recursive: true });
	try {
		const store = new RuntimeStore(databasePath);
		store.close();
		const database = new DatabaseSync(databasePath);
		database.exec(LEGACY_LEARNING_TABLES_V7);
		database.close();

		let migrated;
		try {
			migrated = new RuntimeStore(databasePath);
		} catch (error) {
			assert.fail(`migration failed: ${error.cause?.message ?? error.message}`);
		}
		const candidateColumns = migrated.database
			.prepare('PRAGMA table_info(candidate_learnings)')
			.all()
			.map((column) => column.name);
		const outboxColumns = migrated.database
			.prepare('PRAGMA table_info(learning_outbox)')
			.all()
			.map((column) => column.name);
		assert.deepEqual(candidateColumns, [
			'candidate_id',
			'run_id',
			'task_id',
			'generation',
			'source_phase',
			'learning_type',
			'learning_key',
			'scope',
			'query',
			'insight',
			'confidence',
			'source',
			'graduation_target',
			'created_at',
		]);
		assert.deepEqual(outboxColumns, [
			'outbox_id',
			'run_id',
			'runtime_revision',
			'learning_key',
			'payload_json',
			'published_at',
			'created_at',
		]);
		const uniqueIndex = migrated.database
			.prepare("PRAGMA index_list('candidate_learnings')")
			.all()
			.find((index) => index.unique === 1);
		assert.ok(uniqueIndex);
		assert.deepEqual(
			migrated.database
				.prepare(`PRAGMA index_info('${uniqueIndex.name}')`)
				.all()
				.map((column) => column.name),
			['run_id', 'task_id', 'generation', 'source_phase', 'learning_key'],
		);
		migrated.close();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('schema v9 migrates v8 database and creates prompt_friction_findings table', () => {
	const root = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`migration-v8-to-v9-${crypto.randomUUID()}`,
	);
	const databasePath = path.join(root, 'runtime.sqlite');
	fs.mkdirSync(root, { recursive: true });
	try {
		const store = new RuntimeStore(databasePath);
		store.close();

		// Revert to schema version 8 without prompt_friction_findings table
		const database = new DatabaseSync(databasePath);
		database.exec(LEGACY_SCHEMA_V8_WITHOUT_FRICTION);
		database.close();

		let migrated;
		try {
			migrated = new RuntimeStore(databasePath);
		} catch (error) {
			assert.fail(`migration failed: ${error.cause?.message ?? error.message}`);
		}
		const maxVersion = migrated.database
			.prepare('SELECT max(version) AS version FROM schema_migrations')
			.get().version;
		assert.equal(maxVersion, 13);
		const continuationTable = migrated.database
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='continuation_projections'",
			)
			.get();
		assert.equal(continuationTable.name, 'continuation_projections');

		const columns = migrated.database
			.prepare('PRAGMA table_info(prompt_friction_findings)')
			.all()
			.map((c) => c.name);
		assert.deepEqual(columns, [
			'finding_id',
			'run_id',
			'role_id',
			'signal_type',
			'category',
			'finding_key',
			'status',
			'attribution_layer',
			'evidence_json',
			'proposed_diff_json',
			'created_at',
			'updated_at',
		]);

		const indexNames = migrated.database
			.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='prompt_friction_findings'")
			.all()
			.map((r) => r.name);
		assert.ok(indexNames.includes('idx_prompt_friction_findings_run'));
		assert.ok(indexNames.includes('idx_prompt_friction_findings_key'));
		migrated.close();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('upgrade steps 8 through 13 are addressed directly and require hasColumn', () => {
	assert.deepEqual(upgradesV8ToV13.map((step) => step.version), [8, 9, 10, 11, 12, 13]);
	assert.throws(() => upgradesV8ToV13[0].up(null, {}), /Migration step requires hasColumn/);
});
