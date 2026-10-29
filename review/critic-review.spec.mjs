import '../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { estimatePromptTokens } from '@evelbulgroz/model-usage-govenor/tokenizer';
import { CriticReviewAdapter, buildCriticOperationId, computeScopeDigest } from './critic-review.ts';
import { CRITIC_FINDINGS_SCHEMA, buildPhasePrompt } from './critic-prompt.ts';
import { RepositoryModelGovernor } from '../adapters/model-governor.ts';
import { ReviewGenerationAdapter } from './review-generation.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';
import { SdlcError } from '../policy/errors.ts';
import { FakeGovernorForCritic } from '../testing/critic-fixtures.mjs';
import { makeFixture } from '../testing/test-support.mjs';

test('computeScopeDigest and buildCriticOperationId are deterministic', () => {
	const digest1 = computeScopeDigest('tools/agent-sdlc');
	const digest2 = computeScopeDigest(['tools/agent-sdlc']);
	assert.equal(digest1.length, 32);
	assert.match(digest1, /^[a-f0-9]{32}$/);
	assert.equal(digest1, digest2);

	const opId = buildCriticOperationId({
		runId: '2026-09-06-test-run',
		phase: 'code',
		scopeDigest: digest1,
		generation: 0,
	});
	assert.equal(opId, `2026-09-06-test-run:critic:code:${digest1}:g0`);
});

test('@ac AC-01 @case AC-01.3 the adapter has no buildPhasePrompt method and sends the governor the free-function prompt', async () => {
	assert.equal(CriticReviewAdapter.prototype.buildPhasePrompt, undefined);
	const governor = new FakeGovernorForCritic();
	const adapter = new CriticReviewAdapter({ rootDir: REPOSITORY_ROOT, governor });
	const input = { phase: 'spec', documentText: '# Spec: Small\nGoals.' };
	await adapter.executeReview({
		runId: '2026-10-24-test-prompt-parity',
		authorVendor: 'google',
		scope: '',
		...input,
	});
	assert.equal(governor.calls.length, 1);
	assert.equal(governor.calls[0].prompt, buildPhasePrompt({ rootDir: REPOSITORY_ROOT, ...input }));
});

test('executeReview rejects missing author vendors and any contributing reviewer vendor', async () => {
	const governor = new FakeGovernorForCritic({ vendor: 'google' });
	const adapter = new CriticReviewAdapter({ rootDir: REPOSITORY_ROOT, governor });

	await assert.rejects(
		() =>
			adapter.executeReview({
				runId: '2026-09-06-test-run',
				phase: 'code',
				scope: 'tools/agent-sdlc',
			}),
		/Canonical author vendor is required/,
	);

	await assert.rejects(
		() =>
			adapter.executeReview({
				runId: '2026-09-06-test-run',
				authorVendors: ['gpt-6.1-sol', 'gemini-2.5-flash'],
				phase: 'code',
				scope: 'tools/agent-sdlc',
			}),
		/matches an excluded author vendor: openai, google/,
	);
});

test('executeReview fails closed when reviewer vendor is missing or unknown', async () => {
	const governorWithoutVendor = {
		execute: async (request) => ({
			schemaVersion: '1.0.0',
			synthetic: true,
			output: { status: 'PASS', findings: [] },
			operationId: request.operationId,
			route: null,
			usageRecordIds: [],
		}),
	};

	const adapter = new CriticReviewAdapter({
		rootDir: REPOSITORY_ROOT,
		governor: governorWithoutVendor,
	});

	await assert.rejects(
		() =>
			adapter.executeReview({
				runId: '2026-09-06-test-run',
				authorVendor: 'openai',
				phase: 'code',
				scope: 'tools/agent-sdlc',
			}),
		(err) => err.code === 'CRITIC_REVIEW_FAILED' && err.message.includes('unresolved reviewer vendor'),
	);
});

test('executeReview derives status strictly from P1 findings even if model reports PASS', async () => {
	const governor = new FakeGovernorForCritic({
		vendor: 'openai',
		model: 'gpt-4o',
		output: {
			status: 'PASS',
			findings: [
				{
					severity: 'P1',
					category: 'correctness',
					file: 'review/critic-review.ts',
					evidence: 'Critical error',
					impact: 'Crash',
					remediation: 'Fix',
				},
			],
		},
	});

	const adapter = new CriticReviewAdapter({
		rootDir: REPOSITORY_ROOT,
		governor,
	});

	const result = await adapter.executeReview({
		runId: '2026-09-06-test-run',
		authorVendor: 'google',
		phase: 'code',
		scope: 'review',
	});

	assert.equal(result.hasP1, true);
	assert.equal(result.status, 'FAIL', 'Status must be FAIL when P1 findings exist, regardless of model status');
});

test('executeReview works across spec and plan phases and records operationId/usageRecordIds', async () => {
	const fixture = makeFixture('critic-spec-plan', []);
	fixture.runtime.initialize({
		runId: fixture.runId,
		goal: 'Implement spec review',
	});

	const reviewBaseDir = path.join(fixture.runtimeDir, 'review');

	// Create test rubrics directory in fixture root
	const rubricsDir = path.join(fixture.runtimeDir, '.agents', 'review-rubrics');
	fs.mkdirSync(rubricsDir, { recursive: true });
	fs.writeFileSync(path.join(rubricsDir, 'spec.md'), '# Test Spec Rubric', 'utf8');
	fs.writeFileSync(path.join(rubricsDir, 'plan.md'), '# Test Plan Rubric', 'utf8');

	const governor = new FakeGovernorForCritic({
		vendor: 'anthropic',
		model: 'claude-3-5-sonnet',
		usageRecordIds: ['rec-usage-42'],
		output: {
			status: 'PASS',
			findings: [],
		},
	});

	const adapter = new CriticReviewAdapter({
		rootDir: fixture.runtimeDir,
		governor,
		runtimeStore: fixture.store,
		reviewBaseDir,
	});

	try {
		// Test spec phase
		const specResult = await adapter.executeReview({
			runId: fixture.runId,
			generation: 0,
			phase: 'spec',
			scope: 'docs/specs/my-spec.md',
			authorVendors: ['google', 'openai'],
			documentText: '# Spec document\nGoals and non-goals.',
			preferredRouteIds: ['preferred-anthropic-route'],
		});

		assert.equal(specResult.status, 'PASS');
		assert.equal(specResult.phase, 'spec');
		assert.equal(specResult.reviewerVendor, 'anthropic');
		assert.deepEqual(specResult.usageRecordIds, ['rec-usage-42']);

		// Verify governor call received preferredRouteIds
		const lastCall = governor.calls[governor.calls.length - 1];
		assert.deepEqual(lastCall.routingConstraints.preferredRouteIds, ['preferred-anthropic-route']);
		assert.deepEqual(lastCall.routingConstraints.excludedVendors, ['google', 'openai']);

		// Verify host report contains operationId and usageRecordIds
		const reportPath = path.join(fixture.runtimeDir, specResult.reportPath);
		const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
		assert.equal(report.phase, 'spec');
		assert.deepEqual(report.authorVendors, ['google', 'openai']);
		assert.equal(report.operationId, specResult.operationId);
		assert.deepEqual(report.usageRecordIds, ['rec-usage-42']);

		// Test plan phase
		const planResult = await adapter.executeReview({
			runId: fixture.runId,
			generation: 1,
			phase: 'plan',
			scope: 'docs/specs/my-plan.md',
			authorVendor: 'openai',
			documentText: '# Plan document\nSlices and tasks.',
		});
		assert.equal(planResult.status, 'PASS');
		assert.equal(planResult.phase, 'plan');
		assert.equal(planResult.reviewerVendor, 'anthropic');
	} finally {
		fixture.close();
	}
});

test('CriticReviewAdapter integrates with real RepositoryModelGovernor.execute forwarding route', async () => {
	// Mock underlying governor executeOperation
	let capturedRequest = null;
	const mockExecuteOp = async (request) => {
		capturedRequest = request;
		return {
			schemaVersion: '1.0.0',
			status: 'succeeded',
			output: { status: 'PASS', findings: [] },
			operationId: request.operationId,
			replayed: false,
			route: {
				routeId: 'openai-compatible-conservative',
				provider: 'openai',
				model: 'gpt-4o-mini',
				canonicalVendor: 'openai',
			},
			usageRecordIds: ['rec-real-gov-1', 'rec-real-gov-2'],
		};
	};

	const governor = new RepositoryModelGovernor({
		execute: mockExecuteOp,
	});

	const fixture = makeFixture('critic-real-gov', []);
	const reviewBaseDir = path.join(fixture.runtimeDir, 'review');
	const rubricsDir = path.join(fixture.runtimeDir, '.agents', 'review-rubrics');
	fs.mkdirSync(rubricsDir, { recursive: true });
	fs.writeFileSync(path.join(rubricsDir, 'code.md'), '# Code Rubric', 'utf8');

	const adapter = new CriticReviewAdapter({
		rootDir: fixture.runtimeDir,
		governor,
		reviewBaseDir,
	});

	try {
		const result = await adapter.executeReview({
			runId: '2026-09-08-real-gov-test',
			authorVendor: 'google',
			phase: 'code',
			scope: 'tools/agent-sdlc',
			diff: 'diff --git a/test b/test',
		});

		assert.equal(result.status, 'PASS');
		assert.equal(result.reviewerVendor, 'openai');
		assert.equal(result.reviewerModel, 'gpt-4o-mini');
		assert.deepEqual(result.usageRecordIds, ['rec-real-gov-1', 'rec-real-gov-2']);

		// Verify governor request contract
		assert.ok(capturedRequest, 'capturedRequest must exist');
		assert.equal(capturedRequest.schemaVersion, '1.0.0');
		assert.equal(capturedRequest.consumer, 'agent-sdlc');
		assert.equal(capturedRequest.profile, 'critic-review');
		assert.equal(capturedRequest.attribution?.nodeId, 'critic_review');
		assert.equal(capturedRequest.attribution?.roleId, 'critic-reviewer');
		assert.equal(capturedRequest.attribution?.phase, 'code');
		assert.equal(capturedRequest.attribution?.scope, 'tools/agent-sdlc');
		assert.ok(capturedRequest.attribution?.taskId);
		assert.equal(capturedRequest.routingConstraints?.strategy, 'quality-first');
		assert.equal(capturedRequest.routingConstraints?.minQualityTier, 3);

		// Verify host report persists both IDs
		const reportPath = path.join(fixture.runtimeDir, result.reportPath);
		const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
		assert.equal(report.operationId, result.operationId);
		assert.deepEqual(report.usageRecordIds, ['rec-real-gov-1', 'rec-real-gov-2']);
	} finally {
		fixture.close();
	}
});

test('executeReview trips circuit breaker on P1 findings and enforces repair limits', async () => {
	const fixture = makeFixture('critic-p1', []);
	fixture.runtime.initialize({
		runId: fixture.runId,
		goal: 'Implement critic review with P1',
	});

	const reviewBaseDir = path.join(fixture.runtimeDir, 'review');
	const rubricsDir = path.join(fixture.runtimeDir, '.agents', 'review-rubrics');
	fs.mkdirSync(rubricsDir, { recursive: true });
	fs.writeFileSync(path.join(rubricsDir, 'code.md'), '# Code Rubric', 'utf8');

	const citedFileDir = path.join(fixture.runtimeDir, 'packages', 'shared-base', 'src');
	fs.mkdirSync(citedFileDir, { recursive: true });
	fs.writeFileSync(path.join(citedFileDir, 'auth.ts'), 'export function auth() {}\n', 'utf8');

	const auth = createDefaultAuthorizationEnvelope({
		runId: fixture.runId,
		approvedSpecHash: 'b'.repeat(64),
		baseCommitSha: 'd'.repeat(40),
		allowedPackages: ['packages/shared-base'],
		allowedPathPrefixes: ['packages/shared-base'],
		maxSemanticRepairs: 2,
		createBranch: true,
		createLocalCommits: true,
	});
	fixture.store.saveAuthorization(auth);

	const reviewPort = new ReviewGenerationAdapter({
		runtimeStore: fixture.store,
		maxSemanticRepairs: 2,
	});

	const governor = new FakeGovernorForCritic({
		vendor: 'openai',
		model: 'gpt-4o',
		output: {
			status: 'FAIL',
			findings: [
				{
					severity: 'P1',
					category: 'security',
					file: 'packages/shared-base/src/auth.ts',
					evidence: 'Critical boundary bypass',
					impact: 'High',
					remediation: 'Enforce boundary',
				},
			],
		},
	});

	const adapter = new CriticReviewAdapter({
		rootDir: fixture.runtimeDir,
		governor,
		runtimeStore: fixture.store,
		reviewPort,
		reviewBaseDir,
	});

	try {
		const result = await adapter.executeReview({
			runId: fixture.runId,
			generation: 0,
			phase: 'code',
			scope: ['packages/shared-base'],
			authorVendor: 'google',
		});

		assert.equal(result.hasP1, true);
		assert.equal(result.circuitBreakerTripped, true);
		assert.equal(result.circuitBreakerReason, 'HIGH_RISK_PATH_REPAIR_PROHIBITED');
		const [storedReview] = fixture.store.listCriticReviews(fixture.runId, 0);
		assert.deepEqual(JSON.parse(storedReview.findingsJson), result.findings);
		assert.equal(storedReview.reportArtifact, result.reportPath);

		// Resolve dispute via human override
		const resolution = await reviewPort.resolveDisputedReview(fixture.runId, 0, 'override', {
			overrideAuthor: 'architect-lead',
		});
		assert.equal(resolution.status, 'resolved');
		assert.equal(resolution.resolution, 'override');
	} finally {
		fixture.close();
	}
});

test('executeReview omits scope from attribution when empty or undefined', async () => {
	const governor = new FakeGovernorForCritic({
		vendor: 'openai',
		model: 'gpt-4o',
		output: { status: 'PASS', findings: [] },
	});

	const adapter = new CriticReviewAdapter({
		rootDir: REPOSITORY_ROOT,
		governor,
	});

	await adapter.executeReview({
		runId: '2026-09-06-test-run',
		authorVendor: 'google',
		phase: 'spec',
		scope: '',
	});

	assert.equal(governor.calls.length, 1);
	assert.equal('scope' in governor.calls[0].attribution, false);
});

test('executeReview preserves GOVERNOR_ROUTES_EXHAUSTED when candidate routes are exhausted', async () => {
	const governor = {
		execute: async () => {
			throw new SdlcError('GOVERNOR_ROUTES_EXHAUSTED', 'No allowed governed model route completed');
		},
	};
	const adapter = new CriticReviewAdapter({
		rootDir: REPOSITORY_ROOT,
		governor,
	});

	await assert.rejects(
		() =>
			adapter.executeReview({
				runId: '2026-10-06-test-routes-exhausted',
				authorVendors: ['openai', 'google', 'anthropic', 'xai'],
				phase: 'qa',
				documentText: '# Spec: Test',
				rubric: '# QA Rubric',
			}),
		(err) =>
			err.code === 'GOVERNOR_ROUTES_EXHAUSTED' &&
			err.message.includes('No allowed governed model route completed'),
	);
});

test('executeReview truncates prompts exceeding ceiling to <= targetCeiling without throwing GOVERNOR_BUDGET_DENIED', async () => {
	const governor = new FakeGovernorForCritic();
	const adapter = new CriticReviewAdapter({ rootDir: REPOSITORY_ROOT, governor });

	// Document fits within buildPhasePrompt ceiling (24KB) but would produce >20,000 tokens
	const largeDoc = 'Word '.repeat(4200); // ~21 KB
	assert.ok(Buffer.byteLength(largeDoc, 'utf8') <= 24576);

	const result = await adapter.executeReview({
		runId: '2026-09-24-test-truncation',
		generation: 0,
		phase: 'spec',
		authorVendor: 'google',
		documentText: largeDoc,
	});

	assert.equal(governor.calls.length, 1);
	const executedPrompt = governor.calls[0].prompt;
	assert.match(executedPrompt, /\[prompt truncated for token budget\]$/);

	const est = estimatePromptTokens({
		prompt: executedPrompt,
		structuredOutputSchema: CRITIC_FINDINGS_SCHEMA,
		routeFraming: 'Return only JSON matching the supplied schema.\n',
	});
	assert.ok(est.promptTokens <= 19800);
});
