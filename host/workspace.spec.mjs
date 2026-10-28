import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { writeSyntheticHostProfile } from '../testing/cli-test-support.mjs';
import * as fitnessAppAdapter from './fitness-app.ts';
import { loadHostProfile } from './host-profile.ts';
import * as scriptAdapter from './script.ts';
import { discoverWorkspace } from './workspace.ts';

function withTempRoot(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-workspace-test-'));
	return Promise.resolve()
		.then(() => fn(dir))
		.finally(() => {
			fs.rmSync(dir, { recursive: true, force: true });
		});
}

const SCRIPT_PROFILE = Object.freeze({
	schemaVersion: '1.3.0',
	profileId: 'fixture-host',
	repositoryId: 'fixture-host',
	adapter: 'script',
	stateDir: 'tools/.agent-sdlc',
	reviewDir: 'tools/.review',
	specDraftDir: 'docs/specs/drafts',
	verify: {
		argv: ['node', 'verify.mjs', '{baseSha}'],
		resultPath: 'tools/.verify/last.json',
		headField: 'head',
		require: { status: 'OK', canonical: true },
	},
	commands: [['node', '--test']],
	hydration: [],
	workspace: { directories: ['.'] },
});

test('@ac AC-06 @case AC-06.1 the fitness-app adapter reports packages/a when a synthetic 1.3.0 profile and pnpm-workspace.yaml list packages/a', async () => {
	await withTempRoot(async (rootDir) => {
		writeSyntheticHostProfile(rootDir);
		fs.writeFileSync(
			path.join(rootDir, 'pnpm-workspace.yaml'),
			'packages:\n  - packages/a\n',
		);
		fs.mkdirSync(path.join(rootDir, 'packages/a'), { recursive: true });
		fs.writeFileSync(
			path.join(rootDir, 'packages/a/package.json'),
			JSON.stringify({ name: '@example/pkg-a' }),
		);
		const profile = loadHostProfile(rootDir);
		const result = discoverWorkspace(rootDir, profile);
		assert.ok(result.directories.includes('packages/a'));
		assert.equal(result.pathToPackage.has('packages/a'), true);
	});
});

test('@ac AC-06 @case AC-06.2 the script adapter reports . and does not read pnpm-workspace.yaml', async () => {
	await withTempRoot(async (rootDir) => {
		fs.writeFileSync(
			path.join(rootDir, 'pnpm-workspace.yaml'),
			'packages:\n  - packages/a\n',
		);
		const result = discoverWorkspace(rootDir, SCRIPT_PROFILE);
		assert.deepEqual(result.directories, ['.']);
		assert.equal(result.pathToPackage.has('packages/a'), false);
		assert.equal(result.pathToPackage.get('.'), '.');
	});
});

test('@ac AC-06 @case AC-06.3 planTaskDag calls discoverWorkspace in host/workspace.ts, which calls scanWorkspacePackages for fitness-app and returns workspace.directories for script, and neither fitness-app.ts nor script.ts exports discovery', () => {
	const plannerSource = fs.readFileSync(
		path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/policy/task-planner.ts'),
		'utf8',
	);
	const workspaceSource = fs.readFileSync(
		path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/host/workspace.ts'),
		'utf8',
	);

	assert.match(plannerSource, /from '\.\.\/host\/workspace\.ts'/);
	assert.match(plannerSource, /discoverWorkspace\(rootDir\)/);
	assert.match(workspaceSource, /scanWorkspacePackages\(rootDir\)/);
	assert.match(workspaceSource, /resolved\.workspace\.directories/);

	assert.equal('discoverWorkspace' in fitnessAppAdapter, false);
	assert.equal('scanWorkspacePackages' in fitnessAppAdapter, false);
	assert.equal('discoverWorkspace' in scriptAdapter, false);
	assert.equal('scanWorkspacePackages' in scriptAdapter, false);
});

