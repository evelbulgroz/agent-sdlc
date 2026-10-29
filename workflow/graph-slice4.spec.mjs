import '../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';

import {
	citingSpecWriteAction,
	leanWriteAction,
	createMockGitCli,
} from '../testing/test-support.mjs';
import {
	billingProposal,
	makeGraphFixture,
	reachSpecApproved,
	seedSlice4Worktree,
	slice4ImplementerScript,
	twoTaskScript,
} from '../testing/graph-fixtures.mjs';

test('Slice 4 disjoint parallel tasks execute, reconcile, and reach DONE with authorized commits', async () => {
	const surfaces = [
		'services/billing/src/feat1.ts',
		'services/assessment/src/feat2.ts',
	];
	const fixture = makeGraphFixture('s4-disjoint-done', twoTaskScript(surfaces), { profile: 'slice4' });
	try {
		const approved = await reachSpecApproved(fixture);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['services/billing', 'services/assessment'],
			allowedPathPrefixes: ['services/billing', 'services/assessment'],
			createBranch: true,
			createLocalCommits: true,
		});

		const terminal = await fixture.runtime.authorize(approved, envelope);
		assert.equal(terminal.state, 'DONE', terminal.lastError ? JSON.stringify(terminal.lastError) : JSON.stringify(terminal));

		// 1. Verify DAG task plan
		const plan = fixture.store.getTaskPlan(fixture.runId);
		assert.ok(plan);
		assert.equal(plan.isParallel, true);
		assert.equal(plan.tasks.length, 2);

		const task1 = fixture.store.getTask(fixture.runId, plan.integrationOrder[0]);
		const task2 = fixture.store.getTask(fixture.runId, plan.integrationOrder[1]);
		assert.equal(task1.status, 'completed');
		assert.equal(task2.status, 'completed');
		assert.ok(task1.targetTreeSha);
		assert.ok(task2.targetTreeSha);

		// 2. Verify reconciliation
		const reconciliation = fixture.store.getLatestReconciliation(fixture.runId);
		assert.ok(reconciliation);
		assert.equal(reconciliation.status, 'RECONCILIATION_COMPLETED');
		assert.ok(reconciliation.reconciledTreeSha);
		assert.deepEqual(reconciliation.integrationOrder, plan.integrationOrder);

		// 3. Verify commit record
		const commit = fixture.store.getGitCommit(fixture.runId);
		assert.ok(commit);
		assert.equal(commit.commitSha, fixture.commitSha);
		assert.match(commit.targetBranch, /^agent-sdlc\//);

		// 4. Verify canonical events
		const events = fixture.store.listEvents(fixture.runId).map((e) => e.eventType);
		assert.ok(events.includes('TASK_PLAN_GENERATED'));
		assert.ok(events.includes('POLICY_GATE_EVALUATED'));
		assert.ok(events.includes('TASK_STARTED'));
		assert.ok(events.includes('TASK_COMPLETED'));
		assert.ok(events.includes('RECONCILIATION_STARTED'));
		assert.ok(events.includes('RECONCILIATION_COMPLETED'));
		assert.ok(events.includes('GIT_BRANCH_CREATED'));
		assert.ok(events.includes('GIT_COMMITTED'));
		assert.ok(events.includes('RUN_COMPLETED'));

		// 5. Verify multi-task integration worktree was hydrated before verification
		const integrationWorktreePath = terminal.integrationWorktreePath;
		assert.ok(integrationWorktreePath, 'integrationWorktreePath must be defined');
		assert.ok(
			fixture.execCalls.some(
				(c) =>
					c.cmd === 'pnpm' &&
					c.args.includes('install') &&
					c.args.includes('--frozen-lockfile') &&
					c.opts.cwd === integrationWorktreePath,
			),
			'Integration worktree must be hydrated with pnpm install before verification',
		);

		// 6. Verify status projection includes tasks array
		const statusResult = fixture.projection.readStatusResult();
		assert.ok(Array.isArray(statusResult.tasks), 'statusResult.tasks must be an array');
		assert.equal(statusResult.tasks.length, 2);
		assert.equal(statusResult.tasks[0].status, 'completed');
		assert.equal(statusResult.tasks[1].status, 'completed');
	} finally {
		fixture.close();
	}
});

test('Slice 4 disjoint parallel tasks without local commits halt at READY_FOR_GIT_APPROVAL', async () => {
	const surfaces = [
		'services/billing/src/feat1.ts',
		'services/assessment/src/feat2.ts',
	];
	const fixture = makeGraphFixture('s4-disjoint-ready', twoTaskScript(surfaces), { profile: 'slice4' });
	try {
		const approved = await reachSpecApproved(fixture);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['services/billing', 'services/assessment'],
			allowedPathPrefixes: ['services/billing', 'services/assessment'],
			createBranch: true,
			createLocalCommits: false,
		});

		const terminal = await fixture.runtime.authorize(approved, envelope);
		assert.equal(terminal.state, 'READY_FOR_GIT_APPROVAL', terminal.lastError ? JSON.stringify(terminal.lastError) : JSON.stringify(terminal));
		assert.equal(fixture.store.getGitCommit(fixture.runId), null);
		assert.ok(terminal.integrationWorktreePath);

		const events = fixture.store.listEvents(fixture.runId).map((e) => e.eventType);
		assert.ok(events.includes('RUN_READY_FOR_GIT_APPROVAL'));
		assert.equal(events.includes('GIT_COMMITTED'), false);
	} finally {
		fixture.close();
	}
});

test('Slice 4 shared package serialization serializes kernel before consumer (AC 16)', async () => {
	const surfaces = [
		'packages/shared-base/src/feat.ts',
		'services/billing/src/feat.ts',
	];
	const fixture = makeGraphFixture('s4-shared-kernel', twoTaskScript(surfaces), { profile: 'slice4' });
	try {
		const approved = await reachSpecApproved(fixture);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['packages/shared-base', 'services/billing'],
			allowedPathPrefixes: ['packages/shared-base', 'services/billing'],
			createBranch: true,
			createLocalCommits: true,
		});

		const terminal = await fixture.runtime.authorize(approved, envelope);
		assert.equal(
			terminal.state,
			'DONE',
			terminal.error
				? `${terminal.error.code}: ${terminal.error.message}`
				: JSON.stringify(terminal),
		);

		const plan = fixture.store.getTaskPlan(fixture.runId);
		assert.ok(plan);

		// shared-base must be serialized before billing
		const dddTask = plan.tasks.find((t) => t.targetPackage === 'packages/shared-base');
		const billingTask = plan.tasks.find((t) => t.targetPackage === 'services/billing');
		assert.ok(dddTask);
		assert.ok(billingTask);
		assert.equal(dddTask.integrationOrder, 0);
		assert.equal(billingTask.integrationOrder, 1);
		assert.ok(billingTask.dependsOn.includes(dddTask.taskId));
	} finally {
		fixture.close();
	}
});

test('Slice 4 contract producer serialization orders producer before consumer (AC 15, 16)', async () => {
	const surfaces = [
		'services/registry/src/contracts.ts',
		'services/authentication/src/auth.ts',
	];
	const fixture = makeGraphFixture('s4-contract-producer', twoTaskScript(surfaces), { profile: 'slice4' });
	try {
		const approved = await reachSpecApproved(fixture);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['services/registry', 'services/authentication'],
			allowedPathPrefixes: ['services/registry', 'services/authentication'],
			createBranch: true,
			createLocalCommits: true,
		});

		const terminal = await fixture.runtime.authorize(approved, envelope);
		assert.equal(terminal.state, 'DONE');

		const plan = fixture.store.getTaskPlan(fixture.runId);
		assert.ok(plan);

		const registryTask = plan.tasks.find((t) => t.targetPackage === 'services/registry');
		const authTask = plan.tasks.find((t) => t.targetPackage === 'services/authentication');
		assert.ok(registryTask);
		assert.ok(authTask);
		assert.ok(registryTask.integrationOrder < authTask.integrationOrder);
	} finally {
		fixture.close();
	}
});

test('Slice 4 single-task backward compatibility reuses legacy worktree and identity reconcile', async () => {
	const script = [
		billingProposal(),
		leanWriteAction(
			'services/billing/src/file.ts',
			'export const legacy = true;\n',
		),
		citingSpecWriteAction(),
		{ action: { kind: 'complete', summary: 'Done' } },
		{ action: { kind: 'complete', summary: 'Audit confirmed' } },
		{
			schemaVersion: '1.0.0',
			status: 'PASS',
			summary: 'Single task review passed',
			findings: [],
		},
	];

	const fixture = makeGraphFixture('s4-single-task', script, { profile: 'slice4' });
	try {
		const approved = await reachSpecApproved(fixture);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['services/billing'],
			allowedPathPrefixes: ['services/billing'],
			createBranch: true,
			createLocalCommits: true,
		});

		const terminal = await fixture.runtime.authorize(approved, envelope);
		assert.equal(terminal.state, 'DONE');

		const plan = fixture.store.getTaskPlan(fixture.runId);
		assert.ok(plan);
		assert.equal(plan.isParallel, false);
		assert.equal(plan.tasks.length, 1);
		assert.equal(plan.tasks[0].taskId, 'task-0');
		assert.equal(plan.tasks[0].worktreeSubdir, 'worktree');

		const recon = fixture.store.getLatestReconciliation(fixture.runId);
		assert.ok(recon);
		assert.equal(recon.status, 'RECONCILIATION_COMPLETED');
	} finally {
		fixture.close();
	}
});

test('@ac AC-03 @case AC-03.2 execute_reviewer under default workflow does not dispatch phase=code critic', async () => {
	const fixture = makeGraphFixture('s4-no-default-code', slice4ImplementerScript(), {
		profile: 'slice4',
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
		const terminal = await fixture.runtime.authorize(approved, envelope);
		assert.equal(terminal.state, 'READY_FOR_GIT_APPROVAL');
		assert.equal(
			fixture.governor.calls.filter((call) =>
				String(call.operationId || '').includes(':critic:code:'),
			).length,
			0,
		);
		assert.equal(
			fixture.store.listCriticReviews(fixture.runId).filter((review) => review.phase === 'code')
				.length,
			0,
		);
		const roleIds = fixture.store.listOptionalRoleExecutions(fixture.runId).map((role) => role.roleId);
		assert.equal(roleIds.includes('critic-reviewer'), false);
	} finally {
		fixture.close();
	}
});

test('Slice 4 failing task verification ends FAILED without a repairer', async () => {
	const surfaces = [
		'services/billing/src/feat1.ts',
		'services/assessment/src/feat2.ts',
	];
	const baseCommitSha = 'a'.repeat(40);
	const targetTreeSha = 'b'.repeat(40);
	const commitSha = 'c'.repeat(40);
	const gitCli = createMockGitCli({
		baseCommitSha,
		targetTreeSha,
		commitSha,
		onWorktreeAdd: seedSlice4Worktree,
	});
	const fixture = makeGraphFixture('s4-repair-escalate',  twoTaskScript(surfaces), { profile: 'slice4',  gitCli });
	const originalExecCli = fixture.runtime.execCli;
	fixture.runtime.execCli = (cmd, args = [], opts = {}) => {
		if (args.includes('test')) {
			const err = new Error('Unit tests failed');
			err.status = 1;
			err.stdout = 'FAIL services/billing/src/feat1.spec.ts';
			err.stderr = '';
			throw err;
		}
		return originalExecCli(cmd, args, opts);
	};
	try {
		const approved = await reachSpecApproved(fixture);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['services/billing', 'services/assessment'],
			allowedPathPrefixes: ['services/billing', 'services/assessment'],
			maxSemanticRepairs: 0,
		});
		const terminal = await fixture.runtime.authorize(approved, envelope);
		assert.equal(terminal.state, 'FAILED', JSON.stringify(terminal.lastError ?? terminal));
		assert.equal(terminal.lastError?.code, 'TASK_EXECUTION_FAILED');
		assert.equal(terminal.lastError?.metadata?.failureReason, 'verification-failed');
		assert.equal(
			fixture.governor.calls.filter((call) => call.attribution?.roleId === 'repairer').length,
			0,
		);
	} finally {
		fixture.close();
	}
});
