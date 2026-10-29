import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as movedContracts from '../policy/contracts.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

const IS_STANDALONE = !fs.existsSync(path.join(REPOSITORY_ROOT, 'packages/engine'));
const ROOT = IS_STANDALONE ? REPOSITORY_ROOT : path.join(REPOSITORY_ROOT, 'packages/engine');

test('@ac AC-02 @case AC-02.1 capability modules exist', () => {
	for (const relative of [
		'cli/cli.ts',
		'policy/contracts.ts',
		'review/agent-review.ts',
		'persistence/run-paths.ts',
	]) {
		assert.equal(fs.existsSync(path.join(ROOT, relative)), true, relative);
	}
});

test('@ac AC-02 @case AC-02.2 the contracts root shim is absent', () => {
	assert.equal(fs.existsSync(path.join(ROOT, 'contracts.mjs')), false);
	assert.ok(Object.keys(movedContracts).length > 0);
});

test('@ac AC-02 @case AC-02.3 agent-sdlc help exits 0 and prints usage', () => {
	const result = spawnSync(process.execPath, [path.join(ROOT, 'cli/cli.ts'), 'help'], {
		cwd: ROOT,
		encoding: 'utf8',
		timeout: 60_000,
	});
	const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
	assert.equal(result.status, 0, output);
	assert.match(output, /Usage:/);
});

test('@ac AC-02 @case AC-02.4 packages/engine contains its package.json', () => {
	assert.equal(fs.existsSync(path.join(ROOT, 'package.json')), true);
});

test('@ac AC-02 @case AC-02.5 boundedPlanningFiles names the moved planning modules', () => {
	const source = fs.readFileSync(path.join(ROOT, 'policy/canary-planning-files.ts'), 'utf8');
	for (const relative of [
		'policy/task-planner.ts',
		'policy/policy-gate.ts',
		'execution/task-executor.ts',
		'policy/contracts.ts',
	]) {
		assert.equal(source.includes(relative), true, relative);
	}
	const canary = fs.readFileSync(path.join(ROOT, 'policy/reliability/canary.ts'), 'utf8');
	assert.equal(canary.includes('listBoundedPlanningFiles'), true);
	const reliability = fs.readFileSync(path.join(ROOT, 'policy/reliability.ts'), 'utf8');
	assert.equal(reliability.includes("'tools/agent-sdlc/task-planner.mjs'"), false);
	assert.equal(reliability.includes("'tools/agent-sdlc/policy-gate.mjs'"), false);
	assert.equal(reliability.includes("'tools/agent-sdlc/task-executor.mjs'"), false);
	assert.equal(reliability.includes("'tools/agent-sdlc/contracts.mjs'"), false);
});

test('@ac AC-02 @case AC-02.6 no spec file remains at the agent-sdlc root', () => {
	const specs = fs.readdirSync(ROOT).filter((name) => name.endsWith('.spec.mjs'));
	assert.deepEqual(specs, []);
});
