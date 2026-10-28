import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveRunMaxPhysicalCalls } from '../../execution/task-executor.ts';
import { listBoundedPlanningFiles } from '../canary-planning-files.ts';
import { sha256 } from '../contracts.ts';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import * as reliabilityFacade from '../reliability.ts';
import {
	currentCanaryBindings,
	evaluateCanaryEligibility,
	evaluateCanaryFreshness,
	evaluateCanaryQualificationEvidence,
	isDocumentationOnlyGitRange,
	resolveGitHead,
} from './canary.ts';
import {
	HASH,
	bindings,
	canaryEvidence,
	eligibleReadiness,
	mutationAttempt,
	verificationAttempt,
} from '../../testing/reliability-fixtures.mjs';

test('canary qualification rejects runs started without task manifest evidence', () => {
	assert.throws(
		() =>
			evaluateCanaryQualificationEvidence({
				evidence: canaryEvidence({
					plan: { planPolicyHash: HASH, taskManifestHash: null },
				}),
				bindings,
			}),
		(error) => {
			assert.equal(error.code, 'CANARY_REQUIRED');
			assert.equal(error.metadata.reason, 'CANARY_TASK_MANIFEST_MISSING');
			assert.match(error.message, /--task-plan-file/);
			return true;
		},
	);
});

test('canary qualification rejects an accepted mutation at or after the final passing verification', () => {
	const postVerificationMutation = mutationAttempt('canary-task', 2);
	postVerificationMutation.occurredAt = '2026-09-29T00:02:00.000Z';
	const failed = evaluateCanaryQualificationEvidence({
		evidence: canaryEvidence({
			mutationAttempts: [
				mutationAttempt('canary-task', 1),
				postVerificationMutation,
			],
			verificationAttempts: [
				verificationAttempt('canary-task', 1, 'passed'),
				verificationAttempt('canary-task', 2, 'passed'),
			],
		}),
		bindings,
	});

	assert.equal(failed.status, 'FAILED');
	assert.deepEqual(failed.failureCategories, ['POST_VERIFICATION_MUTATION']);
});

test('canary qualification accepts an accepted mutation when a later post-implementation verification passes', () => {
	const betweenPasses = mutationAttempt('canary-task', 2);
	betweenPasses.occurredAt = '2026-09-29T00:01:30.000Z';
	const finalPass = verificationAttempt('canary-task', 3, 'passed');
	finalPass.occurredAt = '2026-09-29T00:01:45.000Z';
	const passed = evaluateCanaryQualificationEvidence({
		evidence: canaryEvidence({
			mutationAttempts: [mutationAttempt('canary-task', 1), betweenPasses],
			verificationAttempts: [
				verificationAttempt('canary-task', 1, 'passed'),
				verificationAttempt('canary-task', 2, 'passed'),
				finalPass,
			],
		}),
		bindings,
	});

	assert.equal(passed.status, 'PASSED');
	assert.deepEqual(passed.failureCategories, []);
});

test('canary qualification rejects a failed final post-implementation verification', () => {
	const failed = evaluateCanaryQualificationEvidence({
		evidence: canaryEvidence({
			verificationAttempts: [
				verificationAttempt('canary-task', 1, 'passed'),
				verificationAttempt('canary-task', 2, 'failed'),
			],
		}),
		bindings,
	});

	assert.equal(failed.status, 'FAILED');
	assert.deepEqual(failed.failureCategories, ['VERIFICATION_FAILURE']);
});

test('@ac AC-12 canary eligibility lists every exceeded dimension', () => {
	const readiness = eligibleReadiness();
	readiness.slices[0].acceptanceCriteria.push('AC-03');
	Object.assign(readiness.tasks[0], {
		authoredPaths: ['a', 'b', 'c', 'd'],
		complexityScore: 11,
		highRisk: true,
		dependencyMutations: [{}],
		generatedOutputs: ['generated'],
		contractProducer: true,
	});
	const result = evaluateCanaryEligibility(readiness);
	assert.equal(result.status, 'CANARY_INELIGIBLE');
	assert.deepEqual(
		result.violations.map((entry) => entry.dimension).sort(),
		[
			'acceptanceCriteria',
			'authoredPaths',
			'complexityScore',
			'dependencyMutation',
			'generatedOutputs',
			'highRisk',
			'publicContractProduction',
		].sort(),
	);
});

test('@ac AC-13 AC-14 AC-15 canary qualification passes, fails, and remains inconclusive distinctly', () => {
	const passed = evaluateCanaryQualificationEvidence({
		evidence: canaryEvidence(),
		bindings,
		now: new Date('2026-09-29T10:00:00.000Z'),
	});
	assert.equal(passed.status, 'PASSED');

	const failed = evaluateCanaryQualificationEvidence({
		evidence: canaryEvidence({
			mutationAttempts: [mutationAttempt('canary-task', 1, 'rejected')],
		}),
		bindings,
	});
	assert.equal(failed.status, 'FAILED');
	assert.ok(failed.failureCategories.includes('INVALID_EDIT'));

	const inconclusive = evaluateCanaryQualificationEvidence({
		evidence: canaryEvidence({
			state: {
				...canaryEvidence().state,
				state: 'BLOCKED',
				lastError: {
					code: 'GOVERNOR_UNAVAILABLE',
					message: 'provider unavailable',
				},
			},
		}),
		bindings,
	});
	assert.equal(inconclusive.status, 'INCONCLUSIVE');
	assert.equal(inconclusive.inconclusiveCause, 'GOVERNOR_UNAVAILABLE');
});

test('@regression canary-qualification-grounded-qa-divergence rejects semantic AC mismatch without repair authority', () => {
	const failed = evaluateCanaryQualificationEvidence({
		evidence: canaryEvidence({
			qaDivergences: [
				{
					severity: 'P2',
					category: 'testing',
					evidence:
						'GAP AC-01: citation exists but the assertion verifies navigation.',
					groundingVerified: true,
				},
			],
		}),
		bindings,
	});
	assert.equal(failed.status, 'FAILED');
	assert.deepEqual(failed.failureCategories, ['QA_ACCEPTANCE_DIVERGENCE']);

	const advisoryOnly = evaluateCanaryQualificationEvidence({
		evidence: canaryEvidence({
			qaDivergences: [
				{
					severity: 'P2',
					category: 'testing',
					evidence: 'GAP AC-01: cited line could not be verified.',
					groundingVerified: false,
				},
			],
		}),
		bindings,
	});
	assert.equal(advisoryOnly.status, 'PASSED');

	const unrelated = evaluateCanaryQualificationEvidence({
		evidence: canaryEvidence({
			qaDivergences: [
				{
					severity: 'P2',
					category: 'testing',
					evidence: 'Test names could be more concise.',
					groundingVerified: true,
				},
			],
		}),
		bindings,
	});
	assert.equal(unrelated.status, 'PASSED');
});

test('@ac AC-16 documentation-only commit drift does not stale behavior-bound canary evidence', () => {
	const qualification = evaluateCanaryQualificationEvidence({
		evidence: canaryEvidence(),
		bindings,
	});
	const current = evaluateCanaryFreshness(qualification, { ...bindings });
	assert.equal(current.status, 'CANARY_CURRENT');
	const stale = evaluateCanaryFreshness(qualification, {
		...bindings,
		implementerRoleHash: 'c'.repeat(64),
	});
	assert.equal(stale.status, 'CANARY_STALE');
	assert.equal(stale.reason, 'implementerRoleHash-changed');
});

test('@regression canary-qualification-git-head resolves the current repository commit', () => {
	assert.match(resolveGitHead(process.cwd()), /^[0-9a-f]{40}$/);
});

test('@ac AC-16 isDocumentationOnlyGitRange detects doc-only and synthetic commit ranges', () => {
	assert.equal(isDocumentationOnlyGitRange(process.cwd(), 'a'.repeat(40), 'b'.repeat(40)), false);
	assert.equal(isDocumentationOnlyGitRange(process.cwd(), 'same', 'same'), true);
	assert.equal(isDocumentationOnlyGitRange(process.cwd(), null, 'abc'), true);
});

test('@ac AC-03 @case AC-03.1 facade bindings deep-equal the canary module and use the five keys', () => {
	const fromFacade = reliabilityFacade.currentCanaryBindings(REPOSITORY_ROOT);
	const direct = currentCanaryBindings(REPOSITORY_ROOT);
	assert.deepEqual(fromFacade, direct);
	assert.deepEqual(Object.keys(fromFacade).sort(), [
		'boundedPlanningHash',
		'implementerRoleHash',
		'modelPolicyHash',
		'repositoryId',
		'workflowHash',
	]);
});

test('@ac AC-03 @case AC-03.2 the planning-file list contains the task-planner submodules', () => {
	const listed = listBoundedPlanningFiles(REPOSITORY_ROOT);
	for (const name of ['task-graph.ts', 'workspace-packages.ts', 'task-readiness.ts']) {
		assert.ok(listed.includes(`packages/agent-sdlc/policy/task-planner/${name}`), name);
	}
});

test('@ac AC-03 @case AC-03.3 boundedPlanningHash is the sha256 of the planning-file pairs', () => {
	const pairs = listBoundedPlanningFiles(REPOSITORY_ROOT).map((filename) => [
		filename,
		fs.readFileSync(path.join(REPOSITORY_ROOT, filename), 'utf8'),
	]);
	assert.equal(currentCanaryBindings(REPOSITORY_ROOT).boundedPlanningHash, sha256(pairs));
});

test('@ac AC-03 @case AC-03.4 currentCanaryBindings does not write the qualification file', () => {
	const qualification = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/canary-qualification.json');
	const before = fs.existsSync(qualification) ? fs.readFileSync(qualification) : null;
	currentCanaryBindings(REPOSITORY_ROOT);
	const after = fs.existsSync(qualification) ? fs.readFileSync(qualification) : null;
	assert.deepEqual(after, before);
});

test('@ac AC-03 @case AC-03.5 a changed boundedPlanningHash is CANARY_STALE', () => {
	const current = currentCanaryBindings(REPOSITORY_ROOT);
	const stale = evaluateCanaryFreshness(
		{ status: 'PASSED', ...current },
		{ ...current, boundedPlanningHash: 'd'.repeat(64) },
	);
	assert.equal(stale.status, 'CANARY_STALE');
	assert.equal(stale.reason, 'boundedPlanningHash-changed');
});

test('@ac AC-02 @case AC-02.1 currentCanaryBindings and resolveRunMaxPhysicalCalls succeed on an external host repo without packages/agent-sdlc or .agents/model-usage-policy.json', () => {
	const externalHost = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-external-canary-'));
	try {
		fs.mkdirSync(path.join(externalHost, '.agents'), { recursive: true });
		fs.copyFileSync(
			path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/testing/fixture-host/profile.json'),
			path.join(externalHost, '.agents/sdlc-host.json'),
		);
		const extBindings = currentCanaryBindings(externalHost);
		assert.equal(extBindings.repositoryId, path.basename(externalHost));
		assert.match(extBindings.boundedPlanningHash, /^[a-f0-9]{64}$/);
		assert.match(extBindings.modelPolicyHash, /^[a-f0-9]{64}$/);
		assert.equal(
			extBindings.boundedPlanningHash,
			currentCanaryBindings(REPOSITORY_ROOT).boundedPlanningHash,
		);
		assert.equal(resolveRunMaxPhysicalCalls({ rootDir: externalHost }), 1250);
	} finally {
		fs.rmSync(externalHost, { recursive: true, force: true });
	}
});
