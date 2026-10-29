import '../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { SdlcError } from '../policy/errors.ts';
import {
	answersForPending,
	completeProposal,
	createMockExecCli,
	makeFixture,
} from '../testing/test-support.mjs';
import { canonicalJson, createEvent, sha256 } from '../policy/contracts.ts';
import { buildTaskPromptContexts } from './nodes/execute-tasks.ts';
import { executePreflightForSnapshot } from './preflight-gate.ts';
import { computeContinuation, StatusProjection } from '../cli/status-projection.ts';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';

test('buildTaskPromptContexts adds assumptions cited by the slice criteria', () => {
	const contexts = buildTaskPromptContexts({
		draft: {
			goal: 'g',
			acceptanceCriteria: ['AC-01: bands follow A-04.', 'AC-02: unrelated.'],
			assumptions: ['A-04 Severity. Heat is severe at 38C.', 'A-05 Other.'],
			invariantsAndConstraints: ['Keep it pure.'],
		},
		taskPlan: {
			slices: [{ sliceId: 's1', goal: 'sg', acceptanceCriteria: ['AC-01'] }],
			tasks: [{ taskId: 't1', sliceId: 's1', authoredPaths: ['a.ts'] }],
		},
	});
	assert.deepEqual(contexts.t1.invariantsAndConstraints, [
		'Keep it pure.',
		'Assumption A-04 Severity. Heat is severe at 38C.',
	]);
});

test('buildTaskPromptContexts maps only each task slice criteria and evidence', () => {
	const contexts = buildTaskPromptContexts({
		draft: {
			goal: 'Whole feature',
			acceptanceCriteria: [
				'AC-01: Foundation behavior',
				'AC-02: Activation behavior',
			],
		},
		taskPlan: {
			slices: [
				{
					sliceId: 'foundation',
					goal: 'Build foundation',
					acceptanceCriteria: ['AC-01'],
				},
				{
					sliceId: 'activation',
					goal: 'Activate feature',
					acceptanceCriteria: ['AC-02'],
				},
			],
			tasks: [
				{
					taskId: 'foundation-task',
					sliceId: 'foundation',
					authoredPaths: ['tools/agent-sdlc/workflow/graph.mjs'],
					generatedOutputs: [],
					dependsOn: [],
					dependencyMutations: [],
					highRisk: false,
					verificationCommand: ['node', '--test', 'tools/agent-sdlc/graph.spec.mjs'],
				},
			],
		},
	});
	assert.equal(contexts['foundation-task'].sliceGoal, 'Build foundation');
	assert.deepEqual(contexts['foundation-task'].acceptanceCriteria, [
		'AC-01: Foundation behavior',
	]);
	assert.equal(
		contexts['foundation-task'].acceptanceCriteria.some((criterion) =>
			criterion.includes('AC-02'),
		),
		false,
	);
	assert.equal(contexts['foundation-task'].derivedRisk, 'standard');
	assert.equal(contexts['foundation-task'].contractVerificationCommands, undefined);
});

test('buildTaskPromptContexts attaches contract commands only on the preserving sink', () => {
	const packages = {
		packageMap: new Map([
			[
				'@example/demo-service',
				{
					packagePath: 'apps/services/demo',
					pkgJson: {
						name: '@example/demo-service',
						scripts: {
							'build:contracts': 'node build.mjs',
							'check:contract-drift':
								'bash ../../../tools/check-contract-drift.sh apps/services/demo openapi/demo.openapi.json contracts/generated-api.ts',
						},
					},
				},
			],
		]),
		pathToPackage: new Map([['apps/services/demo', '@example/demo-service']]),
	};
	const taskPlan = {
		slices: [{ sliceId: 's1', goal: 'Preserve', acceptanceCriteria: ['AC-01'] }],
		tasks: [
			{
				taskId: 'foundation-task',
				sliceId: 's1',
				targetPackage: 'apps/services/demo',
				dependsOn: [],
				authoredPaths: ['apps/services/demo/src/helper.ts'],
			},
			{
				taskId: 'sink-task',
				sliceId: 's1',
				targetPackage: 'apps/services/demo',
				dependsOn: ['foundation-task'],
				authoredPaths: ['apps/services/demo/src'],
			},
		],
	};
	const contexts = buildTaskPromptContexts({
		draft: {
			goal: 'Preserve the contract',
			acceptanceCriteria: ['AC-01: The OpenAPI document must not change.'],
		},
		taskPlan,
		workspacePackages: packages,
	});
	assert.equal(contexts['foundation-task'].contractVerificationCommands, undefined);
	assert.deepEqual(contexts['sink-task'].contractVerificationCommands, [
		['pnpm', '--filter', '@example/demo-service', 'run', 'build:contracts'],
		['pnpm', '--filter', '@example/demo-service', 'run', 'check:contract-drift'],
		['pnpm', 'run', 'quality:changed'],
	]);
	const plain = buildTaskPromptContexts({
		draft: { goal: 'g', acceptanceCriteria: ['AC-01: OpenAPI lists the new field.'] },
		taskPlan,
		workspacePackages: packages,
	});
	assert.equal(plain['sink-task'].contractVerificationCommands, undefined);
});

async function reachQuestions(fixture) {
	const initial = fixture.runtime.initialize({
		runId: fixture.runId,
		goal: 'Build a durable local specification workflow',
	});
	const waiting = await fixture.runtime.start(initial);
	assert.equal(waiting.state, 'WAITING_FOR_ANSWERS');
	return waiting;
}

async function recordAndResume(fixture, state, response) {
	const artifact = fixture.artifacts.writeJson('human-response', response);
	fixture.store.recordInterruptResponse(state.pendingInterruptId, artifact);
	return fixture.runtime.resume(state, response);
}

test('synthetic workflow reaches exact hash-bound approval', async () => {
	const fixture = makeFixture('graph-approval', [completeProposal()]);
	try {
		let state = await reachQuestions(fixture);
		const pendingQuestions = fixture.store.getPendingInterrupt(fixture.runId);
		const answers = answersForPending(pendingQuestions);
		state = await recordAndResume(fixture, state, answers);
		assert.equal(state.state, 'WAITING_FOR_APPROVAL');
		assert.equal(state.completeness.complete, true);
		const pendingApproval = fixture.store.getPendingInterrupt(fixture.runId);
		const approvalRequest = fixture.artifacts.readJson(pendingApproval.requestArtifact);
		const approval = {
			schemaVersion: '1.0.0',
			interruptId: pendingApproval.interruptId,
			stateHash: pendingApproval.stateHash,
			action: 'approve',
			approvalHash: approvalRequest.approval.approvalHash,
			draftHash: state.draftHash,
			changes: [],
		};
		state = await recordAndResume(fixture, state, approval);
		assert.equal(state.state, 'SPEC_APPROVED');
		assert.equal(state.approvedSpecHash, state.draftHash);
		assert.equal(
			fixture.store.listEvents(fixture.runId).filter((event) => event.eventType === 'SPEC_APPROVED')
				.length,
			1,
		);
		assert.throws(
			() =>
				fixture.store.recordInterruptResponse(
					pendingApproval.interruptId,
					fixture.artifacts.writeJson('human-response', approval),
				),
			(error) => error.code === 'INTERRUPT_RESOLVED',
		);
	} finally {
		fixture.close();
	}
});

test('critic route exhaustion is deferred and projected without blocking spec approval', async () => {
	const fixture = makeFixture('graph-critic-unavailable', [
		completeProposal(),
		new SdlcError('GOVERNOR_ROUTES_EXHAUSTED', 'All critic routes failed'),
	]);
	try {
		let state = await reachQuestions(fixture);
		const pendingQuestions = fixture.store.getPendingInterrupt(fixture.runId);
		state = await recordAndResume(fixture, state, answersForPending(pendingQuestions));
		assert.equal(state.state, 'WAITING_FOR_APPROVAL');
		assert.equal(state.blockedReason, null);

		const failure = fixture.store
			.listEvents(fixture.runId)
			.find((event) => event.eventType === 'CRITIC_REVIEW_FAILED');
		assert.equal(failure.payload.phase, 'spec');
		assert.equal(failure.payload.code, 'GOVERNOR_ROUTES_EXHAUSTED');

		const projection = new StatusProjection({
			paths: { runId: fixture.runId, runtimeDir: fixture.runtimeDir },
			runtimeStore: fixture.store,
			artifactStore: fixture.artifacts,
		});
		assert.deepEqual(projection.readStatusResult().criticFailures, [
			{
				phase: 'spec',
				code: 'GOVERNOR_ROUTES_EXHAUSTED',
				message: 'Critic unavailable after all configured provider routes failed',
			},
		]);
	} finally {
		fixture.close();
	}
});

test('@ac AC-03 an identical-reviewer-vendor failure is deferred like route exhaustion without blocking spec approval', async () => {
	const fixture = makeFixture('graph-critic-identical-vendor', [
		completeProposal(),
		new SdlcError(
			'IDENTICAL_REVIEWER_VENDOR',
			"Reviewer vendor 'openai' matches an excluded author vendor: openai",
		),
	]);
	try {
		let state = await reachQuestions(fixture);
		const pendingQuestions = fixture.store.getPendingInterrupt(fixture.runId);
		state = await recordAndResume(fixture, state, answersForPending(pendingQuestions));
		assert.equal(state.state, 'WAITING_FOR_APPROVAL');
		assert.equal(state.blockedReason, null);

		const failure = fixture.store
			.listEvents(fixture.runId)
			.find((event) => event.eventType === 'CRITIC_REVIEW_FAILED');
		assert.equal(failure.payload.phase, 'spec');
		assert.equal(failure.payload.code, 'IDENTICAL_REVIEWER_VENDOR');

		const projection = new StatusProjection({
			paths: { runId: fixture.runId, runtimeDir: fixture.runtimeDir },
			runtimeStore: fixture.store,
			artifactStore: fixture.artifacts,
		});
		assert.deepEqual(projection.readStatusResult().criticFailures, [
			{
				phase: 'spec',
				code: 'IDENTICAL_REVIEWER_VENDOR',
				message:
					'Critic unavailable: no reviewer vendor is distinct from the author vendor',
			},
		]);
	} finally {
		fixture.close();
	}
});

test('@case AC-03.1 CRITIC_REVIEW_FAILED is not deferred and still blocks the run', async () => {
	const fixture = makeFixture('graph-critic-review-failed', [
		completeProposal(),
		new SdlcError('CRITIC_REVIEW_FAILED', 'Critic review output status must be PASS or FAIL'),
	]);
	try {
		let state = await reachQuestions(fixture);
		const pendingQuestions = fixture.store.getPendingInterrupt(fixture.runId);
		state = await recordAndResume(fixture, state, answersForPending(pendingQuestions));
		assert.equal(state.state, 'BLOCKED');
		assert.equal(state.blockedReason, 'CRITIC_REVIEW_FAILED');
	} finally {
		fixture.close();
	}
});

test('@case AC-03.1 AUTHOR_VENDOR_UNKNOWN is not deferred and still blocks the run', async () => {
	const fixture = makeFixture('graph-critic-author-vendor-unknown', [
		completeProposal(),
		new SdlcError('AUTHOR_VENDOR_UNKNOWN', 'Author vendor could not be resolved'),
	]);
	try {
		let state = await reachQuestions(fixture);
		const pendingQuestions = fixture.store.getPendingInterrupt(fixture.runId);
		state = await recordAndResume(fixture, state, answersForPending(pendingQuestions));
		assert.equal(state.state, 'BLOCKED');
		assert.equal(state.blockedReason, 'AUTHOR_VENDOR_UNKNOWN');
	} finally {
		fixture.close();
	}
});

test('non-route critic failures remain fail-closed', async () => {
	const fixture = makeFixture('graph-critic-budget-denied', [
		completeProposal(),
		new SdlcError('GOVERNOR_BUDGET_DENIED', 'Critic budget denied'),
	]);
	try {
		let state = await reachQuestions(fixture);
		const pendingQuestions = fixture.store.getPendingInterrupt(fixture.runId);
		state = await recordAndResume(fixture, state, answersForPending(pendingQuestions));
		assert.equal(state.state, 'BUDGET_EXHAUSTED');
		assert.equal(state.blockedReason, 'GOVERNOR_BUDGET_DENIED');
		assert.equal(
			fixture.store
				.listEvents(fixture.runId)
				.some((event) => event.eventType === 'CRITIC_REVIEW_FAILED'),
			false,
		);
	} finally {
		fixture.close();
	}
});

test('@ac AC-13 governor budget and route failures become durable distinguishable states', async () => {
	for (const [error, expected] of [
		[new SdlcError('GOVERNOR_BUDGET_DENIED', 'budget'), 'BUDGET_EXHAUSTED'],
		[new SdlcError('GOVERNOR_ROUTES_EXHAUSTED', 'routes'), 'BLOCKED'],
		[new SdlcError('GOVERNOR_RUN_DEADLINE_EXPIRED', 'Run deadline has expired'), 'BLOCKED'],
	]) {
		const fixture = makeFixture(`graph-${expected.toLowerCase()}`, [error]);
		try {
			const initial = fixture.runtime.initialize({
				runId: fixture.runId,
				goal: 'Build the workflow',
			});
			const state = await fixture.runtime.start(initial);
			assert.equal(state.state, expected);
			assert.equal(state.blockedReason, error.code);
			assert.equal(fixture.store.getModelOperation(state.activeModelOperationId).status, 'failed');
			if (expected === 'BUDGET_EXHAUSTED' || error.code === 'GOVERNOR_RUN_DEADLINE_EXPIRED') {
				const continuation = computeContinuation(state);
				assert.equal(continuation.action, 'stop');
				assert.equal(continuation.reason, 'HALTED');
			}
		} finally {
			fixture.close();
		}
	}
});

function persistRuntimeSnapshot(fixture, snapshot) {
	fixture.store.database
		.prepare('UPDATE runs SET state = ?, state_json = ?, state_hash = ? WHERE run_id = ?')
		.run(snapshot.state, canonicalJson(snapshot), sha256(snapshot), fixture.runId);
}

function prepareVerifierSnapshot(fixture, state) {
	const approvedSpecHash = 'a'.repeat(64);
	const baseCommitSha = 'b'.repeat(40);
	const targetTreeSha = 'c'.repeat(40);
	const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'Retire autonomous repair' });
	const snapshot = {
		...initial,
		state,
		approvedSpecHash,
		worktreePath: fixture.runtimeDir,
		integrationWorktreePath: fixture.runtimeDir,
		targetTreeSha,
		activeGeneration: 0,
	};
	persistRuntimeSnapshot(fixture, snapshot);
	fixture.store.saveAuthorization(createDefaultAuthorizationEnvelope({
		runId: fixture.runId,
		approvedSpecHash,
		baseCommitSha,
		allowedPackages: ['apps/services/conditioning'],
		allowedPathPrefixes: ['apps/services/conditioning'],
	}));
	return { snapshot, baseCommitSha, targetTreeSha };
}

test('@ac AC-05 @case AC-05.2 a repairable committed-tree FAIL escalates with AUTONOMOUS_REPAIR_RETIRED', async () => {
	const fixture = makeFixture('graph-repair-retired-committed', []);
	try {
		const { snapshot, targetTreeSha } = prepareVerifierSnapshot(fixture, 'VERIFYING_COMMITTED_TREE');
		const head = 'd'.repeat(40);
		fixture.runtime.gitCli = (_cmd, args = []) => {
			if (args[0] === 'status') return '';
			if (args[0] === 'rev-parse' && args[1] === 'HEAD') return `${head}\n`;
			if (args[0] === 'rev-parse' && String(args[1]).includes('^{tree}')) return `${targetTreeSha}\n`;
			return '';
		};
		fixture.runtime.execCli = createMockExecCli({ preflightStatus: 'FAIL' });
		const result = await fixture.runtime.graph.invoke(
			{ snapshot },
			{ configurable: { thread_id: fixture.runId } },
		);
		assert.equal(result.snapshot.state, 'ESCALATED');
		assert.equal(result.snapshot.blockedReason, 'AUTONOMOUS_REPAIR_RETIRED');
		assert.equal(fixture.governor.calls.length, 0);
	} finally {
		fixture.close();
	}
});

test('@ac AC-05 @case AC-05.3 a resume already in REPAIRING_FAILURE escalates and keeps the failure packet', async () => {
	const fixture = makeFixture('graph-repair-retired-resume', []);
	try {
		const { snapshot } = prepareVerifierSnapshot(fixture, 'REPAIRING_FAILURE');
		const failurePacket = {
			schemaVersion: '1.0.0',
			failedCommand: 'pnpm test',
			sanitizedOutput: 'assertion failed',
		};
		fixture.store.appendEvent(createEvent({
			eventType: 'RUN_BLOCKED',
			runId: fixture.runId,
			runtimeRevision: snapshot.runtimeRevision,
			state: snapshot,
			causalId: 'seed-failure-packet',
			payload: { failurePacket },
		}));
		const result = await fixture.runtime.graph.invoke(
			{ snapshot },
			{ configurable: { thread_id: fixture.runId } },
		);
		assert.equal(result.snapshot.state, 'ESCALATED');
		assert.equal(result.snapshot.blockedReason, 'AUTONOMOUS_REPAIR_RETIRED');
		assert.equal(fixture.governor.calls.length, 0);
		const blocked = fixture.store.listEvents(fixture.runId).filter((event) => event.payload?.reason === 'AUTONOMOUS_REPAIR_RETIRED').at(-1);
		assert.deepEqual(blocked.payload.failurePacket, failurePacket);
	} finally {
		fixture.close();
	}
});

test('@ac AC-05 @case AC-05.4 a non-repairable preflight FAIL stays VERIFICATION_OUTSIDE_AUTHORIZED_SCOPE', async () => {
	const fixture = makeFixture('graph-repair-outside-scope', []);
	try {
		const { snapshot } = prepareVerifierSnapshot(fixture, 'VERIFYING_PREFLIGHT');
		fixture.runtime.execCli = () => {
			const error = new Error('preflight failed');
			error.status = 1;
			error.stdout = 'failed in packages/ddd-base/src/domain/value-object.class.ts\n';
			error.stderr = '';
			throw error;
		};
		const result = await executePreflightForSnapshot(fixture.runtime, snapshot);
		assert.equal(result.snapshot.state, 'ESCALATED');
		assert.equal(result.snapshot.blockedReason, 'VERIFICATION_OUTSIDE_AUTHORIZED_SCOPE');
		assert.equal(fixture.governor.calls.length, 0);
	} finally {
		fixture.close();
	}
});
