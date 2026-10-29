import '../../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { runCli } from '../cli.ts';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import { buildTaskPromptContexts } from '../../workflow/nodes/execute-tasks.ts';
import { planTaskDag } from '../../policy/task-planner.ts';
import { slug, throwingGovernor, runInventory, completeSpecJson, runCheckSpec } from '../../testing/cli-test-support.mjs';

test('@ac AC-02 bounded manifest readiness reports score, change class, and risk without model dispatch', async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-bounded-ready-'));
	try {
		const goalFile = path.join(tempDir, 'goal.json');
		const manifestFile = path.join(tempDir, 'tasks.json');
		fs.writeFileSync(
			goalFile,
			JSON.stringify(
				completeSpecJson({
					touchedSurfaces: ['tools/agent-sdlc'],
				}),
			),
		);
		fs.writeFileSync(
			manifestFile,
			JSON.stringify({
				schemaVersion: '1.0.0',
				slices: [
					{
						sliceId: 'behavior',
						kind: 'vertical',
						goal: 'Ship the CLI behavior',
						acceptanceCriteria: ['AC-01'],
						dependsOn: [],
					},
				],
				tasks: [
					{
						taskId: 'behavior-task',
						sliceId: 'behavior',
						targetPackage: 'tools',
						authoredPaths: ['tools/agent-sdlc/cli/cli.mjs'],
						pathPrefixes: ['tools/agent-sdlc'],
						generatedOutputs: [],
						dependsOn: [],
						deliveryLayers: ['tooling'],
						dependencyMutations: [],
						shadowPaths: {
							unhappy: 'invalid input',
							timeout: 'deadline',
							empty: 'no delta',
							boundary: 'scope escape',
						},
						verificationCommand: ['pnpm', 'run', 'test:unit'],
						generatorCommand: null,
					},
				],
			}),
		);
		const outcome = await runCheckSpec([
			'--goal-file',
			goalFile,
			'--task-plan-file',
			manifestFile,
			'--json',
		]);
		assert.equal(outcome.exitCode, 0);
		assert.equal(outcome.result.ready, true);
		assert.equal(outcome.result.taskReadiness.tasks[0].complexityScore, 4);
		assert.equal(outcome.result.taskReadiness.tasks[0].changeClass, 'B');
		assert.equal(outcome.result.taskReadiness.tasks[0].highRisk, false);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-01 oversized readiness fails before run creation or model dispatch', async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-bounded-plan-'));
	try {
		const goalFile = path.join(tempDir, 'oversized.json');
		const oversized = completeSpecJson({
			touchedSurfaces: Array.from(
				{ length: 6 },
				(_, index) => `tools/agent-sdlc/oversized-${index}/file.mjs`,
			),
		});
		fs.writeFileSync(goalFile, JSON.stringify(oversized));
		const checked = await runCheckSpec(['--goal-file', goalFile, '--json']);
		assert.equal(checked.exitCode, 64);
		assert.equal(checked.result.error.code, 'TASK_DECOMPOSITION_REQUIRED');
		assert.match(checked.result.error.message, /pathPrefixes=6/);
		assert.deepEqual(checked.result.error.metadata.exceededLimits, [
			{
				taskId: 'task-0',
				sliceId: 'implicit-vertical',
				complexityScore: 9,
				exceededLimits: [
					{ dimension: 'pathPrefixes', actual: 6, maximum: 5 },
				],
			},
		]);
		assert.match(checked.human, /exceededLimits:\n  task-0: pathPrefixes=6/);

		const slug = `bounded-plan-${crypto.randomUUID().slice(0, 8)}`;
		const before = runInventory();
		const started = await runCli(
			['start', '--slug', slug, '--goal-file', goalFile, '--json'],
			{ rootDir: REPOSITORY_ROOT, governor: throwingGovernor() },
		);
		assert.equal(started.exitCode, 64);
		assert.equal(started.result.error.code, 'TASK_DECOMPOSITION_REQUIRED');
		assert.deepEqual(runInventory(), before);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-16 manifest-less planning preserves executable verification and draft criteria', () => {
	const draft = completeSpecJson({
		goal: 'Update the conditioning domain.',
		touchedSurfaces: ['apps/services/conditioning/src/conditioning/domain'],
	});
	const plan = planTaskDag({
		draft,
		authorization: {
			runId: `2026-09-29-manifestless-${crypto.randomUUID().slice(0, 8)}`,
			baseCommitSha: 'a'.repeat(40),
			allowedPackages: ['apps/services/conditioning'],
			allowedPathPrefixes: ['apps/services/conditioning/src/conditioning/domain'],
		},
		now: () => '2026-09-29T00:00:00.000Z',
	});
	const task = plan.tasks[0];
	const context = buildTaskPromptContexts({ draft, taskPlan: plan })[task.taskId];

	assert.equal(task.taskId, 'task-0');
	assert.equal(task.worktreeSubdir, 'worktree');
	assert.equal(plan.isParallel, false);
	assert.equal(task.sliceId, 'implicit-vertical');
	assert.deepEqual(context.acceptanceCriteria, draft.acceptanceCriteria);
	assert.deepEqual(context.verificationCommand, [
		'pnpm',
		'--filter',
		'@example/conditioning-service',
		'test',
	]);
});

test('@ac AC-19 legal dimensions with score 21 require decomposition', async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-score-plan-'));
	try {
		const goalFile = path.join(tempDir, 'goal.json');
		const manifestFile = path.join(tempDir, 'plan.json');
		const acceptanceCriteria = Array.from(
			{ length: 5 },
			(_, index) =>
				`AC-${String(index + 1).padStart(2, '0')}: Criterion ${index + 1} holds. Given bounded input. Then output is deterministic.`,
		);
		fs.writeFileSync(
			goalFile,
			JSON.stringify(
				completeSpecJson({
					touchedSurfaces: ['tools'],
					acceptanceCriteria,
				}),
			),
		);
		fs.writeFileSync(
			manifestFile,
			JSON.stringify({
				schemaVersion: '1.0.0',
				slices: [
					{
						sliceId: 'behavior',
						kind: 'vertical',
						goal: 'Deliver behavior',
						acceptanceCriteria: acceptanceCriteria.map((_, index) =>
							`AC-${String(index + 1).padStart(2, '0')}`),
						dependsOn: [],
					},
				],
				tasks: [
					{
						taskId: 'behavior-task',
						sliceId: 'behavior',
						targetPackage: 'tools',
						authoredPaths: [
							...Array.from(
								{ length: 7 },
								(_, index) => `tools/agent-sdlc/file-${index}.mjs`,
							),
							'tools/package.json',
						],
						pathPrefixes: ['tools'],
						generatedOutputs: [],
						dependsOn: [],
						deliveryLayers: ['tooling', 'documentation', 'configuration'],
						dependencyMutations: [
							{
								manifestPath: 'tools/package.json',
								dependencyName: 'example',
								fromRange: '1.0.0',
								toRange: '1.0.1',
							},
						],
						shadowPaths: {
							unhappy: 'failure',
							timeout: 'timeout',
							empty: 'empty',
							boundary: 'boundary',
						},
						verificationCommand: ['pnpm', 'run', 'test:unit'],
						generatorCommand: null,
					},
				],
			}),
		);
		const outcome = await runCheckSpec([
			'--goal-file',
			goalFile,
			'--task-plan-file',
			manifestFile,
			'--json',
		]);
		assert.equal(outcome.exitCode, 64);
		assert.equal(outcome.result.error.code, 'TASK_DECOMPOSITION_REQUIRED');
		assert.match(outcome.result.error.message, /complexityScore=21/);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-20 disconnected slice task fails before run creation or model dispatch', async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-slice-reachability-'));
	try {
		const goalFile = path.join(tempDir, 'goal.json');
		const manifestFile = path.join(tempDir, 'plan.json');
		fs.writeFileSync(
			goalFile,
			JSON.stringify(
				completeSpecJson({
					touchedSurfaces: ['tools/agent-sdlc'],
				}),
			),
		);
		const task = (taskId, sliceId, dependsOn = []) => ({
			taskId,
			sliceId,
			targetPackage: 'tools',
			authoredPaths: ['tools/agent-sdlc/policy/task-planner.mjs'],
			pathPrefixes: ['tools/agent-sdlc'],
			generatedOutputs: [],
			dependsOn,
			deliveryLayers: ['tooling'],
			dependencyMutations: [],
			shadowPaths: {
				unhappy: 'failure',
				timeout: 'timeout',
				empty: 'empty',
				boundary: 'boundary',
			},
			verificationCommand: ['pnpm', 'run', 'test:unit'],
			generatorCommand: null,
		});
		fs.writeFileSync(
			manifestFile,
			JSON.stringify({
				schemaVersion: '1.0.0',
				slices: [
					{
						sliceId: 'foundation',
						kind: 'enabling',
						goal: 'Prepare foundation',
						acceptanceCriteria: [],
						dependsOn: [],
					},
					{
						sliceId: 'behavior',
						kind: 'vertical',
						goal: 'Deliver behavior',
						acceptanceCriteria: ['AC-01'],
						dependsOn: ['foundation'],
					},
				],
				tasks: [
					task('foundation-task', 'foundation'),
					task('behavior-task', 'behavior'),
				],
			}),
		);
		const outcome = await runCheckSpec([
			'--goal-file',
			goalFile,
			'--task-plan-file',
			manifestFile,
			'--json',
		]);
		assert.equal(outcome.exitCode, 64);
		assert.equal(outcome.result.error.code, 'TASK_PLAN_INVALID');
		assert.match(outcome.result.error.message, /behavior-task/);
		assert.match(outcome.result.error.message, /foundation/);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
