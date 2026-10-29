import '../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { executeRolePipeline } from './pipeline-executor.ts';
import {
	analyzeArchitecturalBoundaries,
	runDeterministicAnalysisRole,
} from './pipeline-deterministic-roles.ts';

function makeWorktree() {
	const root = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`pipeline-${crypto.randomUUID()}`,
	);
	fs.mkdirSync(root, { recursive: true });
	return root;
}

test('architect scans touched files and attributes all required import violations', () => {
	const root = makeWorktree();
	const files = {
		'services/billing/src/local.ts': "import { value } from './value';\n",
		'services/billing/src/cross.ts':
			"import { User } from '../../../packages/shared-base/src/user.js';\n",
		'frontends/pwa-frontend/src/direct.ts':
			"import { Contract } from '@fixture/billing-service/contracts';\n",
		'packages/base/src/deep.ts':
			"import { hidden } from '@fixture/shared-base/dist/internal.js';\n",
	};
	try {
		for (const [file, content] of Object.entries(files)) {
			const absolute = path.join(root, file);
			fs.mkdirSync(path.dirname(absolute), { recursive: true });
			fs.writeFileSync(absolute, content, 'utf8');
		}
		const result = analyzeArchitecturalBoundaries('', Object.keys(files), root);
		assert.equal(result.status, 'VIOLATIONS_DETECTED');
		assert.deepEqual(
			result.violations.map(({ boundary, file, severity }) => ({ boundary, file, severity })),
			[
				{
					boundary: 'missing-esm-js-extension',
					file: 'services/billing/src/local.ts',
					severity: 'P2',
				},
				{
					boundary: 'cross-package-relative-traversal',
					file: 'services/billing/src/cross.ts',
					severity: 'P1',
				},
				{
					boundary: 'frontend-backend-import',
					file: 'frontends/pwa-frontend/src/direct.ts',
					severity: 'P1',
				},
				{
					boundary: 'deep-dist-import',
					file: 'packages/base/src/deep.ts',
					severity: 'P1',
				},
			],
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('architect persists structured P2 findings and stages task-aware learnings without failing', async () => {
	const root = makeWorktree();
	const file = 'services/billing/src/local.ts';
	const absolute = path.join(root, file);
	const executions = [];
	const candidates = [];
	try {
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, "import { value } from './value';\n", 'utf8');
		const runtime = {
			registry: {
				loadPipeline: () => [
					{
						roleId: 'architect',
						role: {
							roleId: 'architect',
							modelProfile: 'agent-sdlc-deterministic',
							capabilityId: 'architect-analysis-v1',
							evaluatorId: 'architect-evaluation-v1',
						},
						promptPolicy: {},
					},
				],
			},
			runtimeStore: {
				listOptionalRoleExecutions: () => [],
				saveOptionalRoleExecution: (record) => executions.push(record),
				recordCandidateLearning: (candidate) => candidates.push(candidate),
				appendEvent: () => {},
			},
			now: () => '2026-09-12T00:00:00.000Z',
			onBoundary: async () => {},
		};
		const result = await executeRolePipeline({
			insertionPoint: 'pre_review',
			runtime,
			snapshot: {
				runId: '2026-09-12-pipeline-architect',
				runtimeRevision: 3,
				worktreePath: root,
			},
			taskId: 'task-architect',
			generation: 1,
			touchedFiles: [file],
		});
		assert.equal(result.status, 'PASS');
		assert.equal(executions[0].status, 'passed');
		assert.equal(JSON.parse(executions[0].structuredFindingsJson).violations[0].severity, 'P2');
		assert.equal(candidates.length, 1);
		assert.equal(candidates[0].taskId, 'task-architect');
		assert.equal(candidates[0].sourceRole, 'architect');
		assert.equal(candidates[0].type, 'architecture');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-05 @case AC-05.3 a hardener evaluation error saves a failed record and rethrows', async () => {
	const executions = [];
	const executedRoles = [];
	const runtime = {
		runtimeStore: {
			saveOptionalRoleExecution: (record) => executions.push(record),
			appendEvent: () => {},
		},
		now: () => '2026-09-12T00:00:00.000Z',
		onBoundary: async () => {},
	};
	await assert.rejects(
		() => runDeterministicAnalysisRole({
			roleId: 'hardener',
			evaluator: { evaluate() { throw new Error('boom'); } },
			diff: '',
			touchedFiles: [],
			snapshot: { runId: 'run-hardener', runtimeRevision: 1 },
			runtime,
			taskId: 'task-h',
			insertionPoint: 'post_implement',
			generation: 0,
			startTime: Date.now(),
			executedRoles,
		}),
		(error) => error.message === 'boom',
	);
	assert.equal(executions.length, 1);
	assert.equal(executions[0].status, 'failed');
	assert.match(executions[0].summary, /^Hardener evaluation failed:/);
	assert.equal(executedRoles.length, 0);
});
