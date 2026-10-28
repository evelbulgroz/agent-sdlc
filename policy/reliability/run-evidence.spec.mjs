import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
	readArtifactJson,
	readTerminalQaDivergences,
} from './run-evidence.ts';

test('@regression canary-qualification reads QA divergences from the terminal runtime event', () => {
	const database = new DatabaseSync(':memory:');
	try {
		database.exec(`
			CREATE TABLE events (
				run_id TEXT NOT NULL,
				runtime_revision INTEGER NOT NULL,
				event_type TEXT NOT NULL,
				event_json TEXT NOT NULL
			)
		`);
		const qaDivergences = [
			{
				severity: 'P2',
				category: 'testing',
				evidence: 'GAP AC-01: assertion verifies navigation.',
				groundingVerified: true,
			},
		];
		database
			.prepare(
				'INSERT INTO events (run_id, runtime_revision, event_type, event_json) VALUES (?, ?, ?, ?)',
			)
			.run(
				'run-a',
				7,
				'RUN_READY_FOR_GIT_APPROVAL',
				JSON.stringify({ payload: { qaDivergences } }),
			);
		assert.deepEqual(
			readTerminalQaDivergences(database, 'run-a'),
			qaDivergences,
		);
	} finally {
		database.close();
	}
});

test('@regression canary-qualification-relative-artifact resolves preflight evidence from the run directory', () => {
	const runtimeDir = fs.mkdtempSync(
		path.join(os.tmpdir(), 'agent-sdlc-reliability-artifact-'),
	);
	const databasePath = path.join(runtimeDir, 'runtime.sqlite');
	const artifactDir = path.join(runtimeDir, 'artifacts');
	const hash = 'c'.repeat(64);
	const binding = { status: 'OK', canonical: true };
	fs.mkdirSync(artifactDir);
	fs.writeFileSync(path.join(artifactDir, `${hash}.json`), JSON.stringify(binding));
	const database = new DatabaseSync(databasePath);
	try {
		database.exec(
			'CREATE TABLE artifacts (hash TEXT PRIMARY KEY, storage_path TEXT NOT NULL)',
		);
		database
			.prepare('INSERT INTO artifacts (hash, storage_path) VALUES (?, ?)')
			.run(hash, `artifacts/${hash}.json`);
		assert.deepEqual(readArtifactJson(database, databasePath, hash), binding);
	} finally {
		database.close();
		fs.rmSync(runtimeDir, { recursive: true, force: true });
	}
});
