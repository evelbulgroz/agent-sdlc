import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { rememberRetirementBlockers, retirementBlockersFor } from './retirement-paths.ts';
import { staticImportScanCount } from './static-import-graph.ts';
import { planTaskDag } from './task-planner.ts';
import { makeFixture } from '../testing/test-support.mjs';
import { SdlcWorkflowRuntime } from '../workflow/graph.ts';
import {
	createApplyPlanCriticNode,
	createExecutePlanCriticNode,
} from '../workflow/nodes/planning.ts';

const SHA = 'a'.repeat(40);

function tempTree(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retirement-plan-'));
	for (const [rel, body] of Object.entries(files)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, body);
	}
	return root;
}

function shadowPaths() {
	return {
		unhappy: 'rejected mutation',
		timeout: 'deadline exceeded',
		empty: 'no delta',
		boundary: 'scope escape',
	};
}

function workspaceFor(packagePath) {
	return {
		packageMap: new Map([
			['@fixture/billing', {
				packagePath,
				pkgJson: { name: '@fixture/billing', scripts: { test: 'node --test' } },
			}],
		]),
		pathToPackage: new Map([[packagePath, '@fixture/billing']]),
	};
}

function manifestFor(retirement) {
	const taskBody = {
		taskId: 'retire-route',
		sliceId: 'behavior',
		targetPackage: 'pkg/billing',
		authoredPaths: ['pkg/billing/src/retire.ts'],
		pathPrefixes: ['pkg/billing/src/retire.ts'],
		generatedOutputs: [],
		dependsOn: [],
		deliveryLayers: ['application'],
		dependencyMutations: [],
		shadowPaths: shadowPaths(),
		verificationCommand: ['pnpm', '--filter', '@fixture/billing', 'test'],
		generatorCommand: null,
	};
	if (retirement !== undefined) taskBody.retirement = retirement;
	return {
		schemaVersion: '1.0.0',
		slices: [{
			sliceId: 'behavior',
			kind: 'vertical',
			goal: 'Retire one route',
			acceptanceCriteria: ['AC-01'],
			dependsOn: [],
		}],
		tasks: [taskBody],
	};
}

function planRetired(root, retirement, runId = '2026-11-11-retirement-plan') {
	return planTaskDag({
		draft: {
			goal: 'Retire one route',
			touchedSurfaces: ['pkg/billing'],
			acceptanceCriteria: [
				'AC-01: The sibling joins the retirement task. Given one importer. Then the path is expanded.',
			],
		},
		taskManifest: manifestFor(retirement),
		authorization: {
			runId,
			baseCommitSha: SHA,
			taskManifestHash: 'c'.repeat(64),
			allowedPackages: ['pkg/billing'],
			allowedPathPrefixes: ['pkg/billing'],
		},
		rootDir: root,
		workspacePackages: workspaceFor('pkg/billing'),
		now: () => '2026-11-11T12:00:00.000Z',
	});
}

test('@ac AC-02 @case AC-02.2 accept_residual adds no path and does not change taskPlanHash', async () => {
	const root = tempTree({
		'pkg/billing/src/retire.ts': 'export const value = import(name);\n',
	});
	const fixture = makeFixture('retirement-accept-residual');
	try {
		const plan = planRetired(root, true);
		assert.equal(retirementBlockersFor(plan.planPolicyHash).length > 0, true);
		assert.deepEqual(plan.tasks[0].authoredPaths, ['pkg/billing/src/retire.ts']);
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'Retire the route' });
		let state = initial;
		for (const to of [
			'SPEC_DRAFTING',
			'WAITING_FOR_APPROVAL',
			'SPEC_APPROVED',
			'PLANNING_TASKS',
			'EVALUATING_POLICY',
			'REVIEWING_PLAN',
		]) {
			state = fixture.runtime.transition(state, {
				to,
				eventType: 'RUN_AUTHORIZED',
				causalId: `${to}-${state.runtimeRevision}`,
				updates: {},
				payload: {},
			});
		}
		fixture.store.saveTaskPlan({ ...plan, runId: fixture.runId });
		const saved = fixture.store.getTaskPlan(fixture.runId);
		const reviewing = {
			...state,
			taskPlanHash: saved.planPolicyHash,
			approvedPlanPolicyHash: 'b'.repeat(64),
		};
		const waiting = await createExecutePlanCriticNode(fixture.runtime)({ snapshot: reviewing });
		assert.equal(waiting.snapshot.state, 'WAITING_FOR_PLAN_ACCEPTANCE');
		assert.equal(waiting.snapshot.taskPlanFrozen, false);
		const pending = fixture.store.getInterrupt(waiting.snapshot.pendingInterruptId);
		const request = fixture.artifacts.readJson(pending.requestArtifact);
		assert.equal(request.criticReport.hasP1, true);
		assert.equal(request.criticReport.paths.length > 0, true);
		const response = {
			schemaVersion: '1.0.0',
			interruptId: pending.interruptId,
			stateHash: pending.stateHash,
			action: 'accept_residual',
		};
		fixture.store.recordInterruptResponse(
			pending.interruptId,
			fixture.artifacts.writeJson('human-response', response),
		);
		const frozen = await createApplyPlanCriticNode(fixture.runtime)({
			snapshot: waiting.snapshot,
			humanResponse: response,
		});
		assert.equal(frozen.snapshot.taskPlanFrozen, true);
		assert.equal(frozen.snapshot.taskPlanHash, saved.planPolicyHash);
		const after = fixture.store.getTaskPlan(fixture.runId);
		assert.deepEqual(after.tasks[0].authoredPaths, ['pkg/billing/src/retire.ts']);
		assert.equal(after.planPolicyHash, saved.planPolicyHash);
	} finally {
		fixture.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function criticRuntime(fixture, root) {
	return new SdlcWorkflowRuntime({
		runtimeStore: fixture.store,
		artifactStore: fixture.artifacts,
		registry: fixture.registry,
		governor: fixture.governor,
		rootDir: root,
	});
}

function reviewingSnapshot(fixture, plan) {
	let state = fixture.runtime.initialize({ runId: fixture.runId, goal: 'Retire the route' });
	for (const to of [
		'SPEC_DRAFTING',
		'WAITING_FOR_APPROVAL',
		'SPEC_APPROVED',
		'PLANNING_TASKS',
		'EVALUATING_POLICY',
		'REVIEWING_PLAN',
	]) {
		state = fixture.runtime.transition(state, {
			to,
			eventType: 'RUN_AUTHORIZED',
			causalId: `${to}-${state.runtimeRevision}`,
			updates: {},
			payload: {},
		});
	}
	fixture.store.saveTaskPlan({ ...plan, runId: fixture.runId });
	const saved = fixture.store.getTaskPlan(fixture.runId);
	return {
		saved,
		reviewing: {
			...state,
			taskPlanHash: saved.planPolicyHash,
			approvedPlanPolicyHash: 'b'.repeat(64),
		},
	};
}

test('@ac AC-05 @case AC-05.1 the recomputed P1 stops at WAITING_FOR_PLAN_ACCEPTANCE and names the blocker paths', async () => {
	const root = tempTree({
		'pkg/billing/src/retire.ts': 'export const value = import(name);\n',
	});
	const fixture = makeFixture('retirement-recompute-blockers');
	try {
		const plan = planRetired(root, true, '2026-11-11-retirement-recompute');
		const hash = plan.planPolicyHash;
		assert.equal(retirementBlockersFor(hash).length > 0, true);
		rememberRetirementBlockers(hash, []);
		assert.deepEqual(retirementBlockersFor(hash), []);
		const { saved, reviewing } = reviewingSnapshot(fixture, plan);
		const scans = staticImportScanCount();
		const waiting = await createExecutePlanCriticNode(criticRuntime(fixture, root))({ snapshot: reviewing });
		assert.equal(staticImportScanCount(), scans + 1);
		assert.equal(fixture.governor.calls.length, 0);
		assert.equal(waiting.snapshot.state, 'WAITING_FOR_PLAN_ACCEPTANCE');
		assert.equal(waiting.snapshot.taskPlanHash, hash);
		const pending = fixture.store.getInterrupt(waiting.snapshot.pendingInterruptId);
		const request = fixture.artifacts.readJson(pending.requestArtifact);
		assert.equal(request.criticReport.paths.includes('pkg/billing/src/retire.ts'), true);
		const after = fixture.store.getTaskPlan(fixture.runId);
		assert.equal(after.planPolicyHash, saved.planPolicyHash);
		assert.deepEqual(after.tasks[0].authoredPaths, ['pkg/billing/src/retire.ts']);
	} finally {
		fixture.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-05 @case AC-05.2 a recompute that finds no blockers leaves the model critic in place', async () => {
	const root = tempTree({
		'pkg/billing/src/retire.ts': "import fs from 'node:fs';\nimport { X } from '@nestjs/common/interfaces';\n",
	});
	const fixture = makeFixture('retirement-recompute-empty');
	try {
		const plan = planRetired(root, true, '2026-11-11-retirement-empty');
		const hash = plan.planPolicyHash;
		assert.deepEqual(retirementBlockersFor(hash), []);
		const { saved, reviewing } = reviewingSnapshot(fixture, plan);
		const scans = staticImportScanCount();
		reviewing.approvedSpecHash = 'd'.repeat(64);
		const frozen = await createExecutePlanCriticNode(criticRuntime(fixture, root))({ snapshot: reviewing });
		assert.equal(staticImportScanCount() > scans, true);
		assert.equal(fixture.governor.calls.some((call) => call.profile === 'critic-review'), true);
		assert.equal(frozen.snapshot.state, 'PREPARING_WORKSPACE');
		assert.equal(frozen.snapshot.taskPlanHash, hash);
		const after = fixture.store.getTaskPlan(fixture.runId);
		assert.equal(after.planPolicyHash, saved.planPolicyHash);
		assert.deepEqual(after.tasks[0].authoredPaths, ['pkg/billing/src/retire.ts']);
	} finally {
		fixture.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
