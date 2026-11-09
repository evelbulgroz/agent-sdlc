import '../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '../policy/contracts.ts';
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

test('packPlanDocument includes the complete immutable v2 plan', () => {
	const plan = v2Plan();
	const document = JSON.parse(packPlanDocument(plan));
	assert.deepEqual(document.immutableTaskPlan.qualityPolicy, plan.qualityPolicy);
	assert.deepEqual(document.immutableTaskPlan.slices, plan.slices);
	assert.deepEqual(document.immutableTaskPlan.evidenceObligations, plan.evidenceObligations);
	assert.deepEqual(document.immutableTaskPlan.adapterBindings, plan.adapterBindings);
	assert.deepEqual(document.immutableTaskPlan.tasks, plan.tasks);
});

test('packPlanDocument rejects an oversized v2 plan instead of trimming unseen obligations', () => {
	const plan = v2Plan();
	plan.evidenceObligations[0].expectedResult = 'x'.repeat(PLAN_DOCUMENT_MAX_BYTES);
	assert.throws(
		() => packPlanDocument(plan),
		(error) => error.code === 'INVALID_CONTRACT' && /complete immutable v2 plan cannot be reviewed/.test(error.message),
	);
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
