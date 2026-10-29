import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { listBoundedPlanningFiles, resolveBoundedPlanningFilePath } from './canary-planning-files.ts';
import { writeSyntheticHostProfile } from '../testing/cli-test-support.mjs';
import { currentCanaryBindings, evaluateCurrentCanaryGate } from './reliability.ts';

const FIXED = [
	'execution/task-executor.ts',
	'policy/contracts.ts',
	'policy/policy-gate.ts',
	'policy/task-planner.ts',
];

function copyRelative(root, relative) {
	const destination = path.join(root, relative);
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.copyFileSync(resolveBoundedPlanningFilePath(REPOSITORY_ROOT, relative), destination);
}

function makeCanaryRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-planning-'));
	fs.cpSync(path.join(REPOSITORY_ROOT, '.agents/workflows'), path.join(root, '.agents/workflows'), { recursive: true });
	for (const relative of listBoundedPlanningFiles(REPOSITORY_ROOT)) copyRelative(root, relative);
	return root;
}

test('@ac AC-03 @case AC-03.1 the repository planning list is sorted and has no spec file', () => {
	const list = listBoundedPlanningFiles(REPOSITORY_ROOT);
	assert.deepEqual(list, [...list].sort());
	for (const relative of FIXED) assert.equal(list.includes(relative), true, relative);
	const contractsDir = path.join(REPOSITORY_ROOT, 'policy/contracts');
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')) {
				const relative = path.relative(REPOSITORY_ROOT, full).split(path.sep).join('/');
				assert.equal(list.includes(relative), true, relative);
			}
		}
	};
	walk(contractsDir);
	assert.equal(list.some((relative) => relative.endsWith('.spec.mjs') || relative.endsWith('.spec.ts')), false);
	assert.equal(list.includes('policy/task-planner/task-graph.ts'), true);
	assert.equal(list.includes('policy/task-planner/workspace-packages.ts'), true);
	assert.equal(list.includes('policy/task-planner/task-readiness.ts'), true);
});

test('@ac AC-03 @case AC-03.2 @case AC-03.3 pattern files join the list and missing folders do not', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-planning-empty-'));
	try {
		writeSyntheticHostProfile(root, { engine: { selfRoot: 'vendor/agent-sdlc' } });
		fs.mkdirSync(path.join(root, 'vendor/agent-sdlc'), { recursive: true });
		assert.deepEqual(listBoundedPlanningFiles(root), FIXED.map((relative) => `vendor/agent-sdlc/${relative}`).sort());
		const contractsDir = path.join(root, 'vendor/agent-sdlc/policy/contracts');
		fs.mkdirSync(contractsDir, { recursive: true });
		fs.writeFileSync(path.join(contractsDir, 'canary-probe.ts'), 'export const probe = 1;\n');
		fs.writeFileSync(path.join(contractsDir, 'canary-probe.spec.mjs'), 'test(() => {});\n');
		const executionDir = path.join(root, 'vendor/agent-sdlc/execution');
		fs.mkdirSync(executionDir, { recursive: true });
		fs.writeFileSync(path.join(executionDir, 'task-probe.ts'), 'export const probe = 1;\n');
		fs.writeFileSync(path.join(executionDir, 'tools.ts'), 'export const tools = 1;\n');
		const list = listBoundedPlanningFiles(root);
		assert.equal(list.includes('vendor/agent-sdlc/policy/contracts/canary-probe.ts'), true);
		assert.equal(list.includes('vendor/agent-sdlc/policy/contracts/canary-probe.spec.mjs'), false);
		assert.equal(list.includes('vendor/agent-sdlc/execution/task-probe.ts'), true);
		assert.equal(list.includes('vendor/agent-sdlc/execution/tools.ts'), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-03 @case AC-03.4 a new contracts file makes the canary stale without writing the qualification', () => {
	const root = makeCanaryRoot();
	try {
		const bindings = currentCanaryBindings(root);
		const qualification = {
			schemaVersion: '1.0.0',
			repositoryId: bindings.repositoryId,
			runId: '2026-10-22-canary-probe',
			status: 'PASSED',
			failureCategories: [],
			inconclusiveCause: null,
			baseCommitSha: 'a'.repeat(40),
			workflowHash: bindings.workflowHash,
			boundedPlanningHash: bindings.boundedPlanningHash,
			implementerRoleHash: bindings.implementerRoleHash,
			modelPolicyHash: bindings.modelPolicyHash,
			taskPlanHash: 'b'.repeat(64),
			taskManifestHash: 'c'.repeat(64),
			qualifiedAt: '2026-10-22T00:00:00.000Z',
		};
		const qualificationPath = path.join(root, 'tools/.agent-sdlc/canary-qualification.json');
		fs.mkdirSync(path.dirname(qualificationPath), { recursive: true });
		fs.writeFileSync(qualificationPath, `${JSON.stringify(qualification)}\n`);
		const before = fs.readFileSync(qualificationPath);
		fs.writeFileSync(path.join(root, 'policy/contracts/canary-probe.ts'), 'export const probe = 1;\n');
		const gate = evaluateCurrentCanaryGate(root);
		assert.equal(gate.status, 'CANARY_STALE');
		assert.equal(gate.reason, 'boundedPlanningHash-changed');
		assert.deepEqual(fs.readFileSync(qualificationPath), before);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-03 @case AC-03.5 current bindings do not write the repository qualification', () => {
	const qualificationPath = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/canary-qualification.json');
	const existed = fs.existsSync(qualificationPath);
	const before = existed ? fs.readFileSync(qualificationPath) : null;
	currentCanaryBindings(REPOSITORY_ROOT);
	assert.equal(fs.existsSync(qualificationPath), existed);
	if (before) assert.deepEqual(fs.readFileSync(qualificationPath), before);
});

test('current bindings throw when a fixed planning file is missing', () => {
	const root = makeCanaryRoot();
	try {
		fs.rmSync(path.join(root, 'policy/contracts.ts'));
		assert.throws(() => currentCanaryBindings(root), (error) => error.code === 'ENOENT');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('the engine vendored at engine.selfRoot lists the same files as the engine at the host root, modulo prefix', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-vendored-'));
	try {
		const embedded = listBoundedPlanningFiles(REPOSITORY_ROOT);
		writeSyntheticHostProfile(root, { engine: { selfRoot: 'vendor/agent-sdlc' } });
		for (const relative of embedded) {
			const destination = path.join(root, 'vendor/agent-sdlc', relative);
			fs.mkdirSync(path.dirname(destination), { recursive: true });
			fs.copyFileSync(path.join(REPOSITORY_ROOT, relative), destination);
		}
		const vendored = listBoundedPlanningFiles(root);
		assert.deepEqual(vendored, embedded.map((relative) => `vendor/agent-sdlc/${relative}`));
		for (const logical of vendored) assert.equal(fs.existsSync(resolveBoundedPlanningFilePath(root, logical)), true, logical);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
