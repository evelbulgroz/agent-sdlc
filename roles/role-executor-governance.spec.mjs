import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FakeModelAdapter } from '@evelbulgroz/model-usage-govenor/adapters/fake';
import { ModelUsageError } from '@evelbulgroz/model-usage-govenor/errors';
import { executeOperation } from '@evelbulgroz/model-usage-govenor';
import {
	cleanupTestRoot,
	enabledFakePolicy,
	makeTestRoot,
	writePolicy,
} from '@evelbulgroz/model-usage-govenor/test-support';
import { selectRoutes } from '@evelbulgroz/model-usage-govenor/routing';
import { validatePolicy } from '@evelbulgroz/model-usage-govenor/policy';
import { RepositoryModelGovernor } from '../adapters/model-governor.ts';
import { SdlcError } from '../policy/errors.ts';
import { RoleExecutor } from './role-executor.ts';
import { RoleRegistry } from './role-registry.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { completeProposal, makeFixture } from '../testing/test-support.mjs';

test('RepositoryModelGovernor preserves budget dimension details', async () => {
	const governor = new RepositoryModelGovernor({
		execute: async () => {
			throw new ModelUsageError('ERR_BUDGET_RESERVATION_DENIED', 'Budget denied', {
				dimension: 'totalTokens',
				limit: 26000,
				requested: 27000,
				remaining: 26000,
			});
		},
	});

	await assert.rejects(
		() => governor.execute({}),
		(error) =>
			error.code === 'GOVERNOR_BUDGET_DENIED' &&
			error.message.includes(
				'totalTokens exceeded: limit=26000, requested=27000, remaining=26000',
			),
	);
});

test('generic role executor propagates typed governor failures', async () => {
	for (const error of [
		new SdlcError('GOVERNOR_BUDGET_DENIED', 'budget'),
		new SdlcError('GOVERNOR_CONCURRENCY_DENIED', 'concurrency'),
		new SdlcError('GOVERNOR_ROUTES_EXHAUSTED', 'routes'),
	]) {
		const fixture = makeFixture(`role-${error.code.toLowerCase()}`, [error]);
		try {
			const state = fixture.runtime.initialize({
				runId: fixture.runId,
				goal: 'Build the workflow',
			});

			const loaded = fixture.registry.load();
			const executor = new RoleExecutor({
				governor: fixture.governor,
				runtimeStore: fixture.store,
				artifactStore: fixture.artifacts,
			});
			await assert.rejects(
				executor.execute({
					runId: fixture.runId,
					role: loaded.role,
					roleHash: loaded.hashes.roleHash,
					promptPolicy: loaded.promptPolicy,
					draft: fixture.artifacts.readJson(state.draftArtifact),
					completeness: state.completeness,
					generation: 1,
					maxQuestions: 5,
				}),
				(actual) => actual.code === error.code,
			);
		} finally {
			fixture.close();
		}
	}
});

test('production adapter fails closed when incompatible and integrates through governor accounting', async () => {
	assert.throws(
		() => new RepositoryModelGovernor({ execute: null }),
		(error) => error.code === 'GOVERNOR_UNAVAILABLE',
	);
	const root = makeTestRoot('sdlc-adapter');
	try {
		const policyPath = writePolicy(root, enabledFakePolicy());
		const fakeAdapter = new FakeModelAdapter('fake-governed', [
			{
				status: 'succeeded',
				output: { ok: true },
				usage: { promptTokens: 2, completionTokens: 1, source: 'provider' },
			},
		]);
		const adapter = new RepositoryModelGovernor({
			execute: executeOperation,
			executeOptions: {
				policyPath,
				stateRoot: path.join(root, 'state'),
				adapters: new Map([['fake-governed', fakeAdapter]]),
				localPolicyPath: null,
			},
		});
		const result = await adapter.execute({
			schemaVersion: '1.0.0',
			operationId: 'adapter-operation',
			runId: 'adapter-run',
			consumer: 'agent-sdlc',
			profile: 'agent-sdlc-default',
			attribution: {
				taskId: 'task',
				nodeId: 'node',
				roleId: 'role',
				generation: 1,
			},
			prompt: 'Return ok.',
			structuredOutputSchema: {
				type: 'object',
				required: ['ok'],
				properties: { ok: { type: 'boolean' } },
				additionalProperties: false,
			},
			routingConstraints: { requiredCapabilities: ['structured-output'] },
			requestedLimits: { maxCompletionTokens: 32, maxPhysicalAttempts: 1 },
		});
		assert.deepEqual(result.output, { ok: true });
		assert.equal(result.usageRecordIds.length, 1);
		assert.equal(fakeAdapter.callCount, 1);
	} finally {
		cleanupTestRoot(root);
	}
});

test('RepositoryModelGovernor inherits conventional local policy by default', async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-default-policy-'));
	const tempLocalPolicyPath = path.join(tempDir, 'local-policy.json');
	const root = makeTestRoot('sdlc-local-policy');
	const fakeAdapter = new FakeModelAdapter('fake-governed', [
		{
			status: 'succeeded',
			output: { ok: true },
			usage: { promptTokens: 2, completionTokens: 1, source: 'provider' },
		},
	]);
	try {
		const policyPath = writePolicy(root, enabledFakePolicy());
		fs.writeFileSync(
			tempLocalPolicyPath,
			JSON.stringify({
				profiles: {
					'agent-sdlc-default': {
						limits: {
							maxTotalTokens: 1,
							maxPhysicalAttempts: 1,
						},
					},
				},
			}),
		);
		const adapter = new RepositoryModelGovernor({
			execute: executeOperation,
			executeOptions: {
				policyPath,
				stateRoot: path.join(root, 'state'),
				adapters: new Map([['fake-governed', fakeAdapter]]),
				defaultLocalPolicyPath: tempLocalPolicyPath,
			},
		});
		await assert.rejects(
			adapter.execute({
				schemaVersion: '1.0.0',
				operationId: 'inherited-local-policy-op',
				runId: 'inherited-local-policy-run',
				consumer: 'agent-sdlc',
				profile: 'agent-sdlc-default',
				attribution: { taskId: 't', nodeId: 'n', roleId: 'r', generation: 1 },
				prompt: 'Return ok.',
				structuredOutputSchema: {
					type: 'object',
					required: ['ok'],
					properties: { ok: { type: 'boolean' } },
					additionalProperties: false,
				},
			}),
			(error) =>
				error.code === 'GOVERNOR_BUDGET_DENIED' &&
				error.cause?.code === 'ERR_TOKEN_BUDGET_EXCEEDED',
		);
		assert.equal(fakeAdapter.callCount, 0);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
		cleanupTestRoot(root);
	}
});

test('AC-12 / AC-21: role executor resolves phase strategies, tier floors, and forwards calibration', async () => {
	const capturedRequests = [];
	const fakeGovernor = {
		synthetic: true,
		async execute(request) {
			capturedRequests.push(request);
			return {
				synthetic: true,
				output: completeProposal(),
				usageRecordIds: ['usage-1'],
				replayed: false,
				effectiveStrategy: request.routingConstraints?.strategy,
				selectedQualityTier: request.routingConstraints?.minQualityTier ?? 1,
				counterfactualTier2CostMicrousd: 500,
			};
		},
	};

	const fixture = makeFixture('role-phase-calibration', []);
	try {
		const state = fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Calibration spec',
		});
		const loaded = fixture.registry.load();
		const roleWithPhases = {
			...loaded.role,
			routingStrategy: 'quality-first',
			minQualityTier: 3,
			phaseStrategies: {
				interview: 'quality-first',
				synthesis: 'quality-first',
			},
			phaseMinQualityTiers: {
				synthesis: 3,
			},
		};

		const executor = new RoleExecutor({
			governor: fakeGovernor,
			runtimeStore: fixture.store,
			artifactStore: fixture.artifacts,
		});

		// 1. Execute interview phase
		await executor.execute({
			runId: fixture.runId,
			role: roleWithPhases,
			roleHash: loaded.hashes.roleHash,
			promptPolicy: loaded.promptPolicy,
			draft: fixture.artifacts.readJson(state.draftArtifact),
			completeness: state.completeness,
			generation: 1,
			maxQuestions: 3,
			phase: 'interview',
		});

		assert.equal(capturedRequests.length, 1);
		assert.equal(capturedRequests[0].attribution.phase, 'interview');
		assert.equal(capturedRequests[0].routingConstraints.strategy, 'quality-first');
		assert.equal(capturedRequests[0].routingConstraints.minQualityTier, 3);

		// 2. Execute synthesis phase
		await executor.execute({
			runId: fixture.runId,
			role: roleWithPhases,
			roleHash: loaded.hashes.roleHash,
			promptPolicy: loaded.promptPolicy,
			draft: fixture.artifacts.readJson(state.draftArtifact),
			completeness: state.completeness,
			generation: 2,
			maxQuestions: 3,
			phase: 'synthesis',
		});

		assert.equal(capturedRequests.length, 2);
		assert.equal(capturedRequests[1].attribution.phase, 'synthesis');
		assert.equal(capturedRequests[1].routingConstraints.strategy, 'quality-first');
		assert.equal(capturedRequests[1].routingConstraints.minQualityTier, 3);
	} finally {
		fixture.close();
	}
});

test('@ac AC-03 @case AC-03.1 example:conditioning-specifier-synthesis-tier1-churn invariant graduation test', () => {
	const { role: specifierRole } = new RoleRegistry({ rootDir: REPOSITORY_ROOT }).loadRole(
		'specifier',
	);

	// Reliability-first calibration keeps synthesis on Tier 3 even under pressure.
	assert.equal(specifierRole.phaseMinQualityTiers?.synthesis, 3);

	const policyPath = path.join(REPOSITORY_ROOT, '.agents/model-usage-policy.json');
	const committedPolicy = validatePolicy(JSON.parse(fs.readFileSync(policyPath, 'utf8')));
	const profile = committedPolicy.profiles['agent-sdlc-default'];

	// 1. Under healthy runway (1.0 ratio), synthesis selects Tier 3.
	const healthyDecision = selectRoutes(
		committedPolicy,
		profile,
		{
			requiredCapabilities: ['structured-output'],
			minQualityTier: specifierRole.phaseMinQualityTiers.synthesis,
			strategy: 'quality-first',
		},
		[],
		{ estPromptTokens: 1000, remainingRunCostMicrousd: 100_000_000 },
	);
	assert.ok(healthyDecision.routes.length > 0);
	assert.equal(healthyDecision.routes[0].qualityTier, 3);

	// 2. Under runway pressure, the Tier 3 floor remains a hard invariant.
	const pressureDecision = selectRoutes(
		committedPolicy,
		profile,
		{
			requiredCapabilities: ['structured-output'],
			minQualityTier: specifierRole.phaseMinQualityTiers.synthesis,
			strategy: 'quality-first',
		},
		[],
		{ estPromptTokens: 1000, remainingRunCostMicrousd: 10_000 },
	);
	assert.ok(pressureDecision.routes.length > 0);
	assert.equal(pressureDecision.routes[0].qualityTier, 3);
	assert.equal(pressureDecision.pressureActive, true);
	assert.equal(pressureDecision.effectiveStrategy, 'min-cost');
});
