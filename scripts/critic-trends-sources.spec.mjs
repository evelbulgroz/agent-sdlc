import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { aggregateCriticTrends, aggregateSkillsTrends } from './aggregate-critic-trends.ts';
import { listRunDatabases, readDatabaseFindings } from './critic-trends-sources.ts';

function createRunDatabase(rootDir, runId) {
	const runtimeDir = path.join(rootDir, 'tools/.agent-sdlc', runId);
	fs.mkdirSync(runtimeDir, { recursive: true });
	const database = new DatabaseSync(path.join(runtimeDir, 'runtime.sqlite'));
	try {
		database.exec(
			'CREATE TABLE optional_role_executions (role_id TEXT NOT NULL, structured_findings_json TEXT)',
		);
		database
			.prepare('INSERT INTO optional_role_executions (role_id, structured_findings_json) VALUES (?, ?)')
			.run('architect', JSON.stringify({ violations: [{ boundary: 'cross-package' }] }));
	} finally {
		database.close();
	}
	return path.join(runtimeDir, 'runtime.sqlite');
}

function makeTrendsRoot() {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'critic-trends-sources-'));
	createRunDatabase(rootDir, 'run-a');
	createRunDatabase(rootDir, 'run-b');
	fs.mkdirSync(path.join(rootDir, 'tools/.agent-sdlc/run-empty'), { recursive: true });
	const linkTarget = path.join(rootDir, 'linked-run-target');
	createRunDatabase(linkTarget, 'inner');
	fs.symlinkSync(
		path.join(linkTarget, 'tools/.agent-sdlc/inner'),
		path.join(rootDir, 'tools/.agent-sdlc/run-linked'),
	);
	return rootDir;
}

test('@ac AC-06 @case AC-06.1 listRunDatabases returns the two run databases and skips empty and symlinked entries', () => {
	const rootDir = makeTrendsRoot();
	try {
		const listed = listRunDatabases(rootDir);
		assert.deepEqual(listed.map((item) => item.runId).sort(), ['run-a', 'run-b']);
		for (const item of listed) {
			assert.equal(
				item.databasePath,
				path.join(rootDir, 'tools/.agent-sdlc', item.runId, 'runtime.sqlite'),
			);
		}
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('@ac AC-06 @case AC-06.1 listRunDatabases returns an empty list when the runtime root is missing', () => {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'critic-trends-missing-'));
	try {
		assert.deepEqual(listRunDatabases(rootDir), []);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('@ac AC-06 @case AC-06.2 both aggregations report databasesScanned 2 over the same root', () => {
	const rootDir = makeTrendsRoot();
	try {
		assert.equal(aggregateCriticTrends({ rootDir }).databasesScanned, 2);
		assert.equal(aggregateSkillsTrends({ rootDir }).databasesScanned, 2);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('readDatabaseFindings maps architect violations to boundary keys for the run', () => {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'critic-trends-read-'));
	try {
		const databasePath = createRunDatabase(rootDir, 'run-a');
		assert.deepEqual(readDatabaseFindings(databasePath, 'run-a', rootDir), [
			{ runId: 'run-a', source: 'architect', key: '[architect] boundary:cross-package' },
		]);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('@ac AC-06 @case AC-06.3 aggregate-critic-trends.mjs holds no run-directory scan of its own', () => {
	const source = fs.readFileSync(new URL('./aggregate-critic-trends.ts', import.meta.url), 'utf8');
	assert.equal(source.includes('runtime.sqlite'), false);
	assert.equal(source.includes('readdirSync'), false);
});
