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

test('@ac AC-03 @case AC-03.3 @ac AC-05 applyAcCoverageGate does not block completion or trigger REPAIRING_FAILURE when criteria are uncovered', async () => {
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

		assert.equal(next.state, 'REVIEWING_QA');
		const events = fixture.store.listEvents(fixture.runId);
		assert.equal(events.some((e) => e.eventType === 'AC_COVERAGE_FAILED'), false);
		assert.equal(events.some((e) => e.eventType === 'AC_COVERAGE_PASSED'), true);
		const passEvent = events.find((e) => e.eventType === 'AC_COVERAGE_PASSED');
		assert.equal(passEvent.payload.coveragePass, false);
		assert.ok(passEvent.payload.coverageArtifact);
		const savedArtifact = fixture.artifacts.readJson(passEvent.payload.coverageArtifact);
		assert.equal(savedArtifact.pass, false);
		const { coverageAdvisories } = collectQaBriefAndAdvisories(fixture.runtime, next);
		assert.equal(coverageAdvisories.coveragePass, false);
		assert.ok(Array.isArray(coverageAdvisories.uncoveredAcIds));
	} finally {
		fixture.close();
	}
});

test('@ac AC-06 @case AC-06.1 new-policy uncovered coverage emits AC_COVERAGE_FAILED and requests correction without QA', async () => {
	const fixture = makeFixture('new-policy-coverage-fail', []);
	try {
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
		const adapter = {
			adapterId: 'unit-adapter',
			protocolVersion: '1.0.0',
			bundleFiles: [{ path: 'tools/adapter.mjs', sha256: 'f'.repeat(64) }],
			dependencyFiles: [],
			configurationFiles: [],
			argv: ['node', 'tools/adapter.mjs'],
			profiles: [{ profileId: 'unit', layers: ['unit'], capabilities: [] }],
			qualificationArtifactHash: 'e'.repeat(64),
			limits: { timeoutMs: 5_000, maxReportBytes: 20_000, maxArtifactBytes: 10_000, maxArtifacts: 4 },
		};
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
		const checkpointId = 'final-coverage-fail';
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
		assert.equal(events.some((event) => event.eventType === 'AC_COVERAGE_FAILED'), true);
		assert.equal(events.find(event => event.eventType === 'AC_COVERAGE_FAILED').payload.status, 'FAILED');
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
	} finally {
		fixture.close();
	}
});
