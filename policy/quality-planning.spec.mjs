import assert from 'node:assert/strict';
import test from 'node:test';
import { attachApprovedQualityPlan } from './quality-planning.ts';
import { adapterBindingHash, qualityPolicyHash } from './contracts/quality-schema.ts';
import { hashTaskPlanProjection, projectTaskPlan } from './contracts/dag-schema.ts';
import { sha256 } from './contracts/primitives.ts';

const hash = (letter = 'a') => letter.repeat(64);
const tree = (letter = 'b') => letter.repeat(40);
const criteria = [
	'AC-01: The result is visible. Given an opened screen. Then the result appears. Cases: AC-01.1: First case; AC-01.2: Second case.',
];

function legacyPlan() {
	return {
		schemaVersion: '1.0.0',
		runId: '2026-11-01-quality-plan',
		planPolicyHash: hash('c'),
		baseCommitSha: tree(),
		slices: [{
			sliceId: 'slice-one',
			kind: 'vertical',
			goal: 'Implement result visibility.',
			acceptanceCriteria: ['AC-01'],
			dependsOn: [],
		}],
		tasks: [{
			taskId: 'task-one',
			title: 'Implement visible result',
			targetPackage: 'packages/example',
			pathPrefixes: ['src'],
			dependsOn: [],
			status: 'pending',
			integrationOrder: 0,
			worktreeSubdir: 'worktrees/task-one',
			baseCommitSha: tree(),
			parentTreeSha: null,
			parentCommitSha: null,
			targetTreeSha: null,
			patchHash: null,
			failurePacketArtifact: null,
			repairCount: 0,
			sliceId: 'slice-one',
			authoredPaths: ['src/main.ts', 'src/main.spec.ts'],
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
	};
}

function approvedQuality(overrides = {}) {
	const policy = {
		schemaVersion: '1.0.0',
		policyId: 'checkpoint-evidence-v1',
		additionalCandidateReviews: 0,
		followUpDispatches: 0,
		testRetryPolicy: 'clean-success',
		retrieval: { maxPacketBytes: 24_576, maxPacketLines: 1_000, maxTotalBytesPerCandidate: 49_152, maxTotalLinesPerCandidate: 2_000 },
		execution: { maxInvocations: 4, maxTotalDurationMs: 20_000 },
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
		qualificationArtifactHash: hash('d'),
		limits: { timeoutMs: 5_000, maxReportBytes: 10_000, maxArtifactBytes: 10_000, maxArtifacts: 2 },
	};
	const bindingHash = adapterBindingHash(adapter);
	const evidenceObligations = ['AC-01.1', 'AC-01.2'].map((caseId, index) => ({
		obligationId: `obligation-${index + 1}`,
		criterionId: 'AC-01',
		caseId,
		owner: { kind: 'task', id: 'task-one' },
		observableOutcome: 'The result is visible.',
		setupAction: 'Open the screen.',
		expectedResult: 'The result appears.',
		layer: 'unit',
		requiredCapabilities: [],
		implementationPaths: ['src/main.ts'],
		testCases: [{ file: 'src/main.spec.ts', caseKey: `case-${index + 1}` }],
		adapterBindingHash: bindingHash,
		profileId: 'unit',
	}));
	return { qualityPolicy: policy, adapterBindings: [adapter], evidenceObligations, ...overrides };
}

test('attachApprovedQualityPlan emits strict v2 wire and hashes immutable quality projection', () => {
	const result = attachApprovedQualityPlan(legacyPlan(), approvedQuality(), criteria);
	assert.equal(result.schemaVersion, '2.0.0');
	assert.equal(result.qualityPolicyHash, qualityPolicyHash(result.qualityPolicy));
	assert.equal(result.tasks[0].status, 'pending');
	const wire = projectTaskPlan(result);
	assert.equal(Object.hasOwn(wire.tasks[0], 'status'), false);
	assert.equal(Object.hasOwn(wire.tasks[0], 'worktreeSubdir'), false);
	assert.equal(Object.hasOwn(wire.tasks[0], 'baseCommitSha'), false);
	assert.equal(hashTaskPlanProjection(result), sha256(wire));
	const changed = { ...wire, evidenceObligations: wire.evidenceObligations.map((item, index) =>
		index === 0 ? { ...item, expectedResult: 'A different result appears.' } : item) };
	assert.notEqual(hashTaskPlanProjection(changed), hashTaskPlanProjection(wire));
});

test('attachApprovedQualityPlan rejects empty, missing, foreign, duplicate and unsupported obligations', () => {
	assert.throws(() => attachApprovedQualityPlan(legacyPlan(), null, criteria));
	assert.throws(() => attachApprovedQualityPlan({ ...legacyPlan(), slices: [] }, approvedQuality(), criteria));
	const valid = approvedQuality();
	assert.throws(() => attachApprovedQualityPlan(legacyPlan(), {
		...valid, evidenceObligations: valid.evidenceObligations.slice(0, 1),
	}, criteria), /omit|missing/i);
	assert.throws(() => attachApprovedQualityPlan(legacyPlan(), {
		...valid,
		evidenceObligations: valid.evidenceObligations.map((item, index) =>
			index === 1 ? { ...item, caseId: 'AC-01.3' } : item),
	}, criteria), /foreign/i);
	assert.throws(() => attachApprovedQualityPlan(legacyPlan(), {
		...valid,
		evidenceObligations: [valid.evidenceObligations[0], { ...valid.evidenceObligations[0], obligationId: 'obligation-duplicate' }],
	}, criteria), /duplicate/i);
	const unsupported = approvedQuality();
	unsupported.evidenceObligations = unsupported.evidenceObligations.map((item) => ({
		...item, layer: 'browser', requiredCapabilities: ['native-browser'],
	}));
	assert.throws(() => attachApprovedQualityPlan(legacyPlan(), unsupported, criteria), /support|capability/i);
});
