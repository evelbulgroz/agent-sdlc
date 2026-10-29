import '../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { planTaskDag } from './task-planner.ts';
import * as taskPlanner from './task-planner.ts';
import { evaluatePolicyGate } from './policy-gate.ts';
import {
	BASE_COMMIT_SHA,
	RUN_ID,
	pinnedManifestPlanInput,
	pinnedMultiPlanInput,
	pinnedSinglePlanInput,
	readinessDraft,
	serialManifest,
} from '../testing/task-planner-fixtures.mjs';

const FROZEN_PLANNER_EXPORTS = [
	'DEFAULT_SHADOW_PATHS',
	'TASK_FEASIBILITY_LIMITS',
	'classifyTaskChange',
	'deriveTaskId',
	'evaluateTaskReadiness',
	'isContractProducerSurface',
	'planTaskDag',
	'scanWorkspacePackages',
	'sortTasksTopologically',
];

// execute-tasks.mjs already imports the preserving-refactor helpers. workflow/ is
// outside this spec, so those pre-split names stay on the facade.
const PRESERVED_PLANNER_EXPORTS = [
	'assertContractPreservingIntegration',
	'contractArtifactPaths',
	'contractVerificationCommandsForTask',
	'isContractPreservingRefactor',
	'missingContractCommands',
];

test('manifest planning supports serial overlapping tasks in one package', () => {
	const manifest = serialManifest();
	const authorization = {
		runId: RUN_ID,
		baseCommitSha: BASE_COMMIT_SHA,
		taskManifestHash: 'f'.repeat(64),
		allowedPackages: ['services/billing'],
		allowedPathPrefixes: ['services/billing'],
	};
	const plan = planTaskDag({
		draft: readinessDraft({
			touchedSurfaces: ['services/billing/src/billing/domain'],
		}),
		taskManifest: manifest,
		authorization,
		now: () => '2026-09-07T09:00:00.000Z',
	});
	assert.equal(plan.isParallel, false);
	assert.deepEqual(plan.integrationOrder, [
		'behavior-foundation',
		'behavior-activation',
	]);
	assert.equal(plan.tasks[0].worktreeSubdir, 'worktrees/behavior-foundation');
	assert.equal(plan.tasks[1].worktreeSubdir, 'worktrees/behavior-activation');
	assert.equal(plan.tasks[1].sliceId, 'behavior');
	assert.equal(plan.taskManifestHash, 'f'.repeat(64));
	assert.doesNotThrow(() => evaluatePolicyGate({ taskPlan: plan, authorization }));
});

test('planTaskDag produces an executable manifest-less task with legacy worktree shape', () => {
	const auth = {
		runId: RUN_ID,
		baseCommitSha: BASE_COMMIT_SHA,
		allowedPackages: ['services/billing'],
		allowedPathPrefixes: ['services/billing/src/billing/'],
	};

	const plan = planTaskDag({
		draft: readinessDraft({
			goal: 'Update billing domain',
			touchedSurfaces: ['services/billing/src/billing/domain'],
		}),
		authorization: auth,
		now: () => '2026-09-07T09:00:00.000Z',
	});

	assert.equal(plan.runId, RUN_ID);
	assert.equal(plan.isParallel, false);
	assert.equal(plan.tasks.length, 1);
	assert.deepEqual(plan.integrationOrder, ['task-0']);

	const task = plan.tasks[0];
	assert.equal(task.taskId, 'task-0');
	assert.equal(task.targetPackage, 'services/billing');
	assert.equal(task.worktreeSubdir, 'worktree');
	assert.equal(task.integrationOrder, 0);
	assert.deepEqual(task.dependsOn, []);
	assert.equal(task.status, 'pending');
	assert.equal(task.sliceId, 'implicit-vertical');
	assert.deepEqual(task.acceptanceCriteria, ['AC-01']);
	assert.deepEqual(task.verificationCommand, [
		'pnpm',
		'--filter',
		'@fixture/billing-service',
		'test',
	]);
	assert.deepEqual(plan.slices?.[0].acceptanceCriteria, ['AC-01']);
	assert.match(plan.planPolicyHash, /^[a-f0-9]{64}$/);
});

test('planTaskDag produces a multi-task plan with lexicographical order for independent packages', () => {
	const auth = {
		runId: RUN_ID,
		baseCommitSha: BASE_COMMIT_SHA,
		allowedPackages: ['services/billing', 'services/assessment'],
		allowedPathPrefixes: [
			'services/billing/src/',
			'services/assessment/src/',
		],
	};

	const plan = planTaskDag({
		draft: { title: 'Refactor independent services' },
		authorization: auth,
		now: () => '2026-09-07T09:00:00.000Z',
	});

	assert.equal(plan.isParallel, true);
	assert.equal(plan.tasks.length, 2);

	// Lexicographical tie-break: assessment-task comes before billing-task
	assert.deepEqual(plan.integrationOrder, ['assessment-task', 'billing-task']);

	const task0 = plan.tasks[0];
	assert.equal(task0.taskId, 'assessment-task');
	assert.equal(task0.integrationOrder, 0);
	assert.equal(task0.worktreeSubdir, 'worktrees/assessment-task');
	assert.deepEqual(task0.dependsOn, []);

	const task1 = plan.tasks[1];
	assert.equal(task1.taskId, 'billing-task');
	assert.equal(task1.integrationOrder, 1);
	assert.equal(task1.worktreeSubdir, 'worktrees/billing-task');
	assert.deepEqual(task1.dependsOn, []);
});

test('planTaskDag serializes shared packages under packages/* before consumers', () => {
	const auth = {
		runId: RUN_ID,
		baseCommitSha: BASE_COMMIT_SHA,
		allowedPackages: ['services/billing', 'packages/shared-base'],
		allowedPathPrefixes: [
			'services/billing/src/',
			'packages/shared-base/src/',
		],
	};

	const plan = planTaskDag({
		draft: { title: 'Update shared-base and billing' },
		authorization: auth,
		now: () => '2026-09-07T09:00:00.000Z',
	});

	assert.equal(plan.isParallel, false);
	assert.equal(plan.tasks.length, 2);

	// shared-base-task must be serialized before billing-task
	assert.deepEqual(plan.integrationOrder, ['shared-base-task', 'billing-task']);

	const dddTask = plan.tasks.find((t) => t.taskId === 'shared-base-task');
	const condTask = plan.tasks.find((t) => t.taskId === 'billing-task');

	assert.equal(dddTask.integrationOrder, 0);
	assert.deepEqual(dddTask.dependsOn, []);

	assert.equal(condTask.integrationOrder, 1);
	assert.deepEqual(condTask.dependsOn, ['shared-base-task']);
});

test('planTaskDag serializes contract producers before consumer services', () => {
	const auth = {
		runId: RUN_ID,
		baseCommitSha: BASE_COMMIT_SHA,
		allowedPackages: ['services/billing', 'services/api-gateway'],
		allowedPathPrefixes: [
			'services/billing/contracts/index.ts',
			'services/api-gateway/src/',
		],
	};

	const plan = planTaskDag({
		draft: { title: 'Contract change in billing and gateway update' },
		authorization: auth,
		now: () => '2026-09-07T09:00:00.000Z',
	});

	assert.equal(plan.isParallel, false);
	assert.deepEqual(plan.integrationOrder, ['billing-task', 'api-gateway-task']);

	const condTask = plan.tasks.find((t) => t.taskId === 'billing-task');
	const gwTask = plan.tasks.find((t) => t.taskId === 'api-gateway-task');

	assert.equal(condTask.integrationOrder, 0);
	assert.equal(gwTask.integrationOrder, 1);
	assert.deepEqual(gwTask.dependsOn, ['billing-task']);
});

test('planTaskDag serializes contract producers with package-root prefixes before consumers', () => {
	const auth = {
		runId: RUN_ID,
		baseCommitSha: BASE_COMMIT_SHA,
		allowedPackages: ['services/registry', 'services/api-gateway'],
		allowedPathPrefixes: [
			'services/registry',
			'services/api-gateway',
		],
	};

	const plan = planTaskDag({
		draft: { title: 'Registry package-root and gateway' },
		authorization: auth,
		now: () => '2026-09-07T09:00:00.000Z',
	});

	assert.equal(plan.isParallel, false);
	assert.deepEqual(plan.integrationOrder, ['registry-task', 'api-gateway-task']);

	const regTask = plan.tasks.find((t) => t.taskId === 'registry-task');
	const gwTask = plan.tasks.find((t) => t.taskId === 'api-gateway-task');

	assert.equal(regTask.integrationOrder, 0);
	assert.equal(gwTask.integrationOrder, 1);
	assert.deepEqual(gwTask.dependsOn, ['registry-task']);
});

test('planTaskDag is strictly deterministic across multiple invocations', () => {
	const auth = {
		runId: RUN_ID,
		baseCommitSha: BASE_COMMIT_SHA,
		allowedPackages: ['services/billing', 'packages/shared-base', 'services/assessment'],
		allowedPathPrefixes: [
			'services/billing/src/',
			'packages/shared-base/src/',
			'services/assessment/src/',
		],
	};

	const plan1 = planTaskDag({ authorization: auth, now: () => '2026-09-07T09:00:00.000Z' });
	const plan2 = planTaskDag({ authorization: auth, now: () => '2026-09-07T09:00:00.000Z' });

	assert.equal(plan1.planPolicyHash, plan2.planPolicyHash);
	assert.deepEqual(plan1.integrationOrder, plan2.integrationOrder);
	assert.deepEqual(plan1.tasks, plan2.tasks);
});

test('planTaskDag assigns pnpm-lock.yaml to the task targeting package.json when authorized', () => {
	const auth = {
		runId: RUN_ID,
		baseCommitSha: BASE_COMMIT_SHA,
		allowedPackages: ['packages/shared-base', 'services/authentication'],
		allowedPathPrefixes: [
			'packages/shared-base/package.json',
			'pnpm-lock.yaml',
			'packages/shared-base/src/',
			'services/authentication/src/',
		],
	};

	const plan = planTaskDag({
		draft: { title: 'Update shared-base manifest and authentication' },
		authorization: auth,
		now: () => '2026-09-07T09:00:00.000Z',
	});

	const dddTask = plan.tasks.find((t) => t.targetPackage === 'packages/shared-base');
	const authTask = plan.tasks.find((t) => t.targetPackage === 'services/authentication');
	assert.ok(dddTask);
	assert.ok(authTask);
	assert.ok(dddTask.pathPrefixes.includes('pnpm-lock.yaml'));
	assert.ok(!authTask.pathPrefixes.includes('pnpm-lock.yaml'));
});

test('planTaskDag serializes independent package manifest tasks that share pnpm-lock.yaml', () => {
	const auth = {
		runId: RUN_ID,
		baseCommitSha: BASE_COMMIT_SHA,
		allowedPackages: [
			'services/strength',
			'services/assessment',
			'services/journal',
		],
		allowedPathPrefixes: [
			'services/strength/package.json',
			'services/assessment/package.json',
			'services/journal/package.json',
			'pnpm-lock.yaml',
		],
	};

	const plan = planTaskDag({
		draft: { title: 'Upgrade package dependencies' },
		authorization: auth,
		now: () => '2026-09-07T09:00:00.000Z',
	});

	assert.deepEqual(plan.integrationOrder, [
		'assessment-task',
		'journal-task',
		'strength-task',
	]);
	assert.deepEqual(
		plan.tasks.find((task) => task.taskId === 'assessment-task').dependsOn,
		[],
	);
	assert.deepEqual(
		plan.tasks.find((task) => task.taskId === 'journal-task').dependsOn,
		['assessment-task'],
	);
	assert.deepEqual(
		plan.tasks.find((task) => task.taskId === 'strength-task').dependsOn,
		['journal-task'],
	);
	assert.doesNotThrow(() =>
		evaluatePolicyGate({
			taskPlan: plan,
			authorization: auth,
		}),
	);
});

test('planTaskDag grants lockfile ownership to a package-root task that can modify its manifest', () => {
	const auth = {
		runId: RUN_ID,
		baseCommitSha: BASE_COMMIT_SHA,
		allowedPackages: ['services/billing', 'services/assessment'],
		allowedPathPrefixes: [
			'services/billing',
			'services/assessment/package.json',
			'pnpm-lock.yaml',
		],
	};

	const plan = planTaskDag({
		draft: { title: 'Upgrade billing and assessment dependencies' },
		authorization: auth,
		now: () => '2026-09-07T09:00:00.000Z',
	});

	const billingTask = plan.tasks.find((task) => task.taskId === 'billing-task');
	assert.ok(billingTask.pathPrefixes.includes('pnpm-lock.yaml'));
	assert.doesNotThrow(() =>
		evaluatePolicyGate({
			taskPlan: plan,
			authorization: auth,
		}),
	);
});

test('@ac AC-04 @case AC-04.2 the facade exports the frozen planner names', () => {
	assert.deepEqual(
		Object.keys(taskPlanner).sort(),
		[...FROZEN_PLANNER_EXPORTS, ...PRESERVED_PLANNER_EXPORTS].sort(),
	);
});

test('@ac AC-05 @case AC-05.1 the manifest branch returns the pinned planPolicyHash', () => {
	const plan = planTaskDag(pinnedManifestPlanInput());
	assert.equal(
		plan.planPolicyHash,
		'a1e949e4206c747c0f70f6287b112b899355bc850bf4e02ee6edf3ef107e875d',
	);
});

test('@ac AC-05 @case AC-05.2 the single-package branch returns the pinned planPolicyHash', () => {
	const plan = planTaskDag(pinnedSinglePlanInput());
	assert.equal(
		plan.planPolicyHash,
		'636a3b67e0e43cfa577ec165a3220bcf4e9fe19c6e8b13560a287470202fe744',
	);
});

test('@ac AC-05 @case AC-05.3 the multi-package branch returns the pinned planPolicyHash', () => {
	const plan = planTaskDag(pinnedMultiPlanInput());
	assert.equal(
		plan.planPolicyHash,
		'6f32887f0e684fa9364dfdb0049596bf4bcd29a1f19da96e6fa2757dfac2d6b1',
	);
});

test('@ac AC-05 @case AC-05.4 the multi-package fixture returns the pinned integrationOrder and isParallel', () => {
	const plan = planTaskDag(pinnedMultiPlanInput());
	assert.equal(plan.isParallel, true);
	assert.deepEqual(plan.integrationOrder, ['assessment-task', 'billing-task']);
});
