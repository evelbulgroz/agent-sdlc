import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { applyBaselineSchema } from './baseline-schema.ts';
import { REPOSITORY_ROOT } from '../run-paths.ts';

test('baseline schema creates the run and continuation projection tables', () => {
	const root = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures', `baseline-${crypto.randomUUID()}`);
	fs.mkdirSync(root, { recursive: true });
	try {
		const database = new DatabaseSync(path.join(root, 'runtime.sqlite'));
		applyBaselineSchema(database);
		const tables = database
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all()
			.map((row) => row.name);
		assert.equal(tables.includes('runs'), true);
		assert.equal(tables.includes('continuation_projections'), true);
		assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get(), undefined);
		database.close();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
