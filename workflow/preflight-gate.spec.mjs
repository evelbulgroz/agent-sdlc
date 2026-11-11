import '../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';
import { canonicalJson, sha256 } from '../policy/contracts.ts';
import { adapterBindingHash, qualityPolicyHash } from '../policy/contracts/quality-schema.ts';
import { createMockExecCli, makeFixture } from '../testing/test-support.mjs';
import { collectQaBriefAndAdvisories } from './node-helpers.ts';
import { applyAcCoverageGate, blockFinalCoverageFailure, executePreflightForSnapshot } from './preflight-gate.ts';
import { commandRegistrationFixture } from '../testing/command-registration-fixture.ts';

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
		allowedPackages: ['services/billing'],
		allowedPathPrefixes: ['services/billing'],
	}));
	return { snapshot, baseCommitSha, targetTreeSha };
}

test('@ac AC-08 applyAcCoverageGate blocks a legacy run with AC_COVERAGE_FAILED, not QA, when criteria are uncovered', async () => {
	const fixture = makeFixture('graph-ac-05-advisory', []);
	try {
		const worktreeDir = fixture.rootDir;
		const draftArtifact = fixture.artifacts.writeJson('draft', {
			goal: 'Sample goal',
			acceptanceCriteria: ['AC-01: First test', 'AC-02: Second test'],
		});

		const preflightBindingArtifact = fixture.artifacts.writeJson('preflight-binding', {
			status: 'OK',
			canonical: true,
			preflightResultHash: sha256('preflight-pass'),
		});
		const initial = fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Sample goal',
		});
		const snapshot = {
			...initial,
			state: 'VERIFYING_PREFLIGHT',
			targetTreeSha: '0123456789abcdef0123456789abcdef01234567',
			activeGeneration: 0,
			worktreePath: worktreeDir,
			draftArtifact,
			preflightBindingArtifact,
		};
		fixture.store.database
			.prepare('UPDATE runs SET state = ?, state_json = ?, state_hash = ? WHERE run_id = ?')
			.run('VERIFYING_PREFLIGHT', canonicalJson(snapshot), sha256(snapshot), fixture.runId);
		const auth = {
			baseCommitSha: '0123456789abcdef0123456789abcdef01234567',
			allowedPathPrefixes: ['services/billing'],
		};

		const { snapshot: next } = applyAcCoverageGate(
			fixture.runtime,
			snapshot,
			auth,
			worktreeDir,
			{
				preflightBindingArtifact,
				verificationEvidenceHash: sha256('preflight-pass'),
			},
		);

		assert.equal(next.state, 'BLOCKED');
		assert.equal(next.blockedReason, 'AC_COVERAGE_FAILED');
		const events = fixture.store.listEvents(fixture.runId);
		assert.equal(events.some((e) => e.eventType === 'AC_COVERAGE_PASSED'), false);
		const failEvent = events.find((e) => e.eventType === 'AC_COVERAGE_FAILED');
		assert.equal(failEvent.payload.coveragePass, false);
		assert.ok(failEvent.payload.coverageArtifact);
		const savedArtifact = fixture.artifacts.readJson(failEvent.payload.coverageArtifact);
		assert.equal(savedArtifact.pass, false);
		const { coverageAdvisories } = collectQaBriefAndAdvisories(fixture.runtime, next);
		assert.equal(coverageAdvisories.coveragePass, false);
		assert.ok(Array.isArray(coverageAdvisories.uncoveredAcIds));
	} finally {
		fixture.close();
	}
});

test('coverage transition chains its input hash from the persisted state, not the in-memory candidate', () => {
	const fixture = makeFixture('graph-coverage-chain', []);
	try {
		const draftArtifact = fixture.artifacts.writeJson('draft', { goal: 'g', acceptanceCriteria: ['AC-01: One'] });
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'g' });
		const snapshot = {
			...initial,
			state: 'VERIFYING_PREFLIGHT',
			targetTreeSha: '0123456789abcdef0123456789abcdef01234567',
			activeGeneration: 0,
			worktreePath: fixture.rootDir,
			draftArtifact,
		};
		persistRuntimeSnapshot(fixture, snapshot);
		const candidate = { ...snapshot, semanticRepairsCount: 1 };
		const { snapshot: next } = applyAcCoverageGate(
			fixture.runtime,
			candidate,
			{ baseCommitSha: snapshot.targetTreeSha, allowedPathPrefixes: [] },
			fixture.rootDir,
			{ verificationEvidenceHash: sha256('p'), transitionFrom: snapshot },
		);
		const event = fixture.store.listEvents(fixture.runId).find((e) => e.eventType === 'AC_COVERAGE_FAILED');
		assert.equal(event.inputHash, sha256(snapshot));
		assert.equal(next.semanticRepairsCount, snapshot.semanticRepairsCount);
	} finally {
		fixture.close();
	}
});

function prepareReviewingFinalCheckpoint(fixture, checkpointId) {
	const policy = {
			schemaVersion: '1.0.0',
			policyId: 'checkpoint-evidence-v1',
			additionalCandidateReviews: 0,
			followUpDispatches: 0,
			testRetryPolicy: 'clean-success',
			retrieval: { maxPacketBytes: 24_576, maxPacketLines: 1_000, maxTotalBytesPerCandidate: 49_152, maxTotalLinesPerCandidate: 2_000 },
			execution: { maxInvocations: 2, maxTotalDurationMs: 10_000 },
			review: { maxLogicalDispatches: 2, maxPhysicalCalls: 2, maxInputTokens: 1_000, maxOutputTokens: 1_000 },
		};
		const adapter = commandRegistrationFixture({ adapterId: 'unit-adapter', limits: { timeoutMs: 5_000, maxReportBytes: 20_000, maxArtifactBytes: 10_000, maxArtifacts: 4 } });
		const bindingHash = adapterBindingHash(adapter);
	const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'New policy coverage' });
		fixture.store.saveTaskPlan({
			schemaVersion: '2.0.0',
			runId: fixture.runId,
			planPolicyHash: 'a'.repeat(64),
			baseCommitSha: 'b'.repeat(40),
			slices: [{
				sliceId: 'slice-one',
				kind: 'vertical',
				goal: 'Feature',
				acceptanceCriteria: ['AC-01'],
				dependsOn: [],
			}],
			tasks: [{
				taskId: 'task-one',
				title: 'Feature',
				targetPackage: 'services/billing',
				pathPrefixes: ['services/billing'],
				dependsOn: [],
				integrationOrder: 0,
				sliceId: 'slice-one',
				authoredPaths: ['services/billing/src/main.ts'],
				generatedOutputs: [],
				deliveryLayers: ['application'],
				dependencyMutations: [],
				shadowPaths: { unhappy: 'error', timeout: 'timeout', empty: 'empty', boundary: 'edge' },
				verificationCommand: ['pnpm', 'run', 'test:unit'],
				generatorCommand: null,
				acceptanceCriteria: ['AC-01'],
			}],
			integrationOrder: ['task-one'],
			isParallel: false,
			createdAt: new Date().toISOString(),
			qualityPolicy: policy,
			qualityPolicyHash: qualityPolicyHash(policy),
			adapterBindings: [adapter],
			evidenceObligations: [{
				obligationId: 'obligation-one',
				criterionId: 'AC-01',
				caseId: 'AC-01.1',
				owner: { kind: 'task', id: 'task-one' },
				observableOutcome: 'A visible result is shown.',
				setupAction: 'Open the screen and submit the form.',
				expectedResult: 'The result summary appears.',
				layer: 'unit',
				requiredCapabilities: [],
				implementationPaths: ['services/billing/src/main.ts'],
				testCases: [{ file: 'services/billing/src/main.spec.ts', caseKey: 'case-one' }],
				adapterBindingHash: bindingHash,
				profileId: 'unit',
			}],
		});
		const draftArtifact = fixture.artifacts.writeJson('draft', {
			goal: 'Sample goal',
			acceptanceCriteria: ['AC-01: A covered criterion'],
		});
		const treeSha = 'e'.repeat(40);
		const approvedSpecHash = 'c'.repeat(64);
		const taskPlanHash = 'd'.repeat(64);
	const binding = {
			runId: fixture.runId,
			approvedSpecHash,
			taskPlanHash,
			qualityPolicyHash: qualityPolicyHash(policy),
			checkpointId,
			checkpointKind: 'final',
			ownerId: null,
			candidateRevision: 0,
			baseCommitSha: 'b'.repeat(40),
			treeSha,
			revisionSetHash: '1'.repeat(64),
			preparationHash: '2'.repeat(64),
		};
		const checkpointBindingHash = sha256(binding);
		const preflightBindingArtifact = fixture.artifacts.writeJson('canonical-preflight', {
			status: 'OK',
			canonical: true,
			targetTreeSha: treeSha,
			preflightResultHash: '3'.repeat(64),
		});
		const worktreeDir = path.join(fixture.runtimeDir, 'worktree');
		fs.mkdirSync(worktreeDir, { recursive: true });
		const closure = {
			binding,
			registryId: checkpointId,
			selectedRevisions: [],
			status: 'reviewing',
			receiptHashes: ['4'.repeat(64)],
		};
		fixture.store.quality.listClosures = () => [closure];
		fixture.store.quality.getTaskRevision = () => null;
		fixture.store.quality.getCorrection = () => null;
		fixture.store.quality.hasIncompleteCorrection = () => false;
		fixture.store.quality.getWorktree = () => ({
			registryId: checkpointId,
			kind: 'final',
			ownerId: null,
			relativePath: 'worktree',
			bindingHash: checkpointBindingHash,
		});
		fixture.store.quality.getCurrentTaskRevision = () => null;
		const snapshot = {
			...initial,
			state: 'VERIFYING_PREFLIGHT',
			approvedSpecHash,
			taskPlanHash,
			taskPlanFrozen: true,
			targetTreeSha: treeSha,
			activeGeneration: 0,
			worktreePath: worktreeDir,
			integrationWorktreePath: worktreeDir,
			draftArtifact,
			preflightBindingArtifact,
			qualityPolicy: policy,
			qualityCheckpointId: checkpointId,
			qualityCheckpointKind: 'final',
			qualityCheckpointTreeSha: treeSha,
			qualityCheckpointBindingHash: checkpointBindingHash,
		};
	persistRuntimeSnapshot(fixture, snapshot);
	return { snapshot, worktreeDir };
}

test('@ac AC-06 @case AC-06.1 new-policy uncovered coverage emits AC_COVERAGE_FAILED and requests correction without QA', async () => {
	const fixture = makeFixture('new-policy-coverage-fail', []);
	try {
		const { snapshot, worktreeDir } = prepareReviewingFinalCheckpoint(fixture, 'final-coverage-fail');
		const { snapshot: coverageBlocked } = applyAcCoverageGate(
			fixture.runtime,
			snapshot,
			{ baseCommitSha: 'b'.repeat(40), allowedPathPrefixes: ['services/billing'] },
			worktreeDir,
		);
		assert.equal(fixture.store.getPendingInterrupt(fixture.runId), null);
		const next = await fixture.runtime.start(coverageBlocked);
		assert.equal(next.state, 'BLOCKED');
		assert.equal(next.blockedReason, 'QUALITY_REVIEW_BLOCKED');
		const events = fixture.store.listEvents(fixture.runId);
		const coverageEvent = events.find((event) => event.eventType === 'AC_COVERAGE_FAILED');
		assert.equal(Boolean(coverageEvent), true);
		assert.equal(coverageEvent.payload.status, 'FAILED');
		assert.equal(coverageEvent.payload.integrationFailure, undefined);
		assert.equal(events.some((event) => event.eventType === 'AC_COVERAGE_PASSED'), false);
		assert.equal(events.some((event) => event.eventType === 'QA_CRITIC_COMPLETED'), false);
		assert.equal(events.some((event) => event.eventType === 'RUN_READY_FOR_GIT_APPROVAL'), false);
		const interrupt = fixture.store.getPendingInterrupt(fixture.runId);
		assert.equal(interrupt.kind, 'quality_review');
		const request = fixture.artifacts.readJson(interrupt.requestArtifact);
		assert.equal(request.status, 'COVERAGE_FAILED');
		assert.deepEqual(request.allowedActions, ['approve-correction']);
		assert.equal(fixture.store.listCriticReviews(fixture.runId).filter(review => review.phase === 'qa').length, 0);
		assert.match(request.failureId, /^failure-/);
		assert.deepEqual(fixture.store.quality.getInterruptBinding(fixture.runId, interrupt.interruptId).findingIds,
			[request.failureId]);
		await assert.rejects(blockFinalCoverageFailure(fixture.runtime, {
			...coverageBlocked, qualityCheckpointBindingHash: 'f'.repeat(64),
		}), /binding is missing or ambiguous/);
	} finally {
		fixture.close();
	}
});

test('@ac AC-03 @case AC-03.4 @ac AC-05 @case AC-05.1 a repairable preflight FAIL escalates with AUTONOMOUS_REPAIR_RETIRED', async () => {
	const fixture = makeFixture('graph-repair-retired-preflight', []);
	try {
		const { snapshot } = prepareVerifierSnapshot(fixture, 'VERIFYING_PREFLIGHT');
		fixture.runtime.execCli = createMockExecCli({ preflightStatus: 'FAIL' });
		const result = await executePreflightForSnapshot(fixture.runtime, snapshot);
		assert.equal(result.snapshot.state, 'ESCALATED');
		assert.equal(result.snapshot.blockedReason, 'AUTONOMOUS_REPAIR_RETIRED');
		assert.equal(fixture.governor.calls.length, 0);
		const blocked = fixture.store.listEvents(fixture.runId).filter((event) => event.eventType === 'RUN_BLOCKED').at(-1);
		assert.equal(blocked.payload.reason, 'AUTONOMOUS_REPAIR_RETIRED');
		assert.ok(blocked.payload.failurePacket);
		assert.equal(blocked.payload.integrationFailure.haltPath, 'AUTONOMOUS_REPAIR_RETIRED');
		assert.equal(blocked.payload.integrationFailure.category, 'unclassified');
		assert.equal(blocked.payload.integrationFailure.continuation, 'stop');
		assert.equal(result.snapshot.lastError.metadata.integrationFailure.category, 'unclassified');
	} finally {
		fixture.close();
	}
});

test('@ac AC-03 @case AC-03.6 a preflight FAIL while bound to an accepted slice checkpoint surfaces the preflight failure', async () => {
	const fixture = makeFixture('preflight-fail-accepted-slice', []);
	try {
		const { snapshot, baseCommitSha } = prepareVerifierSnapshot(fixture, 'VERIFYING_PREFLIGHT');
		const policy = {
			schemaVersion: '1.0.0', policyId: 'checkpoint-evidence-v1', additionalCandidateReviews: 0, followUpDispatches: 0,
			testRetryPolicy: 'clean-success',
			retrieval: { maxPacketBytes: 24_576, maxPacketLines: 1_000, maxTotalBytesPerCandidate: 49_152, maxTotalLinesPerCandidate: 2_000 },
			execution: { maxInvocations: 2, maxTotalDurationMs: 10_000 },
			review: { maxLogicalDispatches: 2, maxPhysicalCalls: 2, maxInputTokens: 1_000, maxOutputTokens: 1_000 },
		};
		const adapter = commandRegistrationFixture({ adapterId: 'unit-adapter', limits: { timeoutMs: 5_000, maxReportBytes: 20_000, maxArtifactBytes: 10_000, maxArtifacts: 4 } });
		const taskPlanHash = 'd'.repeat(64);
		const binding = {
			runId: fixture.runId, approvedSpecHash: snapshot.approvedSpecHash, taskPlanHash,
			qualityPolicyHash: qualityPolicyHash(policy), checkpointId: 'slice-accepted', checkpointKind: 'slice', ownerId: 'slice-one',
			candidateRevision: 0, baseCommitSha, treeSha: snapshot.targetTreeSha, revisionSetHash: '1'.repeat(64), preparationHash: '2'.repeat(64),
		};
		fixture.store.saveTaskPlan({
			schemaVersion: '2.0.0', runId: fixture.runId, planPolicyHash: 'a'.repeat(64), baseCommitSha,
			slices: [{ sliceId: 'slice-one', kind: 'vertical', goal: 'Feature', acceptanceCriteria: ['AC-01'], dependsOn: [] }],
			tasks: [{
				taskId: 'task-one', title: 'Feature', targetPackage: 'services/billing', pathPrefixes: ['services/billing'],
				dependsOn: [], integrationOrder: 0, sliceId: 'slice-one', authoredPaths: ['services/billing/src/main.ts'],
				generatedOutputs: [], deliveryLayers: ['application'], dependencyMutations: [],
				shadowPaths: { unhappy: 'error', timeout: 'timeout', empty: 'empty', boundary: 'edge' },
				verificationCommand: ['pnpm', 'run', 'test:unit'], generatorCommand: null, acceptanceCriteria: ['AC-01'],
			}],
			integrationOrder: ['task-one'], isParallel: false, createdAt: new Date().toISOString(),
			qualityPolicy: policy, qualityPolicyHash: qualityPolicyHash(policy), adapterBindings: [adapter],
			evidenceObligations: [{
				obligationId: 'obligation-one', criterionId: 'AC-01', caseId: 'AC-01.1', owner: { kind: 'task', id: 'task-one' },
				observableOutcome: 'A visible result is shown.', setupAction: 'Open the screen.', expectedResult: 'The result appears.',
				layer: 'unit', requiredCapabilities: [], implementationPaths: ['services/billing/src/main.ts'],
				testCases: [{ file: 'services/billing/src/main.spec.ts', caseKey: 'case-one' }],
				adapterBindingHash: adapterBindingHash(adapter), profileId: 'unit',
			}],
		});
		fixture.store.quality.listClosures = () => [{ binding, registryId: 'slice-accepted', selectedRevisions: [], status: 'accepted', receiptHashes: ['4'.repeat(64)] }];
		fixture.store.quality.getTaskRevision = () => null;
		fixture.store.quality.getCorrection = () => null;
		fixture.store.quality.hasIncompleteCorrection = () => false;
		fixture.store.quality.getWorktree = () => ({ registryId: 'slice-accepted', kind: 'slice', ownerId: 'slice-one', relativePath: '.', bindingHash: sha256(binding) });
		const bound = {
			...snapshot, approvedPlanPolicyHash: fixture.store.getAuthorization(fixture.runId).approvedPlanPolicyHash, taskPlanHash, taskPlanFrozen: true, qualityPolicy: policy, qualityCheckpointId: 'slice-accepted',
			qualityCheckpointKind: 'slice', qualityCheckpointSliceId: 'slice-one', qualityCheckpointTreeSha: snapshot.targetTreeSha,
			qualityCheckpointBindingHash: sha256(binding),
		};
		persistRuntimeSnapshot(fixture, bound);
		fixture.runtime.execCli = createMockExecCli({ preflightStatus: 'FAIL' });
		const result = await executePreflightForSnapshot(fixture.runtime, bound);
		assert.equal(result.snapshot.state, 'ESCALATED');
		assert.equal(result.snapshot.blockedReason, 'AUTONOMOUS_REPAIR_RETIRED');
	} finally {
		fixture.close();
	}
});

test('@ac AC-02 @case AC-02.1 a checkpoint-bound preflight failure keeps approve-correction', async () => {
	const fixture = makeFixture('checkpoint-preflight-fail', []);
	try {
		const { snapshot } = prepareReviewingFinalCheckpoint(fixture, 'final-preflight-fail');
		const auth = createDefaultAuthorizationEnvelope({
			runId: fixture.runId, approvedSpecHash: snapshot.approvedSpecHash, baseCommitSha: 'b'.repeat(40),
			allowedPackages: ['services/billing'], allowedPathPrefixes: ['services/billing'],
		});
		fixture.store.saveAuthorization(auth);
		const bound = { ...snapshot, approvedPlanPolicyHash: auth.approvedPlanPolicyHash };
		persistRuntimeSnapshot(fixture, bound);
		fixture.runtime.execCli = createMockExecCli({ preflightStatus: 'FAIL' });
		const result = await executePreflightForSnapshot(fixture.runtime, bound);
		assert.equal(result.snapshot.state, 'BLOCKED');
		assert.equal(result.snapshot.blockedReason, 'QUALITY_REVIEW_BLOCKED');
		const failure = result.snapshot.lastError.metadata.integrationFailure;
		assert.equal(failure.haltPath, 'QUALITY_CHECKPOINT_PREFLIGHT');
		assert.equal(failure.continuation, 'approve-correction');
		const request = fixture.artifacts.readJson(result.snapshot.lastError.metadata.requestArtifact);
		assert.deepEqual(request.allowedActions, ['approve-correction']);
	} finally {
		fixture.close();
	}
});

test('@ac AC-01 @case AC-01.1 a repairable preflight failure records coverage_floor_regression from the result file', async () => {
	const fixture = makeFixture('preflight-coverage-record', []);
	try {
		const { snapshot, baseCommitSha } = prepareVerifierSnapshot(fixture, 'VERIFYING_PREFLIGHT');
		fixture.runtime.execCli = (cmd, args = [], opts = {}) => {
			if (!(cmd === 'pnpm' && args.includes('agent:verify'))) return 'OK\n';
			const cwd = typeof opts.cwd === 'string' ? opts.cwd : fixture.runtimeDir;
			fs.mkdirSync(path.join(cwd, 'tools'), { recursive: true });
			fs.writeFileSync(path.join(cwd, 'tools/.agent-preflight-last.json'), JSON.stringify({
				status: 'FAIL', canonical: false, exitCode: 1, base: baseCommitSha, gitHeadSha: baseCommitSha,
				integrationDiagnostics: { schemaVersion: '1', coverageFloor: { pass: false, paths: ['services/billing/src/orphan.ts'] } },
			}));
			throw Object.assign(new Error('fail'), { status: 1, stdout: 'FAIL services/billing\n', stderr: '' });
		};
		const failure = (await executePreflightForSnapshot(fixture.runtime, snapshot)).snapshot.lastError.metadata.integrationFailure;
		assert.equal(failure.haltPath, 'AUTONOMOUS_REPAIR_RETIRED');
		assert.equal(failure.category, 'coverage_floor_regression');
		assert.deepEqual([...failure.targetPaths], ['services/billing/src/orphan.ts']);
		assert.equal(failure.continuation, 'stop');
	} finally { fixture.close(); }
});


