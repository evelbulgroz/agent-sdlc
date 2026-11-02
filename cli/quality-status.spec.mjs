import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { projectQualityStatus } from './quality-status.ts';
import { adapterBindingHash, qualityPolicyHash } from '../policy/contracts/quality-schema.ts';
import { qaCheckpointAttemptKey } from '../review/critic-budget.ts';
import { sha256 } from '../policy/contracts.ts';
import { resolveCheckpointQualityContext } from '../workflow/quality-context.ts';
import { assertQualityDeliveryAllowed } from '../workflow/quality-delivery.ts';

const hash = (letter = 'a') => letter.repeat(64);
const tree = (letter = 'b') => letter.repeat(40);

function qualityFixture() {
	const policy = {
		schemaVersion: '1.0.0',
		policyId: 'checkpoint-evidence-v1',
		additionalCandidateReviews: 0,
		followUpDispatches: 0,
		testRetryPolicy: 'clean-success',
		retrieval: {
			maxPacketBytes: 24_576,
			maxPacketLines: 1_000,
			maxTotalBytesPerCandidate: 49_152,
			maxTotalLinesPerCandidate: 2_000,
		},
		execution: { maxInvocations: 2, maxTotalDurationMs: 10_000 },
		review: { maxLogicalDispatches: 2, maxPhysicalCalls: 2, maxInputTokens: 1_000, maxOutputTokens: 1_000 },
	};
	const adapter = {
		adapterId: 'unit-adapter',
		protocolVersion: '1.0.0',
		bundleFiles: [{ path: 'tools/adapter.mjs', sha256: hash() }],
		dependencyFiles: [],
		configurationFiles: [],
		argv: ['node', 'tools/adapter.mjs'],
		profiles: [{ profileId: 'unit', layers: ['unit'], capabilities: [] }],
		qualificationArtifactHash: hash('c'),
		limits: { timeoutMs: 5_000, maxReportBytes: 20_000, maxArtifactBytes: 10_000, maxArtifacts: 4 },
	};
	const adapterHash = adapterBindingHash(adapter);
	const plan = {
		schemaVersion: '2.0.0',
		runId: '2026-11-01-quality-status',
		planPolicyHash: hash('d'),
		baseCommitSha: tree(),
		slices: [{
			sliceId: 'slice-one',
			kind: 'vertical',
			goal: 'Implement result',
			acceptanceCriteria: ['AC-01'],
			dependsOn: [],
		}],
		tasks: [{
			taskId: 'task-one',
			title: 'Implement result',
			targetPackage: 'packages/example',
			pathPrefixes: ['src'],
			dependsOn: [],
			integrationOrder: 0,
			sliceId: 'slice-one',
			authoredPaths: ['src/main.ts'],
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
		createdAt: '2026-11-01T22:00:00.000Z',
		qualityPolicy: policy,
		qualityPolicyHash: qualityPolicyHash(policy),
		adapterBindings: [adapter],
		evidenceObligations: [{
			obligationId: 'obligation-one',
			criterionId: 'AC-01',
			caseId: 'AC-01.1',
			owner: { kind: 'task', id: 'task-one' },
			observableOutcome: 'The result is visible.',
			setupAction: 'Open the screen.',
			expectedResult: 'A result appears.',
			layer: 'unit',
			requiredCapabilities: [],
			implementationPaths: ['src/main.ts'],
			testCases: [{ file: 'src/main.spec.ts', caseKey: 'case-one' }],
			adapterBindingHash: adapterHash,
			profileId: 'unit',
		}],
	};
	const specHash = hash('e');
	const planHash = hash('f');
	const treeSha = tree('c');
	const binding = {
		runId: plan.runId,
		approvedSpecHash: specHash,
		taskPlanHash: planHash,
		qualityPolicyHash: plan.qualityPolicyHash,
		checkpointId: 'final-one',
		checkpointKind: 'final',
		ownerId: null,
		candidateRevision: 0,
		baseCommitSha: plan.baseCommitSha,
		treeSha,
		revisionSetHash: hash('1'),
		preparationHash: hash('2'),
	};
	const bindingHash = sha256(binding);
	const receiptHash = hash('3');
	const attemptKey = qaCheckpointAttemptKey({
		approvedSpecHash: specHash,
		taskPlanHash: planHash,
		checkpointKind: 'final',
		treeSha,
	});
	const completion = {
		receipt: { status: 'passed', operationId: 'operation-one' },
		invocation: { status: 'completed', reportHash: hash('4') },
		report: {
			cases: [{
				file: 'src/main.spec.ts',
				caseKey: 'case-one',
				obligationIds: ['obligation-one'],
				outcome: 'passed',
				exercisedCapabilities: [],
				attempts: [{ outcome: 'passed' }],
			}],
		},
	};
	const closure = {
		binding,
		registryId: 'final-one',
		selectedRevisions: [{ taskId: 'task-one', executionRevision: 0, patchHash: hash('5') }],
		status: 'accepted',
		receiptHashes: [receiptHash],
	};
	const reviewArtifactHash = sha256({
		attemptKey, bindingHash, qualityPolicyHash: plan.qualityPolicyHash, receiptHashes: [receiptHash],
	});
	const pending = {
		kind: 'quality_review',
		interruptId: 'interrupt-one',
		requestArtifact: hash('6'),
	};
	const runtimeStore = {
		getTaskPlan: () => plan,
		listCriticReviews: () => [{
			phase: 'qa', attemptKey, artifactHash: reviewArtifactHash, hasP1: false,
		}],
		listEvents: () => [
			{
				eventType: 'AC_COVERAGE_PASSED',
				payload: { qualityCheckpointBindingHash: bindingHash, qualityCheckpointTreeSha: treeSha, coveragePass: true },
			},
			{
				eventType: 'QA_CRITIC_COMPLETED',
				payload: {
					qualityCheckpointBindingHash: bindingHash,
					qualityCheckpointTreeSha: treeSha,
					status: 'PASS',
					attemptKey,
					artifactHash: reviewArtifactHash,
					qualityRetrievalArtifacts: [{ requestArtifact: hash('8'), responseArtifact: hash('9') }],
				},
			},
		],
		getPendingInterrupt: () => pending,
		quality: {
			listClosures: () => [closure],
			getEvidenceCompletionByReceiptHash: () => completion,
			getBudget: () => ({
				revision: 1,
				counters: { logicalDispatches: 1 },
				reservations: [{ operationId: 'review-one', kind: 'review', checkpointId: 'final-one', candidateRevision: 0, status: 'consumed' }],
			}),
			getInterruptBinding: () => ({
				bindingHash,
				findingIds: ['finding-one'],
				affectedTaskIds: ['task-one'],
				expectedRevisions: [{ taskId: 'task-one', executionRevision: 0 }],
			}),
		},
	};
	const state = {
		runId: plan.runId,
		approvedSpecHash: specHash,
		taskPlanHash: planHash,
		qualityCheckpointId: 'final-one',
		qualityCheckpointKind: 'final',
		qualityCheckpointTreeSha: treeSha,
		qualityCheckpointBindingHash: bindingHash,
	};
	return { runtimeStore, state, receiptHash, bindingHash };
}

test('legacy plans omit the additive quality status block', () => {
	assert.equal(projectQualityStatus({ getTaskPlan: () => null }, { runId: 'legacy-run' }), null);
});

test('checkpoint status projects bindings, case citations, disposition, budget, and interrupt provenance', () => {
	const fixture = qualityFixture();
	const quality = projectQualityStatus(fixture.runtimeStore, fixture.state);

	assert.equal(quality.bindings.bindingHash, fixture.bindingHash);
	assert.equal(quality.execution.receipts[0].receiptHash, fixture.receiptHash);
	assert.deepEqual(quality.citation.cases[0], {
		file: 'src/main.spec.ts',
		caseKey: 'case-one',
		obligationIds: ['obligation-one'],
		outcome: 'passed',
		exercisedCapabilities: [],
		attemptOutcomes: ['passed'],
	});
	assert.equal(quality.adequacy.status, 'reviewed');
	assert.equal(quality.adequacy.retrievalArtifacts[0].requestArtifact, hash('8'));
	assert.equal(quality.disposition.pendingInterruptId, 'interrupt-one');
	assert.equal(quality.disposition.interruptBinding.expectedRevisions[0].taskId, 'task-one');
	assert.equal(quality.budget.counters.logicalDispatches, 1);
});

test('checkpoint status does not reuse an old review for a new revision binding with the same tree', () => {
	const fixture = qualityFixture();
	const closure = fixture.runtimeStore.quality.listClosures()[0];
	closure.binding = { ...closure.binding, candidateRevision: 1, revisionSetHash: hash('a') };
	closure.selectedRevisions[0].executionRevision = 1;
	fixture.state.qualityCheckpointBindingHash = sha256(closure.binding);
	const quality = projectQualityStatus(fixture.runtimeStore, fixture.state);
	assert.equal(quality.adequacy.status, 'pending');
	assert.equal(quality.adequacy.artifactHash, null);
	assert.equal(quality.adequacy.hasP1, null);
});

test('checkpoint status selects the follow-up artifact bound by the current completed review', () => {
	const fixture = qualityFixture();
	const [initial] = fixture.runtimeStore.listCriticReviews();
	fixture.runtimeStore.listCriticReviews = () => [
		{ ...initial, hasP1: true },
		{ ...initial, attemptKey: `${initial.attemptKey}:follow-up:current`, artifactHash: hash('a') },
		{ ...initial, attemptKey: `${initial.attemptKey}:follow-up:stale`, artifactHash: hash('b'), hasP1: true },
	];
	const events = fixture.runtimeStore.listEvents();
	events.find(event => event.eventType === 'QA_CRITIC_COMPLETED').payload.artifactHash = hash('a');
	fixture.runtimeStore.listEvents = () => events;
	const quality = projectQualityStatus(fixture.runtimeStore, fixture.state);
	assert.equal(quality.adequacy.status, 'reviewed');
	assert.equal(quality.adequacy.artifactHash, hash('a'));
});

test('checkpoint status stays pending when its candidate closure is missing', () => {
	const fixture = qualityFixture();
	fixture.runtimeStore.quality.listClosures = () => [];
	const quality = projectQualityStatus(fixture.runtimeStore, fixture.state);
	assert.equal(quality.adequacy.status, 'pending');
	assert.equal(quality.adequacy.artifactHash, null);
});

test('checkpoint status recognizes the successful charged retry for the current candidate', () => {
	const fixture = qualityFixture();
	const [initial] = fixture.runtimeStore.listCriticReviews();
	fixture.runtimeStore.listCriticReviews = () => [
		{ ...initial, attemptKey: `${initial.attemptKey}:dispatch:1` },
	];
	const quality = projectQualityStatus(fixture.runtimeStore, fixture.state);
	assert.equal(quality.adequacy.status, 'reviewed');
	assert.equal(quality.adequacy.hasP1, false);
});

test('staged correction closures remain reviewable but cannot pass the Git delivery gate', () => {
	const fixture = qualityFixture();
	const runDir = path.resolve('tools/.agent-sdlc/test-fixtures', `quality-staged-review-${process.pid}`);
	const worktreeDir = path.join(runDir, 'checkpoint-worktrees', 'final-one');
	fs.mkdirSync(worktreeDir, { recursive: true, mode: 0o700 });
	try {
		const closure = fixture.runtimeStore.quality.listClosures()[0];
		closure.status = 'reviewing';
		fixture.runtimeStore.quality.getTaskRevision = () => ({
			taskId: 'task-one',
			executionRevision: 1,
			correctionId: 'correction-one',
		});
		fixture.runtimeStore.quality.getCorrection = () => ({
			status: 'rebuilding',
			binding: { affectedTaskIds: ['task-one'] },
		});
		fixture.runtimeStore.quality.getWorktree = () => ({
			registryId: 'final-one',
			kind: 'final',
			ownerId: null,
			relativePath: 'checkpoint-worktrees/final-one',
			bindingHash: fixture.bindingHash,
		});
		fixture.runtimeStore.quality.hasIncompleteCorrection = () => true;
		const snapshot = {
			...fixture.state,
			qualityPolicy: fixture.runtimeStore.getTaskPlan().qualityPolicy,
			pendingInterruptId: null,
			preflightBindingArtifact: hash('8'),
		};
		const runtime = {
			runtimeStore: fixture.runtimeStore,
			artifactStore: {
				artifactsDir: path.join(runDir, 'artifacts'),
				readJson: () => ({ status: 'OK', canonical: true, targetTreeSha: snapshot.qualityCheckpointTreeSha }),
			},
		};

		assert.equal(resolveCheckpointQualityContext(runtime, snapshot).correctionId, 'correction-one');

		closure.status = 'accepted';
		assert.throws(
			() => assertQualityDeliveryAllowed(runtime, snapshot),
			/A quality correction is incomplete/,
		);
	} finally {
		fs.rmSync(runDir, { recursive: true, force: true });
	}
});
