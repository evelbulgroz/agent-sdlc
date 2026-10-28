import assert from 'node:assert/strict';
import test from 'node:test';
import { packPlanDocument, packQaExcerpts, packSpecDocument } from './critic-input-packing.ts';

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
					verificationCommand: ['pnpm', 'run', 'agent:test-sdlc'],
				},
			],
		}),
	);
	assert.equal(document.changeClass, 'B');
	assert.equal(
		document.doneBar,
		'pnpm run agent:preflight; success requires status=OK and canonical=true',
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
		'agent:test-sdlc',
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
		verificationPlan: ['agent:test-sdlc'],
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
		owningContext: 'apps/frontends/example-pwa-frontend',
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
