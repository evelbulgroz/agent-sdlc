import '../../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson, sha256 } from '../contracts.ts';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import { completeSpecJson } from '../../testing/cli-test-support.mjs';
import { deriveTaskId, evaluateTaskReadiness } from './task-readiness.ts';
import {
	nineAuthoredPathReadinessInput,
	pinnedManifestReadinessInput,
	pinnedManifestlessReadinessInput,
	readinessDraft,
	serialManifest,
} from '../../testing/task-planner-fixtures.mjs';

function runCheckSpecCli(args) {
	const result = spawnSync(
		process.execPath,
		[fileURLToPath(new URL('../../cli/cli.ts', import.meta.url)), 'check-spec', ...args],
		{ cwd: REPOSITORY_ROOT, encoding: 'utf8', timeout: 60_000 },
	);
	return { status: result.status, parsed: JSON.parse(result.stdout) };
}

test('manifest-less readiness preserves touched surfaces and derives deterministic evidence', () => {
	const readiness = evaluateTaskReadiness({ draft: readinessDraft() });
	assert.equal(readiness.tasks.length, 1);
	assert.equal(readiness.tasks[0].taskId, 'task-0');
	assert.deepEqual(readiness.tasks[0].authoredPaths, [
		'tools/agent-sdlc/policy/task-planner.mjs',
	]);
	assert.deepEqual(readiness.tasks[0].pathPrefixes, [
		'tools/agent-sdlc/policy',
	]);
	assert.deepEqual(readiness.tasks[0].deliveryLayers, ['tooling']);
	assert.deepEqual(readiness.tasks[0].verificationCommand, [
		'pnpm',
		'run',
		'test:unit',
	]);
	assert.equal(readiness.tasks[0].complexityScore, 4);
});

test('@ac AC-04 manifestless planning collapses 6 authored paths under 3 directories into at most 5 pathPrefixes', () => {
	const readiness = evaluateTaskReadiness({
		draft: readinessDraft({
			touchedSurfaces: [
				'tools/agent-sdlc/file-a.mjs',
				'tools/agent-sdlc/file-b.mjs',
				'tools/agent-sdlc/adapters/file-c.mjs',
				'tools/agent-sdlc/adapters/file-d.mjs',
				'tools/agent-sdlc/testing/file-e.mjs',
				'tools/agent-sdlc/testing/file-f.mjs',
			],
		}),
	});

	assert.equal(readiness.tasks.length, 1);
	assert.deepEqual(readiness.tasks[0].pathPrefixes, [
		'tools/agent-sdlc',
		'tools/agent-sdlc/adapters',
		'tools/agent-sdlc/testing',
	]);
	assert.ok(readiness.tasks[0].pathPrefixes.length <= 5);
});

test('@ac AC-04 a set of paths spanning more than 5 distinct directories still requires decomposition', () => {
	assert.throws(
		() =>
			evaluateTaskReadiness({
				draft: readinessDraft({
					touchedSurfaces: Array.from(
						{ length: 6 },
						(_, index) => `tools/agent-sdlc/dir-${index}/file.mjs`,
					),
				}),
			}),
		(error) =>
			error.code === 'TASK_DECOMPOSITION_REQUIRED' &&
			error.message.includes('pathPrefixes=6'),
	);
});

test('manifest readiness rejects cross-package authored paths and lockfile ownership without a dependency mutation', () => {
	const crossPackage = serialManifest();
	crossPackage.tasks[0].authoredPaths.push(
		'services/assessment/src/assessment/application/use-case.ts',
	);
	assert.throws(
		() =>
			evaluateTaskReadiness({
				draft: readinessDraft({
					touchedSurfaces: [
						'services/billing/src/billing/domain',
						'services/assessment/src/assessment/application/use-case.ts',
					],
				}),
				taskManifest: crossPackage,
			}),
		(error) =>
			error.code === 'TASK_PLAN_INVALID' &&
			error.message.includes("does not own 'services/assessment"),
	);

	const undeclaredLockfile = serialManifest();
	undeclaredLockfile.tasks[0].generatedOutputs = ['pnpm-lock.yaml'];
	assert.throws(
		() =>
			evaluateTaskReadiness({
				draft: readinessDraft({
					touchedSurfaces: [
						'services/billing/src/billing/domain',
						'pnpm-lock.yaml',
					],
				}),
				taskManifest: undeclaredLockfile,
			}),
		(error) =>
			error.code === 'TASK_PLAN_INVALID' &&
			error.message.includes('only with a declared dependency mutation'),
	);
});

test('dependency mutation manifests must be owned by the task authored paths', () => {
	const base = serialManifest();
	const task = {
		...base.tasks[0],
		pathPrefixes: ['services/billing'],
		dependencyMutations: [
			{
				manifestPath: 'services/billing/package.json',
				dependencyName: 'example',
				fromRange: '^1.0.0',
				toRange: '^1.1.0',
			},
		],
	};
	assert.throws(
		() =>
			evaluateTaskReadiness({
				draft: readinessDraft({
					touchedSurfaces: ['services/billing'],
				}),
				taskManifest: {
					...base,
					tasks: [task],
				},
			}),
		(error) =>
			error.code === 'TASK_PLAN_INVALID' &&
			error.message.includes('dependency manifest') &&
			error.message.includes(task.dependencyMutations[0].manifestPath),
	);
});

test('@ac AC-08 orphan enabling slices fail task readiness', () => {
	const manifest = serialManifest({
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
				dependsOn: [],
			},
		],
		tasks: [
			{ ...serialManifest().tasks[0], sliceId: 'foundation' },
			serialManifest().tasks[1],
		],
	});
	assert.throws(
		() =>
			evaluateTaskReadiness({
				draft: readinessDraft({
					touchedSurfaces: ['services/billing/src/billing/domain'],
				}),
				taskManifest: manifest,
			}),
		(error) =>
			error.code === 'TASK_PLAN_INVALID' &&
			error.message.includes("Enabling slice 'foundation'"),
	);
});

test('slice dependencies require executable task reachability', () => {
	const base = serialManifest();
	const manifest = {
		...base,
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
			{ ...base.tasks[0], sliceId: 'foundation' },
			{ ...base.tasks[1], dependsOn: [] },
		],
	};
	assert.throws(
		() =>
			evaluateTaskReadiness({
				draft: readinessDraft({
					touchedSurfaces: ['services/billing/src/billing/domain'],
				}),
				taskManifest: manifest,
			}),
		(error) =>
			error.code === 'TASK_PLAN_INVALID' &&
			error.message.includes("'behavior-activation'") &&
			error.message.includes("'behavior'") &&
			error.message.includes("'foundation'"),
	);
});

test('validateExecutableSliceDag rejects concurrent tasks with overlapping paths', () => {
	const base = serialManifest();
	const manifest = {
		...base,
		slices: [
			{
				sliceId: 'slice-a',
				kind: 'vertical',
				goal: 'Slice A',
				acceptanceCriteria: ['AC-01'],
				dependsOn: [],
			},
			{
				sliceId: 'slice-b',
				kind: 'vertical',
				goal: 'Slice B',
				acceptanceCriteria: ['AC-02'],
				dependsOn: [],
			},
		],
		tasks: [
			{
				...base.tasks[0],
				taskId: 'task-a',
				sliceId: 'slice-a',
				dependsOn: [],
				pathPrefixes: ['services/billing/src'],
			},
			{
				...base.tasks[1],
				taskId: 'task-b',
				sliceId: 'slice-b',
				dependsOn: [],
				pathPrefixes: ['services/billing/src/helpers'],
			},
		],
	};
	assert.throws(
		() =>
			evaluateTaskReadiness({
				draft: readinessDraft({
					acceptanceCriteria: ['AC-01: first', 'AC-02: second'],
					touchedSurfaces: ['services/billing/src'],
				}),
				taskManifest: manifest,
			}),
		(error) =>
			error.code === 'TASK_PLAN_INVALID' &&
			error.message.includes("Concurrent tasks 'task-a' and 'task-b' have overlapping paths"),
	);
});

test('@ac AC-13 high-risk task protections are derived and cannot be downgraded by input', () => {
	const base = serialManifest();
	const taskManifest = {
		...base,
		tasks: [
			{
				...base.tasks[0],
				targetPackage: 'services/authentication',
				authoredPaths: ['services/authentication/src/authentication.service.ts'],
				pathPrefixes: ['services/authentication/src'],
				verificationCommand: [
					'pnpm',
					'--filter',
					'@fixture/authentication-service',
					'test',
				],
			},
		],
	};
	const readiness = evaluateTaskReadiness({
		draft: readinessDraft({
			touchedSurfaces: ['services/authentication/src'],
		}),
		taskManifest,
		workspacePackages: {
			packageMap: new Map([
				[
					'@fixture/authentication-service',
					{
						dir: 'services/authentication',
						pkgJson: {
							name: '@fixture/authentication-service',
							scripts: { test: 'node --test' },
						},
					},
				],
			]),
			pathToPackage: new Map([
				['services/authentication', '@fixture/authentication-service'],
			]),
		},
	});
	const task = readiness.tasks[0];
	assert.equal(task.highRisk, true);
	assert.equal(task.maxAutonomousRepairs, 0);
	assert.equal(task.humanReviewEvidence, 'required_pending');
	assert.equal(task.changeClass, 'A');
	assert.throws(
		() =>
			evaluateTaskReadiness({
				draft: readinessDraft({
					touchedSurfaces: ['services/authentication/src'],
				}),
				taskManifest: {
					...taskManifest,
					tasks: [{ ...taskManifest.tasks[0], maxAutonomousRepairs: 2 }],
				},
			}),
		(error) => error.code === 'INVALID_CONTRACT',
	);
});

test('deriveTaskId produces valid, secret-safe task IDs', () => {
	assert.equal(deriveTaskId('services/billing'), 'billing-task');
	assert.equal(deriveTaskId('packages/shared-base'), 'shared-base-task');
	assert.equal(deriveTaskId('frontends/example-pwa-frontend'), 'example-pwa-frontend-task');

	// Regex format compliance

	// Regex format compliance
	const taskId = deriveTaskId('services/billing');
	assert.match(taskId, /^[a-z0-9][a-z0-9-]{0,63}$/);
});

test('readinessDraft with no overrides keeps the default goal and one criterion', () => {
	const draft = readinessDraft();
	assert.equal(draft.goal, 'Deliver bounded behavior');
	assert.equal(draft.acceptanceCriteria.length, 1);
	assert.equal(draft.touchedSurfaces.length, 1);
});

test('@ac AC-06 @case AC-06.1 the manifest-less readiness hash stays pinned', () => {
	const readiness = evaluateTaskReadiness(pinnedManifestlessReadinessInput());
	assert.equal(
		sha256(canonicalJson(readiness)),
		'2378eb1c525ed93cfdaa9650544fb449cb94940f3c9ed5f16c41589233284519',
	);
});

test('@ac AC-06 @case AC-06.2 the manifest readiness hash stays pinned', () => {
	const readiness = evaluateTaskReadiness(pinnedManifestReadinessInput());
	assert.equal(
		sha256(canonicalJson(readiness)),
		'00d14a2bfc3b5d7bce95bf6248a89b3b21ce8ee7fc3bd7266084a765d930d109',
	);
});

test('@ac AC-06 @case AC-06.3 nine authored paths require decomposition with the same details', () => {
	assert.throws(
		() => evaluateTaskReadiness(nineAuthoredPathReadinessInput()),
		(error) => {
			assert.equal(error.code, 'TASK_DECOMPOSITION_REQUIRED');
			assert.equal(
				error.message,
				'Task decomposition required; exceeded limits: behavior-task: authoredPaths=9 (max 8)',
			);
			assert.deepEqual(error.metadata.exceededLimits, [
				{
					taskId: 'behavior-task',
					sliceId: 'behavior',
					complexityScore: 12,
					exceededLimits: [{ dimension: 'authoredPaths', actual: 9, maximum: 8 }],
				},
			]);
			return true;
		},
	);
});

test('@ac AC-06 @case AC-06.4 check-spec on a ready goal and manifest exits 0', () => {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-ready-spec-'));
	try {
		const goal = path.join(temp, 'goal.json');
		const manifest = path.join(temp, 'tasks.json');
		fs.writeFileSync(
			goal,
			JSON.stringify(completeSpecJson({ touchedSurfaces: ['tools/agent-sdlc'] })),
		);
		fs.writeFileSync(
			manifest,
			JSON.stringify(pinnedManifestReadinessInput().taskManifest),
		);
		const outcome = runCheckSpecCli([
			'--goal-file',
			goal,
			'--task-plan-file',
			manifest,
			'--json',
		]);
		assert.equal(outcome.status, 0);
		assert.equal(outcome.parsed.ok, true);
		assert.equal(outcome.parsed.ready, true);
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}
});

test('@ac AC-06 @case AC-06.5 check-spec on the oversized manifest exits 64', () => {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-oversized-spec-'));
	try {
		const goal = path.join(temp, 'goal.json');
		const manifest = path.join(temp, 'tasks.json');
		fs.writeFileSync(
			goal,
			JSON.stringify(completeSpecJson({ touchedSurfaces: ['tools/agent-sdlc'] })),
		);
		fs.writeFileSync(
			manifest,
			JSON.stringify(nineAuthoredPathReadinessInput().taskManifest),
		);
		const outcome = runCheckSpecCli([
			'--goal-file',
			goal,
			'--task-plan-file',
			manifest,
			'--json',
		]);
		assert.equal(outcome.status, 64);
		assert.equal(outcome.parsed.ok, false);
		assert.equal(outcome.parsed.error.code, 'TASK_DECOMPOSITION_REQUIRED');
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}
});
