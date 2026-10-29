import '../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';
import { conditioningProposal, makeGraphFixture, reachSpecApproved } from '../testing/graph-fixtures.mjs';

test('plan critic P1 interrupts before worktree creation; accept_residual freezes the plan', async () => {
	const gitCalls = [];
	const fixture = makeGraphFixture(
		'slice2-plan-p1', 
		[
			conditioningProposal(),
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
			allowedPackages: ['apps/services/conditioning'],
			allowedPathPrefixes: ['apps/services/conditioning'],
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

test('prepare_workspace throws before git worktree add when the plan is unfrozen', async () => {
	const gitCalls = [];
	const fixture = makeGraphFixture(
		'slice2-prepare-unfrozen', 
		[conditioningProposal()], { profile: 'slice2', 
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
			allowedPackages: ['apps/services/conditioning'],
			allowedPathPrefixes: ['apps/services/conditioning'],
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
			conditioningProposal(),
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
			allowedPackages: ['apps/services/conditioning'],
			allowedPathPrefixes: ['apps/services/conditioning'],
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
