import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { REPOSITORY_ROOT } from './run-paths.ts';
import { RuntimeStore } from './runtime-store.ts';
import { MIGRATION_LADDER, assertLadder } from './store-migrations.ts';
import {
	LEGACY_SCHEMA_V1,
	LEGACY_SCHEMA_V2,
	LEGACY_SCHEMA_V3_DOWNGRADE,
	LEGACY_SCHEMA_V4,
} from '../testing/legacy-store-schemas.mjs';
import { SdlcError } from '../policy/errors.ts';

test('runtime store applies migration v4 cleanly and supports incremental upgrades', () => {
	const root = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`migration-v4-${crypto.randomUUID()}`,
	);
	fs.mkdirSync(root, { recursive: true });
	try {
		// 1. Fresh v0 -> v5
		const freshPath = path.join(root, 'fresh.sqlite');
		const freshStore = new RuntimeStore(freshPath);
		const freshVersion = freshStore.database
			.prepare('SELECT max(version) AS version FROM schema_migrations')
			.get().version;
		assert.equal(freshVersion, 13);
		const continuationTable = freshStore.database
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='continuation_projections'",
			)
			.get();
		assert.equal(continuationTable.name, 'continuation_projections');
		freshStore.close();

		// 2. Existing v1 DB -> upgrade 1 -> 2 -> 3 -> 4 -> 5
		const v1Path = path.join(root, 'v1.sqlite');
		const v1Db = new DatabaseSync(v1Path);
		v1Db.exec(LEGACY_SCHEMA_V1);
		v1Db.close();

		const upgradedFrom1Store = new RuntimeStore(v1Path);
		const upgradedVersion1 = upgradedFrom1Store.database
			.prepare('SELECT max(version) AS version FROM schema_migrations')
			.get().version;
		assert.equal(upgradedVersion1, 13);
		upgradedFrom1Store.close();

		// 3. Existing v2 DB -> upgrade 2 -> 3 -> 4 -> 5
		const v2Path = path.join(root, 'v2.sqlite');
		const v2Db = new DatabaseSync(v2Path);
		v2Db.exec(LEGACY_SCHEMA_V2);
		v2Db.close();

		const upgradedFrom2Store = new RuntimeStore(v2Path);
		const upgradedVersion2 = upgradedFrom2Store.database
			.prepare('SELECT max(version) AS version FROM schema_migrations')
			.get().version;
		assert.equal(upgradedVersion2, 13);
		upgradedFrom2Store.close();

		// 4. Existing v3 DB -> upgrade 3 -> 4 -> 5
		const v3Path = path.join(root, 'v3.sqlite');
		const v3Store = new RuntimeStore(v3Path);
		v3Store.database.exec(LEGACY_SCHEMA_V3_DOWNGRADE);
		v3Store.close();

		const upgradedFrom3Store = new RuntimeStore(v3Path);
		const upgradedVersion3 = upgradedFrom3Store.database
			.prepare('SELECT max(version) AS version FROM schema_migrations')
			.get().version;
		assert.equal(upgradedVersion3, 13);
		upgradedFrom3Store.close();

		// 5. Existing v4 DB with tool execution and optional role -> upgrade 4 -> 5 table rebuild
		const v4Path = path.join(root, 'v4.sqlite');
		const v4Db = new DatabaseSync(v4Path);
		v4Db.exec(LEGACY_SCHEMA_V4);
		v4Db.close();

		const upgradedFrom4Store = new RuntimeStore(v4Path);
		const upgradedVersion4 = upgradedFrom4Store.database
			.prepare('SELECT max(version) AS version FROM schema_migrations')
			.get().version;
		assert.equal(upgradedVersion4, 13);

		// Verify existing data preserved with task_id default 'task-0'
		const migratedToolExec = upgradedFrom4Store.getToolExecution('exec-v4-0');
		assert.equal(migratedToolExec.taskId, 'task-0');
		assert.equal(migratedToolExec.roleId, 'implementer');

		const migratedOptionalRoles = upgradedFrom4Store.listOptionalRoleExecutions('2026-09-04-test-run-v4');
		assert.equal(migratedOptionalRoles.length, 1);
		assert.equal(migratedOptionalRoles[0].taskId, 'task-0');

		// Verify that task_id is part of uniqueness in v5 (P1-B verification):
		// A second tool execution in the same generation and step_index with taskId 'task-1' succeeds!
		upgradedFrom4Store.recordToolExecution({
			schemaVersion: '1.0.0',
			executionId: 'exec-v5-1',
			runId: '2026-09-04-test-run-v4',
			taskId: 'task-1',
			roleId: 'implementer',
			generation: 0,
			stepIndex: 0,
			toolName: 'write_file',
			inputHash: '1'.repeat(64),
			outputArtifact: null,
			exitCode: 0,
			createdAt: '2026-09-04T00:01:00.000Z',
		});
		const task1Exec = upgradedFrom4Store.getToolExecution('exec-v5-1');
		assert.equal(task1Exec.taskId, 'task-1');

		// A second optional role execution in the same generation with taskId 'task-1' succeeds!
		upgradedFrom4Store.saveOptionalRoleExecution({
			schemaVersion: '1.0.0',
			runId: '2026-09-04-test-run-v4',
			taskId: 'task-1',
			roleId: 'cleaner',
			insertionPoint: 'post_implement',
			generation: 0,
			status: 'modified',
			summary: 'cleaned task-1',
			executedAt: '2026-09-04T00:01:00.000Z',
		});
		const task1Roles = upgradedFrom4Store.listOptionalRoleExecutions('2026-09-04-test-run-v4', 0, 'task-1');
		assert.equal(task1Roles.length, 1);
		assert.equal(task1Roles[0].taskId, 'task-1');

		upgradedFrom4Store.close();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function schemaShape(database) {
	const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
	const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all().map((row) => row.name);
	const columns = {};
	for (const table of tables) {
		columns[table] = database.prepare(`PRAGMA table_info(${table})`).all().map((column) => `${column.name}:${column.type}`);
	}
	return { tables, indexes, columns };
}

test('@ac AC-01 @case AC-01.1 fresh and v1-upgraded stores match table, index, and column shape', () => {
	const root = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures', `schema-shape-${crypto.randomUUID()}`);
	fs.mkdirSync(root, { recursive: true });
	const freshPath = path.join(root, 'fresh.sqlite');
	const upgradedPath = path.join(root, 'upgraded.sqlite');
	try {
		const fresh = new RuntimeStore(freshPath);
		const seeded = new DatabaseSync(upgradedPath);
		seeded.exec(LEGACY_SCHEMA_V1);
		seeded.close();
		const upgraded = new RuntimeStore(upgradedPath);
		const freshShape = schemaShape(fresh.database);
		const upgradedShape = schemaShape(upgraded.database);
		assert.deepEqual(freshShape.tables, upgradedShape.tables);
		for (const table of freshShape.tables) {
			assert.deepEqual(freshShape.columns[table].slice().sort(), upgradedShape.columns[table].slice().sort(), table);
		}
		const onlyFresh = freshShape.indexes.filter((name) => !upgradedShape.indexes.includes(name));
		const onlyUpgraded = upgradedShape.indexes.filter((name) => !freshShape.indexes.includes(name));
		assert.deepEqual(onlyFresh, []);
		// Pre-existing drift: the v1 ladder creates these indexes and the fresh baseline does not.
		assert.deepEqual(onlyUpgraded, ['idx_optional_role_executions_run', 'idx_tool_executions_run']);
		fresh.close();
		upgraded.close();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.2 fresh and v1-upgraded stores both record schema version 13', () => {
	const root = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures', `schema-versions-${crypto.randomUUID()}`);
	fs.mkdirSync(root, { recursive: true });
	try {
		const fresh = new RuntimeStore(path.join(root, 'fresh.sqlite'));
		const freshVersions = fresh.database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version);
		assert.equal(Math.max(...freshVersions), 13);
		fresh.close();
		const upgradedPath = path.join(root, 'upgraded.sqlite');
		const seeded = new DatabaseSync(upgradedPath);
		seeded.exec(LEGACY_SCHEMA_V1);
		seeded.close();
		const upgraded = new RuntimeStore(upgradedPath);
		const versions = upgraded.database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version);
		assert.equal(Math.max(...versions), 13);
		for (let version = 2; version <= 13; version += 1) {
			assert.equal(versions.filter((item) => item === version).length, 1, `version ${version}`);
		}
		upgraded.close();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.3 the exported ladder ends at version 13 and rejects a ladder ending at 12', () => {
	assert.equal(MIGRATION_LADDER.at(-1).version, 13);
	assert.throws(() => assertLadder(MIGRATION_LADDER.slice(0, -1)), /ends at 12/);
});

test('@ac AC-01 @case AC-01.4 schema version 14 fails to open', () => {
	const root = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures', `schema-14-${crypto.randomUUID()}`);
	fs.mkdirSync(root, { recursive: true });
	const databasePath = path.join(root, 'runtime.sqlite');
	try {
		const database = new DatabaseSync(databasePath);
		database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations (version, applied_at) VALUES (14, '2026-10-22T00:00:00.000Z');");
		database.close();
		assert.throws(
			() => new RuntimeStore(databasePath),
			(error) => error instanceof SdlcError && error.code === 'STORE_VERSION_UNSUPPORTED' && error.message === 'Runtime store schema 14 is newer than supported 13',
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.5 a version 13 store missing generations.oracle_snapshot_json gains it on the next open', () => {
	const root = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures', `schema-repair-${crypto.randomUUID()}`);
	fs.mkdirSync(root, { recursive: true });
	const databasePath = path.join(root, 'runtime.sqlite');
	try {
		const created = new RuntimeStore(databasePath);
		created.close();
		const database = new DatabaseSync(databasePath);
		database.exec('ALTER TABLE generations DROP COLUMN oracle_snapshot_json');
		const version = database.prepare('SELECT max(version) AS version FROM schema_migrations').get().version;
		assert.equal(version, 13);
		const dropped = database.prepare('PRAGMA table_info(generations)').all().some((column) => column.name === 'oracle_snapshot_json');
		assert.equal(dropped, false);
		database.close();
		const reopened = new RuntimeStore(databasePath);
		const restored = reopened.database.prepare('PRAGMA table_info(generations)').all().some((column) => column.name === 'oracle_snapshot_json');
		assert.equal(restored, true);
		assert.equal(reopened.database.prepare('SELECT max(version) AS version FROM schema_migrations').get().version, 13);
		reopened.close();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
