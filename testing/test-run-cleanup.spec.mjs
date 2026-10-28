import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import {
	findLeakedTestRunArtifacts,
	makeFixture,
	removeTestRunArtifacts,
} from './test-support.mjs';

const RUN_KEYED_DIRECTORIES = [
	'docs/specs/runs',
	'tools/.agent-sdlc',
	'tools/.agent-sdlc/test-fixtures',
	'tools/.review',
];
const RUN_KEYED_FILES = ['tools/.model-usage/runs', 'tools/.model-usage/archive'];

function seedEveryLocation(runId) {
	for (const root of RUN_KEYED_DIRECTORIES) {
		const directory = path.join(REPOSITORY_ROOT, root, runId);
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, 'marker.json'), '{}');
	}
	for (const root of RUN_KEYED_FILES) {
		fs.mkdirSync(path.join(REPOSITORY_ROOT, root), { recursive: true });
		fs.writeFileSync(path.join(REPOSITORY_ROOT, root, `${runId}.json`), '{}');
	}
}

test('removeTestRunArtifacts removes every run-keyed location under the repository root', () => {
	const runId = `2026-10-20-cleanup-probe-${crypto.randomUUID().slice(0, 8)}`;
	try {
		seedEveryLocation(runId);
		assert.equal(findLeakedTestRunArtifacts(new Set([runId])).length, 6);
		removeTestRunArtifacts(runId);
		assert.deepEqual(findLeakedTestRunArtifacts(new Set([runId])), []);
	} finally {
		removeTestRunArtifacts(runId);
	}
});

test('findLeakedTestRunArtifacts matches a CLI run id by its trailing random slug only', () => {
	const token = crypto.randomUUID().slice(0, 8);
	const runId = `2026-10-20-sdlc-test-probe-${token}`;
	const unrelated = `2026-10-20-sdlc-test-probe-${token}x`;
	try {
		fs.mkdirSync(path.join(REPOSITORY_ROOT, 'tools/.review', runId), { recursive: true });
		fs.mkdirSync(path.join(REPOSITORY_ROOT, 'tools/.review', unrelated), { recursive: true });
		assert.deepEqual(findLeakedTestRunArtifacts(new Set([token])), [path.join('tools/.review', runId)]);
	} finally {
		removeTestRunArtifacts(runId);
		removeTestRunArtifacts(unrelated);
	}
});

test('a closed fixture leaves nothing keyed by its run id, including worktree and review paths', () => {
	const fixture = makeFixture('cleanup-probe', []);
	const worktreeDir = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', fixture.runId, 'worktree');
	const reviewDir = path.join(REPOSITORY_ROOT, 'tools/.review', fixture.runId);
	fs.mkdirSync(worktreeDir, { recursive: true });
	fs.mkdirSync(reviewDir, { recursive: true });
	fixture.close();
	assert.deepEqual(findLeakedTestRunArtifacts(new Set([fixture.runId])), []);
});
