import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { projectHostInvocation } from '../cli/host-invocation.ts';
import { computeContinuation } from '../cli/continuation.ts';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';
import { SdlcWorkflowRuntime } from './graph.ts';
import { escalateAutonomousRepairRetired } from './preflight-gate.ts';
import { applyPreflightTaskRevision } from './preflight-task-revision.ts';
import { createRepairFailureNode } from './nodes/finish-run.ts';
import { makeFixture } from '../testing/test-support.mjs';

const SPEC_HASH = 'b'.repeat(64);
const PATHS = ['pkg/billing/src/orphan.ts'];

function git(cwd, args) {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(root, rel, body) {
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, body);
}

function initRepo(dropImport) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'correction-repo-'));
	write(root, '.agents/sdlc-host.json', JSON.stringify({
		schemaVersion: '1.7.0', profileId: 'fixture', repositoryId: 'fixture', adapter: 'default',
	}));
	git(root, ['init', '-b', 'main']);
	git(root, ['config', 'user.email', 'test@example.com']);
	git(root, ['config', 'user.name', 'test']);
	write(root, 'pkg/billing/src/retire.ts', "import { orphan } from './orphan.ts';\nexport const retired = 1;\n");
	write(root, 'pkg/billing/src/orphan.ts', 'export const orphan = 1;\n');
	git(root, ['add', '.']);
	git(root, ['commit', '-m', 'base']);
	const baseCommit = git(root, ['rev-parse', 'HEAD']);
	const baseTree = git(root, ['rev-parse', 'HEAD^{tree}']);
	if (dropImport) {
		write(root, 'pkg/billing/src/retire.ts', 'export const retired = 1;\n');
		git(root, ['add', '.']);
		git(root, ['commit', '-m', 'drop import']);
	}
	return {
		root,
		baseCommit,
		baseTree,
		targetTree: git(root, ['rev-parse', 'HEAD^{tree}']),
		head: git(root, ['rev-parse', 'HEAD']),
	};
}

function prepare(dropImport) {
	const repo = initRepo(dropImport);
	const fixture = makeFixture('preflight-revision');
	const calls = [];
	const gitCli = (command, args, options = {}) => {
		calls.push(args[0]);
		return execFileSync(command, args, options);
	};
	const runtime = new SdlcWorkflowRuntime({
		runtimeStore: fixture.store,
		artifactStore: fixture.artifacts,
		registry: fixture.registry,
		governor: fixture.governor,
		rootDir: repo.root,
		gitCli,
	});
	const initial = runtime.initialize({ runId: fixture.runId, goal: 'Retire the route' });
	const state = runtime.transition(initial, {
		to: 'ESCALATED',
		eventType: 'RUN_BLOCKED',
		causalId: 'halt',
		updates: {
			blockedReason: 'AUTONOMOUS_REPAIR_RETIRED',
			approvedSpecHash: SPEC_HASH,
			semanticRepairsCount: 1,
			lastError: {
				code: 'AUTONOMOUS_REPAIR_RETIRED',
				message: 'halted',
				metadata: {
					integrationFailure: {
						haltPath: 'AUTONOMOUS_REPAIR_RETIRED',
						classification: 'quality_failure',
						category: 'coverage_floor_regression',
						targetPaths: PATHS,
						continuation: 'stop',
					},
					correctionOffer: { paths: PATHS, taskId: 'retire-route', taskIdRequired: true },
				},
			},
		},
		payload: {},
	});
	runtime.runtimeStore.saveTaskPlan({
		schemaVersion: '1.0.0',
		runId: fixture.runId,
		planPolicyHash: 'e'.repeat(64),
		baseCommitSha: repo.baseCommit,
		tasks: [{
			taskId: 'retire-route',
			title: 'Retire the route',
			targetPackage: 'pkg/billing',
			pathPrefixes: ['pkg/billing/src/retire.ts'],
			authoredPaths: ['pkg/billing/src/retire.ts'],
			dependsOn: [],
			status: 'completed',
			integrationOrder: 0,
			worktreeSubdir: 'worktrees/retire-route',
			baseCommitSha: repo.baseCommit,
			parentTreeSha: repo.baseTree,
			parentCommitSha: repo.baseCommit,
			targetTreeSha: repo.targetTree,
			patchHash: 'd'.repeat(64),
			repairCount: 0,
		}],
		integrationOrder: ['retire-route'],
		isParallel: false,
		createdAt: '2026-11-11T12:00:00.000Z',
	});
	runtime.runtimeStore.saveAuthorization(createDefaultAuthorizationEnvelope({
		runId: fixture.runId,
		approvedSpecHash: SPEC_HASH,
		repositoryId: 'fixture',
		rootDir: repo.root,
		baseCommitSha: repo.baseCommit,
		allowedPackages: ['pkg/billing'],
		allowedPathPrefixes: ['pkg/billing'],
	}));
	return {
		repo, fixture, runtime, state, calls,
		close() {
			fixture.close();
			fs.rmSync(repo.root, { recursive: true, force: true });
		},
	};
}

function response(taskId = 'retire-route') {
	return { action: 'approve-correction', taskId, paths: PATHS };
}

test('@ac AC-02 @case AC-02.1 the task diff contains the deletion', () => {
	const ctx = prepare(true);
	try {
		const revised = applyPreflightTaskRevision({ runtime: ctx.runtime, snapshot: ctx.state, response: response() });
		const task = ctx.runtime.runtimeStore.getTaskPlan(ctx.fixture.runId).tasks[0];
		const names = git(ctx.repo.root, ['diff-tree', '--name-status', '-r', ctx.repo.baseTree, task.targetTreeSha]);
		assert.match(names, /D\s+pkg\/billing\/src\/orphan\.ts/);
		assert.equal(revised.state, 'RECONCILING_INTEGRATION');
	} finally {
		ctx.close();
	}
});

test('@ac AC-02 @case AC-02.2 reconcile rebuilds that deletion', () => {
	const ctx = prepare(true);
	try {
		applyPreflightTaskRevision({ runtime: ctx.runtime, snapshot: ctx.state, response: response() });
		const task = ctx.runtime.runtimeStore.getTaskPlan(ctx.fixture.runId).tasks[0];
		const patch = git(ctx.repo.root, ['diff-tree', '-p', '-r', ctx.repo.baseTree, task.targetTreeSha]);
		assert.match(patch, /deleted file mode/);
		assert.match(patch, /pkg\/billing\/src\/orphan\.ts/);
	} finally {
		ctx.close();
	}
});

test('@ac AC-02 @case AC-02.3 a path outside the card is rejected before any tree changes', () => {
	const ctx = prepare(true);
	try {
		assert.throws(() => applyPreflightTaskRevision({
			runtime: ctx.runtime,
			snapshot: ctx.state,
			response: { action: 'approve-correction', taskId: 'retire-route', paths: ['pkg/billing/src/other.ts'] },
		}));
		const task = ctx.runtime.runtimeStore.getTaskPlan(ctx.fixture.runId).tasks[0];
		assert.equal(task.targetTreeSha, ctx.repo.targetTree);
		assert.equal(ctx.runtime.runtimeStore.getRun(ctx.fixture.runId).state, 'ESCALATED');
	} finally {
		ctx.close();
	}
});

test('@ac AC-02 @case AC-02.8 the revision patch may delete the card path without rewriting the frozen plan paths', () => {
	const ctx = prepare(true);
	try {
		applyPreflightTaskRevision({ runtime: ctx.runtime, snapshot: ctx.state, response: response() });
		const task = ctx.runtime.runtimeStore.getTaskPlan(ctx.fixture.runId).tasks[0];
		assert.deepEqual(task.pathPrefixes, ['pkg/billing/src/retire.ts']);
		assert.deepEqual(task.authoredPaths, ['pkg/billing/src/retire.ts']);
		assert.notEqual(task.targetTreeSha, ctx.repo.targetTree);
	} finally {
		ctx.close();
	}
});

test('@ac AC-04 @case AC-04.1 the first and second packets are both retained', async () => {
	const ctx = prepare(true);
	try {
		const revised = applyPreflightTaskRevision({ runtime: ctx.runtime, snapshot: ctx.state, response: response() });
		const again = await escalateAutonomousRepairRetired(ctx.runtime, revised, {
			recordIntegrationFailure: true,
			diagnostics: { schemaVersion: '1', coverageFloor: { pass: false, paths: PATHS } },
		});
		const metadata = again.snapshot.lastError.metadata;
		assert.equal(metadata.priorIntegrationFailure.category, 'coverage_floor_regression');
		assert.equal(metadata.integrationFailure.category, 'coverage_floor_regression');
		assert.equal(metadata.integrationCorrectionConsumed, true);
	} finally {
		ctx.close();
	}
});

test('@ac AC-04 @case AC-04.2 no further approve-correction slot is issued', async () => {
	const ctx = prepare(true);
	try {
		const revised = applyPreflightTaskRevision({ runtime: ctx.runtime, snapshot: ctx.state, response: response() });
		const again = await escalateAutonomousRepairRetired(ctx.runtime, revised, {
			recordIntegrationFailure: true,
			diagnostics: { schemaVersion: '1', coverageFloor: { pass: false, paths: PATHS } },
		});
		assert.deepEqual(computeContinuation(again.snapshot, {
			authorization: { allowedPathPrefixes: ['pkg/billing'] },
			highRiskPaths: [],
		}), { action: 'stop', reason: 'HALTED' });
		assert.equal(projectHostInvocation(again.snapshot, {
			authorization: { allowedPathPrefixes: ['pkg/billing'] },
			highRiskPaths: [],
		}).responseSlots, null);
	} finally {
		ctx.close();
	}
});

test('@ac AC-04 @case AC-04.3 semanticRepairsCount and the task repair cap stay unchanged', () => {
	const ctx = prepare(true);
	try {
		const revised = applyPreflightTaskRevision({ runtime: ctx.runtime, snapshot: ctx.state, response: response() });
		const task = ctx.runtime.runtimeStore.getTaskPlan(ctx.fixture.runId).tasks[0];
		assert.equal(revised.semanticRepairsCount, 1);
		assert.equal(task.repairCount, 0);
	} finally {
		ctx.close();
	}
});

test('@ac AC-05 @case AC-05.1 the approved path reconciles before preflight', () => {
	const ctx = prepare(true);
	try {
		const revised = applyPreflightTaskRevision({ runtime: ctx.runtime, snapshot: ctx.state, response: response() });
		assert.equal(revised.state, 'RECONCILING_INTEGRATION');
		assert.notEqual(revised.state, 'VERIFYING_PREFLIGHT');
	} finally {
		ctx.close();
	}
});

test('@ac AC-05 @case AC-05.2 repair_failure with no operator approval still escalates', async () => {
	const fixture = makeFixture('repair-still-escalates');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'Retire the route' });
		const result = await createRepairFailureNode(fixture.runtime)({ snapshot: initial });
		assert.equal(result.snapshot.state, 'ESCALATED');
		assert.equal(result.snapshot.blockedReason, 'AUTONOMOUS_REPAIR_RETIRED');
		assert.equal(result.snapshot.lastError.metadata.correctionOffer, undefined);
	} finally {
		fixture.close();
	}
});

test('@ac AC-05 @case AC-05.3 the run does not commit or push', () => {
	const ctx = prepare(true);
	try {
		applyPreflightTaskRevision({ runtime: ctx.runtime, snapshot: ctx.state, response: response() });
		assert.equal(git(ctx.repo.root, ['rev-parse', 'HEAD']), ctx.repo.head);
		assert.equal(ctx.calls.includes('push'), false);
		assert.equal(ctx.calls.includes('commit'), false);
	} finally {
		ctx.close();
	}
});

test('@ac AC-05 @case AC-05.4 EXECUTING_IMPLEMENTATION is not entered for this correction', () => {
	const ctx = prepare(true);
	try {
		const revised = applyPreflightTaskRevision({ runtime: ctx.runtime, snapshot: ctx.state, response: response() });
		assert.equal(revised.state, 'RECONCILING_INTEGRATION');
		assert.notEqual(revised.state, 'EXECUTING_IMPLEMENTATION');
	} finally {
		ctx.close();
	}
});

test('@ac AC-05 @case AC-05.5 a missing quality policy still records the task tree after the proof', () => {
	const ctx = prepare(true);
	try {
		const revised = applyPreflightTaskRevision({ runtime: ctx.runtime, snapshot: ctx.state, response: response() });
		const task = ctx.runtime.runtimeStore.getTaskPlan(ctx.fixture.runId).tasks[0];
		assert.equal(ctx.runtime.runtimeStore.getTaskPlan(ctx.fixture.runId).schemaVersion, '1.0.0');
		assert.notEqual(task.targetTreeSha, ctx.repo.targetTree);
		assert.equal(typeof revised.lastError.metadata.proofArtifact, 'string');
	} finally {
		ctx.close();
	}
});

test('@ac AC-05 @case AC-05.7 proof failure leaves the previous targetTreeSha in place', () => {
	const ctx = prepare(false);
	try {
		assert.throws(() => applyPreflightTaskRevision({
			runtime: ctx.runtime, snapshot: ctx.state, response: response(),
		}));
		const task = ctx.runtime.runtimeStore.getTaskPlan(ctx.fixture.runId).tasks[0];
		assert.equal(task.targetTreeSha, ctx.repo.targetTree);
		assert.equal(ctx.runtime.runtimeStore.getRun(ctx.fixture.runId).state, 'ESCALATED');
	} finally {
		ctx.close();
	}
});
