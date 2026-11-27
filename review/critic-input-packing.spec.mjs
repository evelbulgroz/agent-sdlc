import '../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '../policy/contracts.ts';
import { hashTaskPlanProjection, projectTaskPlan } from '../policy/contracts/dag-schema.ts';
import { policy } from '../testing/quality-test-support.ts';
import { packPlanDocument, packQaExcerpts, packSpecDocument, PLAN_DOCUMENT_MAX_BYTES } from './critic-input-packing.ts';
import { commandRegistrationFixture } from '../testing/command-registration-fixture.ts';

const v2Plan = () => {
	const adapter = commandRegistrationFixture({ adapterId: 'planning-test', limits: { timeoutMs: 1000, maxReportBytes: 10000, maxArtifactBytes: 1000, maxArtifacts: 1 } });
	return {
		schemaVersion: '2.0.0',
		runId: '2026-11-02-packing-test',
		planPolicyHash: 'a'.repeat(64),
		baseCommitSha: 'b'.repeat(40),
		slices: [{
			sliceId: 'slice-a',
			kind: 'vertical',
			goal: 'Make the result visible.',
			acceptanceCriteria: ['AC-01'],
			dependsOn: [],
		}],
		tasks: [{
			taskId: 'task-a',
			sliceId: 'slice-a',
			title: 'Expose result',
			targetPackage: 'src',
			pathPrefixes: ['src'],
			dependsOn: [],
			integrationOrder: 0,
			verificationCommand: ['pnpm', 'test'],
		}],
		integrationOrder: ['task-a'],
		isParallel: false,
		createdAt: '2026-11-02T10:00:00.000Z',
		qualityPolicy: policy,
		qualityPolicyHash: sha256(policy),
		adapterBindings: [adapter],
		evidenceObligations: [{
			obligationId: 'obligation-ac-01',
			criterionId: 'AC-01',
			caseId: null,
			owner: { kind: 'slice', id: 'slice-a' },
			observableOutcome: 'The result is visible.',
			setupAction: 'Read the result.',
			expectedResult: 'The result is displayed.',
			layer: 'unit',
			requiredCapabilities: [],
			implementationPaths: ['src/result.ts'],
			testCases: [{ file: 'src/result.spec.mjs', caseKey: 'visible' }],
			adapterBindingHash: sha256(adapter),
			profileId: 'unit',
		}],
	};
};

function twentyObligationPlan({ goal = 'Make the result visible.', pad = true, runtime = false } = {}) {
	const plan = v2Plan();
	const criteria = Array.from({ length: 20 }, (_, index) => `AC-${String(index + 1).padStart(2, '0')}`);
	plan.slices[0].goal = goal;
	plan.slices[0].acceptanceCriteria = criteria;
	plan.tasks[0].authoredPaths = ['src/result.spec.mjs'];
	if (runtime) {
		plan.tasks[0].worktreeSubdir = 'worktrees/task-a';
		plan.tasks[0].humanReviewEvidence = 'not_required';
	}
	const sample = plan.evidenceObligations[0];
	plan.evidenceObligations = criteria.map((criterionId, index) => ({
		...sample,
		obligationId: `obligation-ac-${String(index + 1).padStart(2, '0')}`,
		criterionId,
		expectedResult: `${sample.expectedResult}${pad ? 'x'.repeat(500) : ''}`,
	}));
	return plan;
}

function planWithDocumentBytes(targetBytes) {
	const plan = v2Plan();
	const baseGoal = plan.slices[0].goal;
	const baseBytes = Buffer.byteLength(packPlanDocument(plan), 'utf8');
	plan.slices[0].goal = 'g'.repeat(baseGoal.length + targetBytes - baseBytes);
	return plan;
}

test('packPlanDocument keeps the v2 projection except obligation records', () => {
	const plan = v2Plan();
	const before = hashTaskPlanProjection(plan);
	const document = JSON.parse(packPlanDocument(plan));
	assert.equal(document.taskPlanHash, before);
	assert.equal(hashTaskPlanProjection(plan), before);
	assert.equal(document.planPolicyHash, plan.planPolicyHash);
	assert.notEqual(document.taskPlanHash, document.planPolicyHash);
	assert.deepEqual(document.immutableTaskPlan.qualityPolicy, plan.qualityPolicy);
	assert.deepEqual(document.immutableTaskPlan.slices, plan.slices);
	assert.equal(document.immutableTaskPlan.evidenceObligations, undefined);
	assert.deepEqual(document.immutableTaskPlan.adapterBindings, plan.adapterBindings);
	assert.deepEqual(document.immutableTaskPlan.tasks, plan.tasks);
	assert.deepEqual(document.obligationIndex, [{
		criterionId: 'AC-01',
		caseId: null,
		ownerKind: 'slice',
		ownerId: 'slice-a',
		profileId: 'unit',
	}]);
});

test('@ac AC-01 @case AC-01.1 @case AC-01.2 @case AC-01.3 the fitting fixture cites the hash and drops obligation prose', () => {
	const plan = twentyObligationPlan();
	const before = hashTaskPlanProjection(plan);
	const packed = packPlanDocument(plan);
	const document = JSON.parse(packed);
	assert.ok(Buffer.byteLength(packed, 'utf8') <= PLAN_DOCUMENT_MAX_BYTES);
	assert.equal(document.taskPlanHash, before);
	assert.equal(hashTaskPlanProjection(plan), before);
	assert.equal(plan.evidenceObligations[0].expectedResult.endsWith('x'.repeat(500)), true);
	assert.equal(document.obligationIndex.length, 20);
	assert.deepEqual(
		document.obligationIndex.map((row) => row.criterionId),
		plan.evidenceObligations.map((obligation) => obligation.criterionId),
	);
	assert.deepEqual(document.obligationIndex[0], {
		criterionId: 'AC-01',
		caseId: null,
		ownerKind: 'slice',
		ownerId: 'slice-a',
		profileId: 'unit',
	});
	for (const row of document.obligationIndex) {
		assert.deepEqual(Object.keys(row).sort(), ['caseId', 'criterionId', 'ownerId', 'ownerKind', 'profileId']);
	}
	assert.equal(document.immutableTaskPlan.evidenceObligations, undefined);
	assert.equal(packed.includes('observableOutcome'), false);
	assert.equal(packed.includes('setupAction'), false);
	assert.equal(packed.includes('expectedResult'), false);
	assert.equal(packed.includes('The result is displayed.'), false);
	assert.deepEqual(document.immutableTaskPlan.tasks[0].authoredPaths, ['src/result.spec.mjs']);
	assert.equal(Object.hasOwn(document.tasks[0], 'worktreeSubdir'), false);
	assert.equal(Object.hasOwn(document.tasks[0], 'humanReviewEvidence'), false);
	assert.deepEqual(document.tasks[0].verificationCommand, ['pnpm', 'test']);
});

test('@ac AC-02 @case AC-02.1 projectTaskPlan keeps every obligation record', () => {
	for (const plan of [twentyObligationPlan(), twentyObligationPlan({ goal: 'g'.repeat(21000) })]) {
		assert.deepEqual(projectTaskPlan(plan).evidenceObligations, plan.evidenceObligations);
	}
});

test('@ac AC-02 @case AC-02.2 20481 compact bytes is INVALID_CONTRACT and 20480 is accepted', () => {
	assert.equal(PLAN_DOCUMENT_MAX_BYTES, 20480);
	const accepted = packPlanDocument(planWithDocumentBytes(20480));
	assert.equal(Buffer.byteLength(accepted, 'utf8'), 20480);
	assert.equal(JSON.parse(accepted).immutableTaskPlan.qualityPolicy.policyId, 'checkpoint-evidence-v1');
	const rejected = planWithDocumentBytes(20481);
	const goal = rejected.slices[0].goal;
	assert.throws(
		() => packPlanDocument(rejected),
		(error) => error.code === 'INVALID_CONTRACT' && error.message.includes('20480'),
	);
	assert.equal(rejected.slices[0].goal, goal);
	assert.equal(rejected.qualityPolicy.policyId, 'checkpoint-evidence-v1');
	assert.equal(rejected.adapterBindings.length, 1);
});

test('@ac AC-02 @case AC-02.4 a 21000-character slice goal is rejected and retained fields stay', () => {
	const plan = twentyObligationPlan({ goal: 'g'.repeat(21000) });
	const before = hashTaskPlanProjection(plan);
	assert.throws(
		() => packPlanDocument(plan),
		(error) => error.code === 'INVALID_CONTRACT' && error.message.includes('20480'),
	);
	assert.equal(plan.slices[0].goal.length, 21000);
	assert.equal(plan.evidenceObligations.length, 20);
	assert.equal(plan.qualityPolicy.policyId, 'checkpoint-evidence-v1');
	assert.equal(plan.adapterBindings.length, 1);
	assert.equal(hashTaskPlanProjection(plan), before);
	assert.equal(projectTaskPlan(plan).slices[0].goal.length, 21000);
});

test('@ac AC-03 @case AC-03.1 @case AC-03.2 a schema 1 plan keeps runtime fields and gains no index', () => {
	const packed = packPlanDocument({
		schemaVersion: '1.0.0',
		planPolicyHash: 'a'.repeat(64),
		baseCommitSha: 'b'.repeat(40),
		isParallel: false,
		integrationOrder: ['task-a'],
		tasks: [{
			taskId: 'task-a',
			title: 'x'.repeat(PLAN_DOCUMENT_MAX_BYTES),
			targetPackage: 'src',
			pathPrefixes: ['src'],
			dependsOn: [],
			worktreeSubdir: 'worktrees/task-a',
			integrationOrder: 0,
			humanReviewEvidence: 'not_required',
			verificationCommand: ['pnpm', 'test'],
		}],
	});
	const document = JSON.parse(packed);
	assert.ok(Buffer.byteLength(packed, 'utf8') > PLAN_DOCUMENT_MAX_BYTES);
	assert.equal(document.tasks[0].worktreeSubdir, 'worktrees/task-a');
	assert.equal(document.tasks[0].humanReviewEvidence, 'not_required');
	assert.deepEqual(document.tasks[0].verificationCommand, ['pnpm', 'test']);
	assert.equal(document.obligationIndex, undefined);
});

test('@ac AC-04 @case AC-04.1 @case AC-04.2 supplied wrapper fields stay with policy and slice ids', () => {
	const plan = twentyObligationPlan({ runtime: true });
	const document = JSON.parse(packPlanDocument(plan));
	assert.deepEqual(document.immutableTaskPlan.qualityPolicy, plan.qualityPolicy);
	assert.deepEqual(document.immutableTaskPlan.adapterBindings, plan.adapterBindings);
	assert.deepEqual(document.immutableTaskPlan.slices[0].acceptanceCriteria, plan.slices[0].acceptanceCriteria);
	assert.equal(document.tasks[0].worktreeSubdir, 'worktrees/task-a');
	assert.equal(document.tasks[0].humanReviewEvidence, 'not_required');
	assert.deepEqual(document.tasks[0].verificationCommand, ['pnpm', 'test']);
	assert.equal(document.immutableTaskPlan.tasks[0].worktreeSubdir, undefined);
	assert.equal(document.immutableTaskPlan.tasks[0].humanReviewEvidence, undefined);
});

test('@ac AC-14 plan critic packet includes deterministic feasibility and done-bar evidence', () => {
	const document = JSON.parse(
		packPlanDocument({
			planPolicyHash: 'a'.repeat(64),
			baseCommitSha: 'b'.repeat(40),
			isParallel: false,
			integrationOrder: ['behavior-task'],
			tasks: [
				{
					taskId: 'behavior-task',
					title: 'Behavior',
					targetPackage: 'tools',
					pathPrefixes: ['tools/agent-sdlc'],
					dependsOn: [],
					worktreeSubdir: 'worktrees/behavior-task',
					integrationOrder: 0,
					changeClass: 'B',
					complexityInputs: {
						acceptanceCriteria: 1,
						authoredPaths: 2,
						deliveryLayers: 1,
						dependencyMutations: 0,
						contractProducer: false,
						highRisk: false,
					},
					complexityScore: 5,
					shadowPaths: {
						unhappy: 'failure',
						timeout: 'deadline',
						empty: 'no delta',
						boundary: 'scope escape',
					},
					highRisk: false,
					humanReviewEvidence: 'not_required',
					verificationCommand: ['pnpm', 'run', 'test:unit'],
				},
			],
		}),
	);
	assert.equal(document.changeClass, 'B');
	assert.equal(
		document.doneBar,
		'host verify command (sdlc-host.json verify.argv) is run by the engine after tasks complete and must return a receipt with status=OK and canonical=true; task verificationCommand values are separate per-task checks and need not equal verify.argv',
	);
	assert.equal(document.tasks[0].complexityScore, 5);
	assert.deepEqual(document.tasks[0].shadowPaths, {
		boundary: 'scope escape',
		empty: 'no delta',
		timeout: 'deadline',
		unhappy: 'failure',
	});
	assert.deepEqual(document.tasks[0].verificationCommand, [
		'pnpm',
		'run',
		'test:unit',
	]);
});

test('packSpecDocument is deterministic and omits interview chatter', () => {
	const packed = packSpecDocument({
		goal: 'Ship critic placement',
		nonGoals: ['Rewrite preflight'],
		owningContext: 'tools',
		touchedSurfaces: ['tools/agent-sdlc'],
		invariantsAndConstraints: ['Fail closed'],
		publicContractImpact: 'None',
		acceptanceCriteria: ['Spec critic before approval'],
		failureDefenses: ['Unknown vendor fails'],
		verificationPlan: ['test:unit'],
		assumptions: [],
		unresolvedQuestions: ['should not appear'],
	});
	assert.match(packed, /Ship critic placement/);
	assert.equal(packed.includes('should not appear'), false);
});

test('@ac AC-04 @case AC-04.2 packSpecDocument progressively narrows assumptions and verificationPlan when budget exceeded', () => {
	const baseDraft = {
		goal: 'Test spec packing',
		nonGoals: ['None'],
		owningContext: 'frontends/example-pwa-frontend',
		touchedSurfaces: ['src/ui/App.tsx'],
		invariantsAndConstraints: ['Strict invariants'],
		publicContractImpact: 'None',
		acceptanceCriteria: ['AC-01: outcome'],
		failureDefenses: ['Defenses'],
		verificationPlan: ['pnpm test'],
		assumptions: ['Assumption 1', 'Assumption 2'],
	};

	// Generous budget includes both assumptions and verificationPlan
	const fullPacked = packSpecDocument(baseDraft, 50000);
	assert.ok(fullPacked.includes('Assumption 1'));
	assert.ok(fullPacked.includes('pnpm test'));

	// Narrower budget drops assumptions first
	const noAssumptionsBudget = Buffer.byteLength(fullPacked, 'utf8') - 10;
	const narrowedAssumptions = packSpecDocument(baseDraft, noAssumptionsBudget);
	assert.equal(narrowedAssumptions.includes('Assumption 1'), false);
	assert.ok(narrowedAssumptions.includes('pnpm test'));

	// Even narrower budget drops verificationPlan as well
	const noVerificationBudget = Buffer.byteLength(narrowedAssumptions, 'utf8') - 10;
	const narrowedBoth = packSpecDocument(baseDraft, noVerificationBudget);
	assert.equal(narrowedBoth.includes('Assumption 1'), false);
	assert.equal(narrowedBoth.includes('pnpm test'), false);
	assert.ok(narrowedBoth.includes('Test spec packing'));
	assert.ok(narrowedBoth.includes('AC-01: outcome'));
});

test('packQaExcerpts folds status into the excerpt and returns an empty string for a missing result', () => {
	assert.match(packQaExcerpts({ stdout: 'agent-preflight: RESULT status=OK', status: 'OK' }), /status=OK/);
	assert.equal(packQaExcerpts(null), '');
});
