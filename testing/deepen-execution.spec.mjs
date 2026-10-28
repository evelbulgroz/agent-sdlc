import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ALLOWED_TOOLS } from '../policy/contracts.ts';
import { listBoundedPlanningFiles } from '../policy/canary-planning-files.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { executeTool, minimalActionSchema } from '../execution/tools.ts';
import {
	MINIMAL_ATTEMPT_WALL_MS,
	MINIMAL_MAX_ATTEMPTS,
	MINIMAL_TOOL_CALL_CAP,
} from '../execution/minimal-executor.ts';

const SCHEMA_HASH = '14d564b67fb4aa412d9ac774a7f2fb23aa10e51431fd9605fd2524a2ef3cafd9';
const executionDir = path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/execution');

function readSource(name) {
	return fs.readFileSync(path.join(executionDir, name), 'utf8');
}

function newlineCount(filePath) {
	return fs.readFileSync(filePath).filter ? 0 : fs.readFileSync(filePath).toString('utf8').split('\n').length - 1;
}

test('@ac AC-01 @case AC-01.1 @case AC-01.2 @case AC-01.3 dead execution exports are gone', async () => {
	const coverage = await import('../execution/ac-coverage.ts');
	const executor = await import('../execution/task-executor.ts');
	const tools = await import('../execution/tools.ts');
	for (const name of ['assessAuthoredAcCoverage', 'rewriteAssertingTemplateCaseTitle']) {
		assert.equal(Object.hasOwn(coverage, name), false);
	}
	for (const name of ['confirmTaskTestFailure', 'runTaskVerificationCommand', 'checkAndRefreshManifest']) {
		assert.equal(Object.hasOwn(executor, name), false);
	}
	for (const name of ['applySnapshotRangeToContent', 'findFilesTool', 'listDirTool']) {
		assert.equal(Object.hasOwn(tools, name), false);
	}
	assert.deepEqual(Object.keys(tools).sort(), ['executeTool', 'minimalActionSchema']);
	assert.deepEqual(Object.keys(executor).sort(), [
		'DEFAULT_EXECUTOR_STEP_CEILING',
		'TaskExecutor',
		'calculateTaskStepCapacity',
		'resolveRunMaxPhysicalCalls',
	]);
});

test('@ac AC-01 @case AC-01.4 list_dir and find_files still return worktree entries', () => {
	const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepen-tools-'));
	try {
		fs.mkdirSync(path.join(worktreeDir, 'src'), { recursive: true });
		fs.writeFileSync(path.join(worktreeDir, 'src/note.ts'), 'export const note = 1;\n');
		const listed = executeTool({ toolName: 'list_dir', parameters: { path: 'src' }, worktreeDir });
		const found = executeTool({
			toolName: 'find_files',
			parameters: { pattern: '**/*.ts', path: 'src' },
			worktreeDir,
		});
		assert.ok(listed.entries.includes('note.ts'));
		assert.ok(found.matches.some((match) => match.path === 'src/note.ts' || match === 'src/note.ts' || match.path?.endsWith('note.ts')));
	} finally {
		fs.rmSync(worktreeDir, { recursive: true, force: true });
	}
});

test('@ac AC-02 @case AC-02.1 @case AC-02.2 @case AC-02.3 ac coverage stays a pure core', async () => {
	const core = readSource('ac-coverage.ts');
	assert.equal(/node:fs|node:path|node:child_process/.test(core), false);
	assert.equal(core.includes('ac-worktree-coverage.ts'), false);
	assert.equal(core.includes('ac-author-feedback.ts'), false);
	assert.equal(/from\s+['"]\./.test(readSource('test-execution-evidence.ts')), false);
	const evidenceImporters = fs.readdirSync(executionDir).filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'));
	for (const name of evidenceImporters) {
		if (name === 'ac-coverage.ts') continue;
		const source = readSource(name);
		assert.equal(
			/ac-coverage\.ts/.test(source) && /parseTestExecutionEvidence/.test(source) && /from\s+['"]\.\/ac-coverage\.ts['"]/.test(source),
			false,
			name,
		);
	}
	const keys = Object.keys(await import('../execution/ac-coverage.ts')).sort();
	assert.deepEqual(keys, ['bindAcCoverageToExecution', 'evaluateAcCoverage']);
});

test('@ac AC-03 @case AC-03.1 @case AC-03.2 @case AC-03.3 @case AC-03.4 tool exports and schema stay fixed', () => {
	const tools = readSource('tools.ts');
	assert.equal(crypto.createHash('sha256').update(JSON.stringify(minimalActionSchema())).digest('hex'), SCHEMA_HASH);
	for (const name of ['tool-path-guards.ts', 'tool-read.ts', 'tool-mutations.ts', 'tool-commands.ts']) {
		assert.equal(readSource(name).includes("from './tools.ts'"), false, name);
	}
	assert.equal(ALLOWED_TOOLS.length, 9);
	assert.throws(
		() => executeTool({ toolName: 'not_a_tool', parameters: {}, worktreeDir: os.tmpdir() }),
		(error) => error.message === "Tool 'not_a_tool' is not allowlisted",
	);
	assert.equal(tools.includes('export function executeTool'), true);
	assert.equal(tools.includes('export function minimalActionSchema'), true);
});

test('@ac AC-04 @case AC-04.1 @case AC-04.2 @case AC-04.3 minimal caps and provider boundary hold', async () => {
	assert.equal(MINIMAL_TOOL_CALL_CAP, 150);
	assert.equal(MINIMAL_ATTEMPT_WALL_MS, 3_600_000);
	assert.equal(MINIMAL_MAX_ATTEMPTS, 3);
	const keys = Object.keys(await import('../execution/minimal-executor.ts')).sort();
	assert.deepEqual(keys, [
		'MINIMAL_ATTEMPT_WALL_MS',
		'MINIMAL_MAX_ATTEMPTS',
		'MINIMAL_TOOL_CALL_CAP',
		'MinimalExecutor',
		'minimalActionSchema',
	]);
	for (const name of ['minimal-prompt.ts', 'minimal-verification.ts']) {
		const source = readSource(name);
		assert.equal(source.includes('minimal-executor.ts'), false, name);
		assert.equal(/openai|anthropic|@google|xai/.test(source), false, name);
	}
});

test('@ac AC-02 @case AC-02.2 @ac AC-05 @case AC-05.1 @case AC-05.4 deterministic roles leave the pipeline executor', () => {
	const source = readSource('pipeline-executor.ts');
	assert.equal(source.includes("roleId === 'hardener'"), false);
	assert.equal(source.includes("roleId === 'architect'"), false);
	assert.equal(source.includes('residual phase=code critic is graph-owned'), false);
	assert.match(source, /agent-review --phase code/);
	assert.equal(source.includes('pnpm run agent:'), false);
});

test('@ac AC-06 @case AC-06.1 @case AC-06.2 @case AC-06.3 @case AC-06.4 task modules stay hashed and independent', () => {
	const names = [
		'task-scope.ts',
		'task-verification-plan.ts',
		'task-acceptance-evidence.ts',
		'task-tree-delta.ts',
		'task-worktree-preparation.ts',
		'task-quality-gate.ts',
	];
	const bounded = listBoundedPlanningFiles(REPOSITORY_ROOT);
	for (const name of names) {
		assert.equal(readSource(name).includes('task-executor.ts'), false, name);
		assert.ok(bounded.includes(`packages/agent-sdlc/execution/${name}`), name);
	}
	const graph = fs.readFileSync(path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/workflow/nodes/execute-tasks.ts'), 'utf8');
	assert.equal(graph.includes('captureTaskDelta'), false);
});

test('@ac AC-07 @case AC-07.1 @case AC-07.2 @case AC-07.3 execution files are within the ceiling', () => {
	const exceptions = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/testing/navigability-exceptions.json'), 'utf8'));
	for (const key of Object.keys(exceptions)) {
		assert.equal(key.startsWith('packages/agent-sdlc/execution/'), false, key);
	}
	const files = [
		...fs.readdirSync(executionDir).filter((name) => name.endsWith('.ts') || name.endsWith('.mjs')).map((name) => path.join(executionDir, name)),
		path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/testing/deepen-execution.spec.mjs'),
	];
	for (const filePath of files) {
		const data = fs.readFileSync(filePath);
		const lines = data.toString('utf8').split('\n').length - 1;
		assert.ok(lines <= 500, `${filePath} ${lines}`);
		assert.ok(data.length <= 20480, `${filePath} ${data.length}`);
	}
	assert.equal(newlineCount(path.join(executionDir, 'tools.ts')) <= 500, true);
});
