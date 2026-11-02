import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultAuthorizationEnvelope } from '../../policy/authorization.ts';
import { assertTaskPlanHash, hashTaskPlanProjection, sha256 } from '../../policy/contracts.ts';
import { planTaskDag } from '../../policy/task-planner.ts';
import { policy } from '../../testing/quality-test-support.mjs';
import { readinessDraft, BASE_COMMIT_SHA } from '../../testing/task-planner-fixtures.mjs';
import { makeFixture } from '../../testing/test-support.mjs';
import { runPlanCritic } from '../../review/critic-gate.ts';
import {
	createPlanTasksNode,
	createEvaluatePolicyGateNode,
	createExecutePlanCriticNode,
	createAskPlanCriticNode,
	createApplyPlanCriticNode,
} from './planning.ts';

test('createPlanTasksNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createPlanTasksNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createPlanTasksNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createPlanTasksNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});

test('createPlanTasksNode freezes and binds the full v2 plan projection before plan criticism', async () => {
	const draft = readinessDraft();
	const fixture = makeFixture('quality-plan-projection', [
		{ __role: 'critic', status: 'PASS', findings: [] },
	]);
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: draft.goal });
		const planningAuthorization = {
			runId: fixture.runId,
			baseCommitSha: BASE_COMMIT_SHA,
			allowedPackages: ['tools'],
			allowedPathPrefixes: ['tools/agent-sdlc/policy'],
		};
		const legacyPlan = planTaskDag({
			draft,
			authorization: planningAuthorization,
			now: () => '2026-11-01T10:00:00.000Z',
		});
		const adapter = {
			adapterId: 'planning-test',
			protocolVersion: '1.0.0',
			bundleFiles: [{ path: 'tools/adapter.mjs', sha256: 'b'.repeat(64) }],
			dependencyFiles: [],
			configurationFiles: [],
			argv: ['node', 'tools/adapter.mjs'],
			profiles: [{ profileId: 'unit', layers: ['unit'], capabilities: [] }],
			qualificationArtifactHash: 'c'.repeat(64),
			limits: { timeoutMs: 1_000, maxReportBytes: 10_000, maxArtifactBytes: 1_000, maxArtifacts: 1 },
		};
		const qualityPlan = {
			qualityPolicy: policy,
			adapterBindings: [adapter],
			evidenceObligations: [{
				obligationId: 'obligation-ac-01',
				criterionId: 'AC-01',
				caseId: null,
				owner: { kind: 'slice', id: legacyPlan.slices[0].sliceId },
				observableOutcome: 'The result is visible.',
				setupAction: 'Read the result.',
				expectedResult: 'The result is displayed.',
				layer: 'unit',
				requiredCapabilities: [],
				implementationPaths: ['tools/agent-sdlc/policy'],
				testCases: [{ file: 'tools/agent-sdlc/policy/result.spec.mjs', caseKey: 'visible' }],
				adapterBindingHash: sha256(adapter),
				profileId: 'unit',
			}],
		};
		const authorization = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: 'a'.repeat(64),
			baseCommitSha: BASE_COMMIT_SHA,
			allowedPackages: ['tools'],
			allowedPathPrefixes: ['tools/agent-sdlc/policy'],
			qualityPlan,
		});
		fixture.store.saveAuthorization(authorization);
		const draftArtifact = fixture.artifacts.writeJson('planning-draft', draft);
		fixture.runtime.currentOrAlreadyAdvanced = () => null;
		fixture.runtime.transition = (current, options) => ({
			...current,
			...options.updates,
			state: options.to,
			runtimeRevision: current.runtimeRevision + 1,
		});
		fixture.runtime.onBoundary = async () => {};
		let planningTime = '2026-11-01T10:00:00.000Z';
		fixture.runtime.now = () => new Date(planningTime);
		const planningSnapshot = {
			...initial,
			state: 'PLANNING_TASKS',
			approvedSpecHash: 'a'.repeat(64),
			approvedPlanPolicyHash: authorization.approvedPlanPolicyHash,
			taskPlanHash: null,
			draftArtifact,
		};
		const writeJson = fixture.artifacts.writeJson.bind(fixture.artifacts);
		let failBeforePlanTransition = true;
		fixture.artifacts.writeJson = (kind, ...args) => {
			if (kind === 'task-plan' && failBeforePlanTransition) {
				throw new Error('injected crash after saving the immutable plan');
			}
			return writeJson(kind, ...args);
		};
		await assert.rejects(
			createPlanTasksNode(fixture.runtime)({ snapshot: planningSnapshot }),
			/injected crash after saving the immutable plan/,
		);
		assert.equal(
			fixture.store.taskPlans.getTaskPlanForPolicy(fixture.runId, authorization.approvedPlanPolicyHash).createdAt,
			planningTime,
		);
		planningTime = '2026-11-01T11:00:00.000Z';
		failBeforePlanTransition = false;
		const planned = await createPlanTasksNode(fixture.runtime)({ snapshot: planningSnapshot });
		const plan = fixture.store.getTaskPlan(fixture.runId);
		assert.equal(plan.schemaVersion, '2.0.0');
		assert.equal(plan.createdAt, '2026-11-01T10:00:00.000Z');
		assert.equal(planned.snapshot.taskPlanHash, hashTaskPlanProjection(plan));
		assert.notEqual(planned.snapshot.taskPlanHash, plan.planPolicyHash);

		let policyGatePayload;
		fixture.runtime.transition = (current, options) => {
			if (options.eventType === 'POLICY_GATE_EVALUATED') policyGatePayload = options.payload;
			return {
				...current,
				...options.updates,
				state: options.to,
				runtimeRevision: current.runtimeRevision + 1,
			};
		};
		await createEvaluatePolicyGateNode(fixture.runtime)({ snapshot: planned.snapshot });
		assert.equal(policyGatePayload.taskPlanHash, planned.snapshot.taskPlanHash);

		const critic = await runPlanCritic({
			runtime: fixture.runtime,
			snapshot: {
				...planned.snapshot,
				approvedPlanPolicyHash: authorization.approvedPlanPolicyHash,
				taskPlanFrozen: false,
			},
			plan,
		});
		assert.equal(critic.artifactHash, hashTaskPlanProjection(plan));
		assert.equal(critic.review.artifactHash, hashTaskPlanProjection(plan));
		const criticPrompt = fixture.governor.calls.find((call) => call.profile === 'critic-review')?.prompt;
		assert.ok(criticPrompt?.includes('checkpoint-evidence-v1'));
		assert.ok(criticPrompt?.includes('obligation-ac-01'));
		assert.ok(criticPrompt?.includes('planning-test'));
		assert.ok(criticPrompt?.includes(legacyPlan.slices[0].sliceId));

		const planHash = planned.snapshot.taskPlanHash;
		const changedObligation = structuredClone(plan);
		changedObligation.evidenceObligations[0].expectedResult = 'A different result.';
		assert.throws(() => assertTaskPlanHash(changedObligation, planHash), /TaskPlan hash/);

		const changedAdapter = structuredClone(plan);
		changedAdapter.adapterBindings[0].bundleFiles[0].sha256 = 'd'.repeat(64);
		changedAdapter.evidenceObligations[0].adapterBindingHash = sha256(
			changedAdapter.adapterBindings[0],
		);
		assert.throws(() => assertTaskPlanHash(changedAdapter, planHash), /TaskPlan hash/);

		const changedPolicy = structuredClone(plan);
		changedPolicy.qualityPolicy.review.maxOutputTokens += 1;
		changedPolicy.qualityPolicyHash = sha256(changedPolicy.qualityPolicy);
		assert.throws(() => assertTaskPlanHash(changedPolicy, planHash), /TaskPlan hash/);
	} finally {
		fixture.close();
	}
});

test('createEvaluatePolicyGateNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createEvaluatePolicyGateNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createEvaluatePolicyGateNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createEvaluatePolicyGateNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});

test('createExecutePlanCriticNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createExecutePlanCriticNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createExecutePlanCriticNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createExecutePlanCriticNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});

test('createAskPlanCriticNode returns the snapshot when no interrupt is pending', () => {
	const fixture = makeFixture('createAskPlanCriticNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createAskPlanCriticNode' });
		const result = createAskPlanCriticNode(fixture.runtime)({ snapshot: initial });
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.equal(result.humanResponse, null);
	} finally {
		fixture.close();
	}
});

test('createApplyPlanCriticNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createApplyPlanCriticNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createApplyPlanCriticNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createApplyPlanCriticNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});
