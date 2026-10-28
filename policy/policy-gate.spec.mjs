import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePolicyGate } from './policy-gate.ts';

const BASE_COMMIT_SHA = 'a'.repeat(40);
const RUN_ID = '2026-09-07-test-policy-run';

test('evaluatePolicyGate passes a valid 1-task plan', () => {
	const plan = {
		schemaVersion: '1.0.0',
		runId: RUN_ID,
		planPolicyHash: 'p'.repeat(64),
		baseCommitSha: BASE_COMMIT_SHA,
		tasks: [
			{
				taskId: 'task-0',
				title: 'Conditioning refactor',
				targetPackage: 'apps/services/conditioning',
				pathPrefixes: ['apps/services/conditioning/src/'],
				dependsOn: [],
				status: 'pending',
				integrationOrder: 0,
				worktreeSubdir: 'worktree',
				baseCommitSha: BASE_COMMIT_SHA,
				parentTreeSha: null,
				targetTreeSha: null,
				patchHash: null,
				failurePacketArtifact: null,
				repairCount: 0,
			},
		],
		integrationOrder: ['task-0'],
		isParallel: false,
		createdAt: '2026-09-07T00:00:00.000Z',
	};

	const auth = {
		runId: RUN_ID,
		allowedPackages: ['apps/services/conditioning'],
		allowedPathPrefixes: ['apps/services/conditioning/src/'],
		baseCommitSha: BASE_COMMIT_SHA,
	};

	const result = evaluatePolicyGate({ taskPlan: plan, authorization: auth });
	assert.equal(result.passed, true);
	assert.equal(result.violations.length, 0);
});

test('evaluatePolicyGate passes independent multi-task plan with disjoint packages', () => {
	const plan = {
		schemaVersion: '1.0.0',
		runId: RUN_ID,
		planPolicyHash: 'p'.repeat(64),
		baseCommitSha: BASE_COMMIT_SHA,
		tasks: [
			{
				taskId: 'assessment-task',
				title: 'Assessment update',
				targetPackage: 'apps/services/assessment',
				pathPrefixes: ['apps/services/assessment/src/'],
				dependsOn: [],
				status: 'pending',
				integrationOrder: 0,
				worktreeSubdir: 'worktrees/assessment-task',
				baseCommitSha: BASE_COMMIT_SHA,
				parentTreeSha: null,
				targetTreeSha: null,
				patchHash: null,
				failurePacketArtifact: null,
				repairCount: 0,
			},
			{
				taskId: 'conditioning-task',
				title: 'Conditioning update',
				targetPackage: 'apps/services/conditioning',
				pathPrefixes: ['apps/services/conditioning/src/'],
				dependsOn: [],
				status: 'pending',
				integrationOrder: 1,
				worktreeSubdir: 'worktrees/conditioning-task',
				baseCommitSha: BASE_COMMIT_SHA,
				parentTreeSha: null,
				targetTreeSha: null,
				patchHash: null,
				failurePacketArtifact: null,
				repairCount: 0,
			},
		],
		integrationOrder: ['assessment-task', 'conditioning-task'],
		isParallel: true,
		createdAt: '2026-09-07T00:00:00.000Z',
	};

	const auth = {
		runId: RUN_ID,
		allowedPackages: ['apps/services/assessment', 'apps/services/conditioning'],
		allowedPathPrefixes: ['apps/services/assessment/src/', 'apps/services/conditioning/src/'],
		baseCommitSha: BASE_COMMIT_SHA,
	};

	const result = evaluatePolicyGate({ taskPlan: plan, authorization: auth });
	assert.equal(result.passed, true);
});

test('evaluatePolicyGate rejects cyclic task dependencies', () => {
	const cyclicPlan = {
		schemaVersion: '1.0.0',
		runId: RUN_ID,
		planPolicyHash: 'p'.repeat(64),
		baseCommitSha: BASE_COMMIT_SHA,
		tasks: [
			{
				taskId: 'task-a',
				title: 'Task A',
				targetPackage: 'apps/services/conditioning',
				pathPrefixes: ['apps/services/conditioning/src/'],
				dependsOn: ['task-b'],
				status: 'pending',
				integrationOrder: 0,
				worktreeSubdir: 'worktrees/task-a',
				baseCommitSha: BASE_COMMIT_SHA,
				parentTreeSha: null,
				targetTreeSha: null,
				patchHash: null,
				failurePacketArtifact: null,
				repairCount: 0,
			},
			{
				taskId: 'task-b',
				title: 'Task B',
				targetPackage: 'apps/services/assessment',
				pathPrefixes: ['apps/services/assessment/src/'],
				dependsOn: ['task-a'],
				status: 'pending',
				integrationOrder: 1,
				worktreeSubdir: 'worktrees/task-b',
				baseCommitSha: BASE_COMMIT_SHA,
				parentTreeSha: null,
				targetTreeSha: null,
				patchHash: null,
				failurePacketArtifact: null,
				repairCount: 0,
			},
		],
		integrationOrder: ['task-a', 'task-b'],
		isParallel: true,
		createdAt: '2026-09-07T00:00:00.000Z',
	};

	assert.throws(
		() => evaluatePolicyGate({ taskPlan: cyclicPlan }),
		(err) => err.code === 'POLICY_VIOLATION' && /Cyclic task dependencies/.test(err.message),
	);
});

test('@ac AC-05 concurrent same-package tasks return TASK_PLAN_INVALID', () => {
	const samePkgPlan = {
		schemaVersion: '1.0.0',
		runId: RUN_ID,
		planPolicyHash: 'p'.repeat(64),
		baseCommitSha: BASE_COMMIT_SHA,
		tasks: [
			{
				taskId: 'cond-task-1',
				title: 'Part 1',
				targetPackage: 'apps/services/conditioning',
				pathPrefixes: ['apps/services/conditioning/src/feature-a/'],
				dependsOn: [],
				status: 'pending',
				integrationOrder: 0,
				worktreeSubdir: 'worktrees/cond-task-1',
				baseCommitSha: BASE_COMMIT_SHA,
				parentTreeSha: null,
				targetTreeSha: null,
				patchHash: null,
				failurePacketArtifact: null,
				repairCount: 0,
			},
			{
				taskId: 'cond-task-2',
				title: 'Part 2',
				targetPackage: 'apps/services/conditioning',
				pathPrefixes: ['apps/services/conditioning/src/feature-b/'],
				dependsOn: [],
				status: 'pending',
				integrationOrder: 1,
				worktreeSubdir: 'worktrees/cond-task-2',
				baseCommitSha: BASE_COMMIT_SHA,
				parentTreeSha: null,
				targetTreeSha: null,
				patchHash: null,
				failurePacketArtifact: null,
				repairCount: 0,
			},
		],
		integrationOrder: ['cond-task-1', 'cond-task-2'],
		isParallel: true,
		createdAt: '2026-09-07T00:00:00.000Z',
	};

	assert.throws(
		() => evaluatePolicyGate({ taskPlan: samePkgPlan }),
		(err) =>
			err.code === 'TASK_PLAN_INVALID' &&
			/Multiple concurrent tasks targeting the same package/.test(err.message),
	);

	for (const field of ['authoredPaths', 'generatedOutputs']) {
		const crossPackagePlan = structuredClone(samePkgPlan);
		crossPackagePlan.tasks[1].targetPackage = 'apps/services/assessment';
		crossPackagePlan.tasks[1].pathPrefixes = ['apps/services/assessment/src/feature-b/'];
		crossPackagePlan.tasks[0].authoredPaths = ['apps/services/conditioning/src/feature-a.ts'];
		crossPackagePlan.tasks[1].authoredPaths = ['apps/services/assessment/src/feature-b.ts'];
		crossPackagePlan.tasks[0].generatedOutputs = [];
		crossPackagePlan.tasks[1].generatedOutputs = [];
		crossPackagePlan.tasks[0][field] = ['pnpm-lock.yaml'];
		crossPackagePlan.tasks[1][field] = ['pnpm-lock.yaml'];
		assert.throws(
			() => evaluatePolicyGate({ taskPlan: crossPackagePlan }),
			(error) =>
				error.code === 'TASK_PLAN_INVALID' &&
				error.message.includes('overlapping owned paths'),
		);
	}
});

test('concurrent overlapping paths return TASK_PLAN_INVALID', () => {
	const overlapPlan = {
		schemaVersion: '1.0.0',
		runId: RUN_ID,
		planPolicyHash: 'p'.repeat(64),
		baseCommitSha: BASE_COMMIT_SHA,
		tasks: [
			{
				taskId: 'task-parent',
				title: 'Parent path',
				targetPackage: 'apps/services/conditioning',
				pathPrefixes: ['apps/services/conditioning/src/'],
				dependsOn: [],
				status: 'pending',
				integrationOrder: 0,
				worktreeSubdir: 'worktrees/task-parent',
				baseCommitSha: BASE_COMMIT_SHA,
				parentTreeSha: null,
				targetTreeSha: null,
				patchHash: null,
				failurePacketArtifact: null,
				repairCount: 0,
			},
			{
				taskId: 'task-child',
				title: 'Child path',
				targetPackage: 'apps/services/assessment',
				// Artificial overlap to test detection
				pathPrefixes: ['apps/services/conditioning/src/sub/'],
				dependsOn: [],
				status: 'pending',
				integrationOrder: 1,
				worktreeSubdir: 'worktrees/task-child',
				baseCommitSha: BASE_COMMIT_SHA,
				parentTreeSha: null,
				targetTreeSha: null,
				patchHash: null,
				failurePacketArtifact: null,
				repairCount: 0,
			},
		],
		integrationOrder: ['task-parent', 'task-child'],
		isParallel: true,
		createdAt: '2026-09-07T00:00:00.000Z',
	};

	assert.throws(
		() => evaluatePolicyGate({ taskPlan: overlapPlan }),
		(err) =>
			err.code === 'TASK_PLAN_INVALID' &&
			/overlapping owned paths/.test(err.message),
	);
});

test('evaluatePolicyGate enforces shared package serialization (AC 16)', () => {
	// conditioning depends on ddd-base, but plan does not declare dependency
	const unsharedPlan = {
		schemaVersion: '1.0.0',
		runId: RUN_ID,
		planPolicyHash: 'p'.repeat(64),
		baseCommitSha: BASE_COMMIT_SHA,
		tasks: [
			{
				taskId: 'conditioning-task',
				title: 'Conditioning',
				targetPackage: 'apps/services/conditioning',
				pathPrefixes: ['apps/services/conditioning/src/'],
				dependsOn: [], // Missing dependency on ddd-base-task!
				status: 'pending',
				integrationOrder: 0,
				worktreeSubdir: 'worktrees/conditioning-task',
				baseCommitSha: BASE_COMMIT_SHA,
				parentTreeSha: null,
				targetTreeSha: null,
				patchHash: null,
				failurePacketArtifact: null,
				repairCount: 0,
			},
			{
				taskId: 'ddd-base-task',
				title: 'DDD Base',
				targetPackage: 'packages/ddd-base',
				pathPrefixes: ['packages/ddd-base/src/'],
				dependsOn: [],
				status: 'pending',
				integrationOrder: 1,
				worktreeSubdir: 'worktrees/ddd-base-task',
				baseCommitSha: BASE_COMMIT_SHA,
				parentTreeSha: null,
				targetTreeSha: null,
				patchHash: null,
				failurePacketArtifact: null,
				repairCount: 0,
			},
		],
		integrationOrder: ['conditioning-task', 'ddd-base-task'],
		isParallel: true,
		createdAt: '2026-09-07T00:00:00.000Z',
	};

	assert.throws(
		() => evaluatePolicyGate({ taskPlan: unsharedPlan }),
		(err) =>
			err.code === 'POLICY_VIOLATION' &&
			/must be serialized after shared package task/.test(err.message),
	);
});

test('evaluatePolicyGate enforces contract producer/consumer serialization (AC 15, 16)', () => {
	// conditioning touches contracts, gateway consumes contracts, but gateway does not depend on conditioning
	const uncontractedPlan = {
		schemaVersion: '1.0.0',
		runId: RUN_ID,
		planPolicyHash: 'p'.repeat(64),
		baseCommitSha: BASE_COMMIT_SHA,
		tasks: [
			{
				taskId: 'api-gateway-task',
				title: 'Gateway',
				targetPackage: 'apps/services/api-gateway',
				pathPrefixes: ['apps/services/api-gateway/src/'],
				dependsOn: [], // Missing dependency on producer!
				status: 'pending',
				integrationOrder: 0,
				worktreeSubdir: 'worktrees/api-gateway-task',
				baseCommitSha: BASE_COMMIT_SHA,
				parentTreeSha: null,
				targetTreeSha: null,
				patchHash: null,
				failurePacketArtifact: null,
				repairCount: 0,
			},
			{
				taskId: 'conditioning-task',
				title: 'Conditioning contracts',
				targetPackage: 'apps/services/conditioning',
				pathPrefixes: ['apps/services/conditioning/contracts/index.ts'],
				dependsOn: [],
				status: 'pending',
				integrationOrder: 1,
				worktreeSubdir: 'worktrees/conditioning-task',
				baseCommitSha: BASE_COMMIT_SHA,
				parentTreeSha: null,
				targetTreeSha: null,
				patchHash: null,
				failurePacketArtifact: null,
				repairCount: 0,
			},
		],
		integrationOrder: ['api-gateway-task', 'conditioning-task'],
		isParallel: true,
		createdAt: '2026-09-07T00:00:00.000Z',
	};

	assert.throws(
		() => evaluatePolicyGate({ taskPlan: uncontractedPlan }),
		(err) =>
			err.code === 'POLICY_VIOLATION' &&
			/must be serialized after contract producer task/.test(err.message),
	);
});

test('evaluatePolicyGate rejects quality baseline modifications (AC 15)', () => {
	const baselineMutationPlan = {
		schemaVersion: '1.0.0',
		runId: RUN_ID,
		planPolicyHash: 'p'.repeat(64),
		baseCommitSha: BASE_COMMIT_SHA,
		tasks: [
			{
				taskId: 'bad-task',
				title: 'Mutate baseline',
				targetPackage: 'tools',
				pathPrefixes: ['tools/quality/baseline.json'],
				dependsOn: [],
				status: 'pending',
				integrationOrder: 0,
				worktreeSubdir: 'worktrees/bad-task',
				baseCommitSha: BASE_COMMIT_SHA,
				parentTreeSha: null,
				targetTreeSha: null,
				patchHash: null,
				failurePacketArtifact: null,
				repairCount: 0,
			},
		],
		integrationOrder: ['bad-task'],
		isParallel: false,
		createdAt: '2026-09-07T00:00:00.000Z',
	};

	assert.throws(
		() => evaluatePolicyGate({ taskPlan: baselineMutationPlan }),
		(err) =>
			err.code === 'POLICY_VIOLATION' &&
			/Modification of quality baselines is forbidden/.test(err.message),
	);
});

test('evaluatePolicyGate verifies topological consistency in integrationOrder', () => {
	// Task B depends on Task A, but integrationOrder lists Task B before Task A!
	const badOrderPlan = {
		schemaVersion: '1.0.0',
		runId: RUN_ID,
		planPolicyHash: 'p'.repeat(64),
		baseCommitSha: BASE_COMMIT_SHA,
		tasks: [
			{
				taskId: 'task-a',
				title: 'Task A',
				targetPackage: 'apps/services/conditioning',
				pathPrefixes: ['apps/services/conditioning/src/'],
				dependsOn: [],
				status: 'pending',
				integrationOrder: 1, // Bad order
				worktreeSubdir: 'worktrees/task-a',
				baseCommitSha: BASE_COMMIT_SHA,
				parentTreeSha: null,
				targetTreeSha: null,
				patchHash: null,
				failurePacketArtifact: null,
				repairCount: 0,
			},
			{
				taskId: 'task-b',
				title: 'Task B',
				targetPackage: 'apps/services/assessment',
				pathPrefixes: ['apps/services/assessment/src/'],
				dependsOn: ['task-a'],
				status: 'pending',
				integrationOrder: 0, // Bad order
				worktreeSubdir: 'worktrees/task-b',
				baseCommitSha: BASE_COMMIT_SHA,
				parentTreeSha: null,
				targetTreeSha: null,
				patchHash: null,
				failurePacketArtifact: null,
				repairCount: 0,
			},
		],
		integrationOrder: ['task-b', 'task-a'], // Violates dependency
		isParallel: true,
		createdAt: '2026-09-07T00:00:00.000Z',
	};

	assert.throws(
		() => evaluatePolicyGate({ taskPlan: badOrderPlan }),
		(err) =>
			err.code === 'POLICY_VIOLATION' &&
			/Integration order violates dependency/.test(err.message),
	);
});
