import '../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';
import { sha256 } from '../policy/contracts.ts';
import { planTaskDag } from '../policy/task-planner.ts';
import { parseAcceptanceCriterion } from './acceptance-criteria.ts';
import { policy as checkpointPolicy } from '../testing/quality-test-support.ts';
import { billingProposal, makeGraphFixture, reachSpecApproved } from '../testing/graph-fixtures.ts';
import { commandRegistrationFixture } from '../testing/command-registration-fixture.ts';

function qualityAuthorization(fixture, approved, now, policyVariant = false) {
	const draft = fixture.artifacts.readJson(approved.draftArtifact);
	const authorizationInput = {
		runId: fixture.runId,
		approvedSpecHash: approved.approvedSpecHash,
		repositoryId: 'fixture/repo',
		baseCommitSha: fixture.baseCommitSha,
		allowedPackages: ['services/billing'],
		allowedPathPrefixes: ['services/billing'],
		rootDir: fixture.runtime.rootDir,
		now: new Date(now),
	};
	const baseAuthorization = createDefaultAuthorizationEnvelope(authorizationInput);
	const plan = planTaskDag({
		draft,
		authorization: baseAuthorization,
		rootDir: fixture.runtime.rootDir,
		now: () => now,
	});
	const qualityPolicy = {
		...checkpointPolicy,
		review: {
			...checkpointPolicy.review,
			maxLogicalDispatches: 64,
			...(policyVariant ? { maxOutputTokens: checkpointPolicy.review.maxOutputTokens + 1 } : {}),
		},
	};
	const adapter = commandRegistrationFixture({ adapterId: 'plan-recovery-test', limits: { timeoutMs: 1000, maxReportBytes: 10000, maxArtifactBytes: 1000, maxArtifacts: 1 } });
	const obligations = [];
	for (const [index, text] of draft.acceptanceCriteria.entries()) {
		const parsed = parseAcceptanceCriterion(text, index);
		assert.equal(parsed.ok, true);
		const slice = plan.slices.find(
			(entry) => entry.kind !== 'enabling' && entry.acceptanceCriteria.includes(parsed.id),
		);
		assert.ok(slice);
		const cases = parsed.cases.length
			? parsed.cases.map((entry) => ({ caseId: entry.id, caseKey: entry.id }))
			: [{ caseId: null, caseKey: parsed.id }];
		for (const entry of cases) {
			obligations.push({
				obligationId: `obligation-${parsed.id}-${entry.caseKey}`,
				criterionId: parsed.id,
				caseId: entry.caseId,
				owner: { kind: 'slice', id: slice.sliceId },
				observableOutcome: 'The billing outcome is observable.',
				setupAction: 'Exercise the billing outcome.',
				expectedResult: 'The billing outcome matches the approved criterion.',
				layer: 'unit',
				requiredCapabilities: [],
				implementationPaths: ['services/billing'],
				testCases: [{
					file: `services/billing/${parsed.id.toLowerCase()}.spec.mjs`,
					caseKey: entry.caseKey,
				}],
				adapterBindingHash: sha256(adapter),
				profileId: 'unit',
			});
		}
	}
	const qualityPlan = {
		qualityPolicy,
		adapterBindings: [adapter],
		evidenceObligations: obligations,
	};
	return createDefaultAuthorizationEnvelope({
		...authorizationInput,
		qualityPlan,
	});
}

test('plan critic P1 interrupts before worktree creation; accept_residual freezes the plan', async () => {
	const gitCalls = [];
	const fixture = makeGraphFixture(
		'slice2-plan-p1', 
		[
			billingProposal(),
			{ __role: 'critic', status: 'PASS', findings: [] },
			{
				__role: 'critic',
				status: 'FAIL',
				findings: [
					{
						severity: 'P1',
						category: 'correctness',
						file: 'plan',
						evidence: 'High-risk path is sequenced after a consumer',
						impact: 'Unsafe worktree mutation',
						remediation: 'Serialize the kernel first',
					},
				],
			},
		], { profile: 'slice2', 
			gitCli: (cmd, args = [], opts = {}) => {
				gitCalls.push({ cmd, args });
				if (cmd === 'git' && args[0] === 'rev-parse') {
					return `${'a'.repeat(40)}\n`;
				}
				if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') {
					fs.mkdirSync(args[3] || args[2], { recursive: true });
					return '';
				}
				return '';
			},
		});

	try {
		const approved = await reachSpecApproved(fixture);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['services/billing'],
			allowedPathPrefixes: ['services/billing'],
		});
		const waiting = await fixture.runtime.authorize(approved, envelope);
		assert.equal(waiting.state, 'WAITING_FOR_PLAN_ACCEPTANCE');
		assert.equal(waiting.taskPlanFrozen, false);
		assert.equal(waiting.approvedPlanPolicyHash, envelope.approvedPlanPolicyHash);
		assert.equal(
			gitCalls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add'),
			false,
		);
		const pending = fixture.store.getPendingInterrupt(fixture.runId);
		assert.equal(pending.kind, 'plan_critic');
		const request = fixture.artifacts.readJson(pending.requestArtifact);
		assert.equal(request.criticReport.hasP1, true);

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
		const resumed = await fixture.runtime.resume(waiting, response);
		assert.equal(resumed.taskPlanFrozen, true);
		assert.equal(resumed.approvedPlanPolicyHash, envelope.approvedPlanPolicyHash);
		assert.ok(
			resumed.state === 'PREPARING_WORKSPACE' ||
				resumed.state === 'HYDRATING_WORKSPACE' ||
				resumed.state === 'EXECUTING_IMPLEMENTATION' ||
				resumed.state === 'READY_FOR_GIT_APPROVAL' ||
				resumed.state === 'BLOCKED' ||
				resumed.state === 'FAILED',
		);
	} finally {
		fixture.close();
	}
});

test('v2 plan critic reauthorization creates a new immutable plan generation through the graph', async () => {
	const fixture = makeGraphFixture(
		'slice2-v2-plan-reauth',
		[
			billingProposal(),
			{ __role: 'critic', status: 'PASS', findings: [] },
			{
				__role: 'critic',
				status: 'FAIL',
				findings: [{
					severity: 'P1',
					category: 'correctness',
					file: 'plan',
					evidence: 'The planned task order is unsafe.',
					impact: 'The implementation may violate its dependency.',
					remediation: 'Reauthorize and replan the tasks.',
				}],
			},
			{
				__role: 'critic',
				status: 'FAIL',
				findings: [{
					severity: 'P1',
					category: 'correctness',
					file: 'plan',
					evidence: 'The revised policy requires another review.',
					impact: 'The task plan remains blocked.',
					remediation: 'Resolve the remaining plan concern.',
				}],
			},
		],
		{ profile: 'slice2' },
	);
	try {
		const approved = await reachSpecApproved(fixture);
		let now = new Date().toISOString();
		fixture.runtime.now = () => new Date(now);
		const firstAuthorization = qualityAuthorization(fixture, approved, now);
		const waiting = await fixture.runtime.authorize(approved, firstAuthorization);
		assert.equal(waiting.state, 'WAITING_FOR_PLAN_ACCEPTANCE');
		const firstPlan = fixture.store.taskPlans.getImmutableTaskPlan(
			fixture.runId,
			firstAuthorization.approvedPlanPolicyHash,
		);
		assert.ok(firstPlan);

		const pending = fixture.store.getPendingInterrupt(fixture.runId);
		const response = {
			schemaVersion: '1.0.0',
			interruptId: pending.interruptId,
			stateHash: pending.stateHash,
			action: 'reauthorize',
		};
		fixture.store.recordInterruptResponse(
			pending.interruptId,
			fixture.artifacts.writeJson('human-response', response),
		);
		const reauthorized = await fixture.runtime.resume(waiting, response);
		assert.equal(reauthorized.state, 'WAITING_FOR_AUTHORIZATION');

		now = new Date(Date.parse(now) + 1000).toISOString();
		const secondAuthorization = qualityAuthorization(fixture, approved, now, true);
		const after = await fixture.runtime.authorize(reauthorized, secondAuthorization);
		assert.equal(after.state, 'WAITING_FOR_PLAN_ACCEPTANCE');
		assert.equal(after.approvedPlanPolicyHash, secondAuthorization.approvedPlanPolicyHash);
		assert.notEqual(after.approvedPlanPolicyHash, firstAuthorization.approvedPlanPolicyHash);
		assert.notEqual(after.taskPlanHash, waiting.taskPlanHash);
		assert.equal(after.taskPlanFrozen, false);
		assert.deepEqual(
			fixture.store.taskPlans.getImmutableTaskPlan(
				fixture.runId,
				firstAuthorization.approvedPlanPolicyHash,
			),
			firstPlan,
		);
		assert.equal(
			fixture.store.taskPlans.getImmutableTaskPlan(
				fixture.runId,
				secondAuthorization.approvedPlanPolicyHash,
			).createdAt,
			now,
		);
	} finally {
		fixture.close();
	}
});

test('graph restart reuses the exact v2 plan saved before a planning transition crash', async () => {
	const fixture = makeGraphFixture(
		'slice2-v2-plan-crash',
		[
			billingProposal(),
			{ __role: 'critic', status: 'PASS', findings: [] },
			{
				__role: 'critic',
				status: 'FAIL',
				findings: [{
					severity: 'P1',
					category: 'correctness',
					file: 'plan',
					evidence: 'The plan awaits operator review.',
					impact: 'Do not create a worktree yet.',
					remediation: 'Review the persisted plan.',
				}],
			},
		],
		{ profile: 'slice2' },
	);
	try {
		const approved = await reachSpecApproved(fixture);
		let now = new Date().toISOString();
		fixture.runtime.now = () => new Date(now);
		const authorization = qualityAuthorization(fixture, approved, now);
		const writeJson = fixture.artifacts.writeJson.bind(fixture.artifacts);
		fixture.artifacts.writeJson = (kind, ...args) => {
			if (kind === 'task-plan') throw new Error('injected crash before TASK_PLAN_GENERATED');
			return writeJson(kind, ...args);
		};
		await assert.rejects(
			fixture.runtime.authorize(approved, authorization),
			/injected crash before TASK_PLAN_GENERATED/,
		);
		const crashed = fixture.store.getRun(fixture.runId);
		assert.equal(crashed.state, 'PLANNING_TASKS');
		const savedBeforeCrash = fixture.store.taskPlans.getImmutableTaskPlan(
			fixture.runId,
			authorization.approvedPlanPolicyHash,
		);
		assert.ok(savedBeforeCrash);
		assert.equal(savedBeforeCrash.createdAt, now);

		fixture.artifacts.writeJson = writeJson;
		now = new Date(Date.parse(now) + 1000).toISOString();
		const resumed = await fixture.runtime.continue(crashed);
		assert.equal(resumed.state, 'WAITING_FOR_PLAN_ACCEPTANCE');
		assert.equal(resumed.taskPlanHash, fixture.store.getRun(fixture.runId).taskPlanHash);
		assert.deepEqual(
			fixture.store.taskPlans.getImmutableTaskPlan(
				fixture.runId,
				authorization.approvedPlanPolicyHash,
			),
			savedBeforeCrash,
		);
		assert.equal(fixture.store.getTaskPlan(fixture.runId).createdAt, savedBeforeCrash.createdAt);
	} finally {
		fixture.close();
	}
});

test('prepare_workspace throws before git worktree add when the plan is unfrozen', async () => {
	const gitCalls = [];
	const fixture = makeGraphFixture(
		'slice2-prepare-unfrozen', 
		[billingProposal()], { profile: 'slice2', 
			gitCli: (cmd, args = []) => {
				gitCalls.push({ cmd, args });
				if (cmd === 'git' && args[0] === 'rev-parse') {
					return `${'a'.repeat(40)}\n`;
				}
				if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') {
					fs.mkdirSync(args[3] || args[2], { recursive: true });
					return '';
				}
				return '';
			},
		});
	try {
		const approved = await reachSpecApproved(fixture);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['services/billing'],
			allowedPathPrefixes: ['services/billing'],
		});
		fixture.store.saveAuthorization(envelope);
		const unfrozen = {
			...approved,
			state: 'PREPARING_WORKSPACE',
			taskPlanFrozen: false,
			approvedPlanPolicyHash: envelope.approvedPlanPolicyHash,
			taskPlanHash: envelope.approvedPlanPolicyHash,
		};
		await assert.rejects(
			() =>
				fixture.runtime.graph.invoke(
					{ snapshot: unfrozen, humanResponse: null },
					{ configurable: { thread_id: `${approved.threadId}-unfrozen` } },
				),
			(error) => error.code === 'POLICY_VIOLATION' || error.cause?.code === 'POLICY_VIOLATION',
		);
		assert.equal(
			gitCalls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add'),
			false,
		);
	} finally {
		fixture.close();
	}
});

test('plan critic reauthorize requests a new envelope without reopening SPEC_APPROVED', async () => {
	const gitCalls = [];
	const fixture = makeGraphFixture(
		'slice2-plan-reauth', 
		[
			billingProposal(),
			{ __role: 'critic', status: 'PASS', findings: [] },
			{
				__role: 'critic',
				status: 'FAIL',
				findings: [
					{
						severity: 'P1',
						category: 'correctness',
						file: 'plan',
						evidence: 'Consumer is planned before the shared kernel',
						impact: 'Unsafe worktree mutation',
						remediation: 'Serialize the kernel first',
					},
				],
			},
		], { profile: 'slice2', 
			gitCli: (cmd, args = []) => {
				gitCalls.push({ cmd, args });
				if (cmd === 'git' && args[0] === 'rev-parse') {
					return `${'a'.repeat(40)}\n`;
				}
				if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') {
					fs.mkdirSync(args[3] || args[2], { recursive: true });
					return '';
				}
				return '';
			},
		});
	try {
		const approved = await reachSpecApproved(fixture);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['services/billing'],
			allowedPathPrefixes: ['services/billing'],
		});
		const waiting = await fixture.runtime.authorize(approved, envelope);
		assert.equal(waiting.state, 'WAITING_FOR_PLAN_ACCEPTANCE');
		const pending = fixture.store.getPendingInterrupt(fixture.runId);
		const response = {
			schemaVersion: '1.0.0',
			interruptId: pending.interruptId,
			stateHash: pending.stateHash,
			action: 'reauthorize',
		};
		fixture.store.recordInterruptResponse(
			pending.interruptId,
			fixture.artifacts.writeJson('human-response', response),
		);
		const reauth = await fixture.runtime.resume(waiting, response);
		assert.equal(reauth.state, 'WAITING_FOR_AUTHORIZATION');
		assert.equal(reauth.approvedSpecHash, approved.approvedSpecHash);
		assert.equal(reauth.taskPlanFrozen, false);
		assert.equal(reauth.taskPlanHash, null);
		const nextPending = fixture.store.getPendingInterrupt(fixture.runId);
		assert.equal(nextPending.kind, 'authorization');
		assert.equal(
			gitCalls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add'),
			false,
		);

		const after = await fixture.runtime.authorize(reauth, envelope);
		assert.equal(after.approvedSpecHash, approved.approvedSpecHash);
		assert.notEqual(after.state, 'SPEC_APPROVED');
		assert.equal(after.state, 'WAITING_FOR_PLAN_ACCEPTANCE');
		assert.equal(after.approvedPlanPolicyHash, envelope.approvedPlanPolicyHash);
		assert.equal(after.taskPlanFrozen, false);
		const planReviews = fixture.store
			.listCriticReviews(fixture.runId)
			.filter((review) => review.phase === 'plan');
		assert.equal(planReviews.length, 1);
		assert.equal(
			fixture.governor.calls.filter((call) => call.profile === 'critic-review').length,
			2,
		);
		assert.equal(
			gitCalls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add'),
			false,
		);
	} finally {
		fixture.close();
	}
});
