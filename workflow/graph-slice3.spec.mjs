import '../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';
import { RoleRegistry } from '../roles/role-registry.ts';
import {
	createMockExecCli,
	createMockGitCli,
	leanWriteAction,
	seedWorkspacePackageManifest,
} from '../testing/test-support.mjs';
import {
	billingProposal,
	implementerScript,
	makeGraphFixture,
	reachSpecApproved,
} from '../testing/graph-fixtures.mjs';

test('Slice 3 authorized local commits complete through DONE', async () => {
	const fixture = makeGraphFixture('slice3-done', implementerScript(), { profile: 'slice3' });
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

		const commit = fixture.store.getGitCommit(fixture.runId);
		assert.ok(commit);
		assert.equal(commit.commitSha, fixture.commitSha);
		assert.equal(commit.treeSha, fixture.targetTreeSha);
		assert.equal(commit.parentSha, fixture.baseCommitSha);
		assert.match(commit.targetBranch, /^agent-sdlc\//);

		const events = fixture.store.listEvents(fixture.runId).map((event) => event.eventType);
		assert.ok(events.includes('GIT_BRANCH_CREATED'));
		assert.ok(events.includes('GIT_COMMITTED'));
		assert.ok(events.includes('QA_CRITIC_COMPLETED'));
		assert.ok(events.includes('RUN_COMPLETED'));
		assert.equal(events.includes('RUN_READY_FOR_GIT_APPROVAL'), false);
		const qaReviews = fixture.store
			.listCriticReviews(fixture.runId)
			.filter((review) => review.phase === 'qa');
		assert.equal(qaReviews.length, 1);
		assert.equal(qaReviews[0].attemptKey, `qa:${terminal.approvedSpecHash}`);
		assert.equal(qaReviews[0].hasP1, false);
	} finally {
		fixture.close();
	}
});

test('Slice 3 without local commits still halts at READY_FOR_GIT_APPROVAL', async () => {
	const fixture = makeGraphFixture('slice3-ready', implementerScript(), { profile: 'slice3' });
	try {
		const approved = await reachSpecApproved(fixture);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['services/billing'],
			allowedPathPrefixes: ['services/billing'],
			createBranch: true,
			createLocalCommits: false,
		});
		const terminal = await fixture.runtime.authorize(approved, envelope);
		assert.equal(terminal.state, 'READY_FOR_GIT_APPROVAL');
		assert.equal(fixture.store.getGitCommit(fixture.runId), null);
		const qaReviews = fixture.store
			.listCriticReviews(fixture.runId)
			.filter((review) => review.phase === 'qa');
		assert.equal(qaReviews.length, 1);
		assert.equal(qaReviews[0].attemptKey, `qa:${terminal.approvedSpecHash}`);
	} finally {
		fixture.close();
	}
});

test('@ac AC-05 uncovered acceptance criteria do not block approval or burn a repair and proceed with advisory coverage artifact', async () => {
	const fixture = makeGraphFixture('slice3-ac-uncovered',  [
		billingProposal(),
		leanWriteAction(
			'services/billing/src/feature.ts',
			'export const feature = true;\n',
		),
		{
			action: { kind: 'complete', summary: 'Implemented without citing tests' },
		},
		{ action: { kind: 'complete', summary: 'Audit confirmed' } },
		{
			status: 'PASS',
			summary: 'Implementation looks solid',
			findings: [],
		},
	], { profile: 'slice3', 
		// The role ends without a citing spec. The package test stays green.
		// Under AC-05, missing docblock annotations do not block approval.
		execCli: createMockExecCli({ requireAcceptanceCitation: false }),
	});
	try {
		const approved = await reachSpecApproved(fixture);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['services/billing'],
			allowedPathPrefixes: ['services/billing'],
			maxSemanticRepairs: 0,
		});
		const terminal = await fixture.runtime.authorize(approved, envelope);
		assert.equal(terminal.state, 'READY_FOR_GIT_APPROVAL');
		const events = fixture.store.listEvents(fixture.runId);
		assert.equal(
			events.some((event) => event.eventType === 'AC_COVERAGE_FAILED'),
			false,
		);
		assert.equal(
			events.some((event) => event.eventType === 'AC_COVERAGE_PASSED'),
			true,
		);
		const passed = events.find((event) => event.eventType === 'AC_COVERAGE_PASSED');
		assert.ok(passed.payload.uncoveredAcIds.includes('AC-01'));
		assert.equal(passed.payload.coveragePass, false);
		assert.ok(passed.payload.coverageArtifact);
		const qaReviews = fixture.store
			.listCriticReviews(fixture.runId)
			.filter((review) => review.phase === 'qa');
		assert.equal(qaReviews.length, 1);
		assert.equal(
			events.some((event) => event.eventType === 'RUN_READY_FOR_GIT_APPROVAL'),
			true,
		);
	} finally {
		fixture.close();
	}
});

test('Slice 3 empty staged diff with createLocalCommits halts at READY_FOR_GIT_APPROVAL', async () => {
	const gitCli = createMockGitCli({
		onWorktreeAdd: seedWorkspacePackageManifest,
	});
	const emptyGitCli = (cmd, args = [], opts = {}) => {
		if (cmd === 'git' && args[0] === 'diff' && args.includes('--cached')) {
			return '';
		}
		return gitCli(cmd, args, opts);
	};
	const fixture = makeGraphFixture('slice3-empty',  implementerScript(), { profile: 'slice3',  gitCli: emptyGitCli });
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
		assert.equal(terminal.state, 'READY_FOR_GIT_APPROVAL');
		assert.equal(fixture.store.getGitCommit(fixture.runId), null);
	} finally {
		fixture.close();
	}
});

test('@ac AC-03 @case AC-03.2 Slice 3 extended-role fixture inserts optional roles through configuration', async () => {
	const tempRoot = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`slice3-roles-cfg-${crypto.randomUUID()}`,
	);
	const workflowDir = path.join(tempRoot, '.agents/workflows');
	fs.mkdirSync(path.join(workflowDir, 'roles'), { recursive: true });
	fs.mkdirSync(path.join(workflowDir, 'prompts'), { recursive: true });
	const baseWorkflow = new RoleRegistry({ rootDir: REPOSITORY_ROOT }).loadWorkflow();
	const workflowPath = path.join(workflowDir, 'custom-extended.json');
	fs.writeFileSync(
		path.join(workflowDir, 'roles/architect.json'),
		JSON.stringify({
			schemaVersion: '1.0.0',
			roleId: 'architect',
			roleKind: 'review',
			insertionPoint: 'pre_review',
			modelProfile: 'agent-sdlc-deterministic',
			promptFile: 'architect.md',
			capabilityId: 'architect-analysis-v1',
			evaluatorId: 'architect-evaluation-v1',
			requestedLimits: {
				maxPromptTokens: 0,
				maxCompletionTokens: 0,
				timeoutMs: 60000,
				maxPhysicalAttempts: 1,
				maxRetriesPerRoute: 0,
				maxFailovers: 0,
			},
		}),
	);
	fs.writeFileSync(path.join(workflowDir, 'prompts/architect.md'), '# Architect policy\n');
	fs.writeFileSync(
		workflowPath,
		JSON.stringify({
			...baseWorkflow,
			workflowId: 'custom-extended',
			roles: ['specifier', 'implementer', 'architect', 'reviewer', 'critic-reviewer'],
			pipelines: {
				post_implement: [],
				pre_review: ['architect'],
				review: [],
			},
		}),
	);

	const fixture = makeGraphFixture(
		'slice3-roles',
		[
			...implementerScript(),
			{ status: 'PASS', findings: [] },
		],
		{ profile: 'slice3' },
	);
	const customRegistry = new RoleRegistry({ rootDir: tempRoot, workflowPath });
	const baseLoadRole = fixture.registry.loadRole.bind(fixture.registry);
	fixture.registry.loadWorkflow = () => customRegistry.loadWorkflow();
	fixture.registry.loadPipeline = (point, opts) => customRegistry.loadPipeline(point, opts);
	fixture.registry.loadRole = (roleId, opts) =>
		roleId === 'architect' ? customRegistry.loadRole(roleId, opts) : baseLoadRole(roleId, opts);
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

		const roles = fixture.store.listOptionalRoleExecutions(fixture.runId);
		const roleIds = roles.map((role) => role.roleId).sort();
		assert.equal(roleIds.includes('cleaner'), false);
		assert.equal(roleIds.includes('hardener'), false);
		assert.ok(roleIds.includes('architect'));
	} finally {
		fixture.close();
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

const QA_P1_FINDING = {
	severity: 'P1',
	category: 'testing',
	file: 'services/billing/src/main.ts',
	evidence: 'Acceptance criteria are not covered by assertions',
	impact: 'Green preflight can ship unproven behavior',
	remediation: 'Add shadow-path tests for the changed feature',
};

test('@ac AC-05 @case AC-05.1 repairable verifier FAIL escalates without a repairer and keeps the failure packet', async () => {
	const fixture = makeGraphFixture('slice3-repair-retired',  implementerScript(), { profile: 'slice3', 
		execCli: createMockExecCli({ preflightStatus: 'FAIL' }),
	});
	try {
		const approved = await reachSpecApproved(fixture);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['services/billing'],
			allowedPathPrefixes: ['services/billing'],
			maxSemanticRepairs: 1,
		});
		const terminal = await fixture.runtime.authorize(approved, envelope);
		assert.equal(terminal.state, 'ESCALATED');
		assert.equal(terminal.blockedReason, 'AUTONOMOUS_REPAIR_RETIRED');
		const repairerCalls = fixture.governor.calls.filter(
			(call) => call.attribution?.roleId === 'repairer',
		);
		assert.equal(repairerCalls.length, 0);
		const blocked = fixture.store
			.listEvents(fixture.runId)
			.filter((event) => event.eventType === 'RUN_BLOCKED')
			.at(-1);
		assert.ok(blocked);
		assert.ok(blocked.payload.failurePacket);
		assert.equal(blocked.payload.reason, 'AUTONOMOUS_REPAIR_RETIRED');
	} finally {
		fixture.close();
	}
});

