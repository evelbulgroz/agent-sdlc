import assert from 'node:assert/strict';
import test from 'node:test';
import { VALID_ATTRIBUTION_PHASES, validateRoleDefinition, validateWorkflowDefinition } from './role-schema.ts';

test('workflow definition contract supports pipelines and custom workflow IDs', () => {
	const validWf = {
		schemaVersion: '1.0.0',
		workflowId: 'sdlc-extended-roles',
		roleId: 'specifier',
		roles: ['specifier', 'implementer', 'reviewer', 'verifier', 'repairer', 'cleaner', 'architect', 'hardener'],
		pipelines: {
			post_implement: ['cleaner', 'hardener'],
			pre_review: ['architect'],
			review: ['reviewer'],
		},
		limits: {
			maxInterviewRounds: 3,
			maxQuestionsPerBatch: 5,
			maxModelOperations: 3,
			maxGoalBytes: 65536,
			maxAnswerBytes: 65536,
			maxArtifactBytes: 262144,
			maxExportBytes: 524288,
		},
	};
	const parsed = validateWorkflowDefinition(validWf);
	assert.equal(parsed.workflowId, 'sdlc-extended-roles');
	assert.deepEqual(parsed.pipelines.post_implement, ['cleaner', 'hardener']);

	// Duplicate roles in pipeline must throw
	assert.throws(
		() =>
			validateWorkflowDefinition({
				...validWf,
				pipelines: {
					...validWf.pipelines,
					post_implement: ['cleaner', 'cleaner'],
				},
			}),
		/contains duplicate roles/,
	);

	// Unknown insertion point in pipelines must throw
	assert.throws(
		() =>
			validateWorkflowDefinition({
				...validWf,
				pipelines: {
					...validWf.pipelines,
					post_verification: ['cleaner'],
				},
			}),
		/unknown field 'post_verification'/,
	);
});

test('validateRoleDefinition validates calibration fields and fails closed on invalid strategies or tiers', () => {
	const validRole = {
		schemaVersion: '1.0.0',
		roleId: 'specifier',
		capabilityId: 'governed-structured-synthesis-v1',
		evaluatorId: 'specification-proposal-v1',
		promptFile: 'specifier.md',
		modelProfile: 'agent-sdlc-default',
		routingStrategy: 'balanced',
		minQualityTier: 1,
		phaseStrategies: {
			interview: 'min-cost',
			synthesis: 'balanced',
		},
		phaseMinQualityTiers: {
			synthesis: 2,
		},
		requestedLimits: {
			maxPromptTokens: 4096,
			maxCompletionTokens: 1536,
			timeoutMs: 60000,
			maxPhysicalAttempts: 1,
			maxRetriesPerRoute: 0,
			maxFailovers: 0,
		},
	};

	const parsed = validateRoleDefinition(validRole);
	assert.equal(parsed.routingStrategy, 'balanced');
	assert.equal(parsed.minQualityTier, 1);
	assert.equal(parsed.phaseStrategies.interview, 'min-cost');
	assert.equal(parsed.phaseMinQualityTiers.synthesis, 2);
	assert.equal(
		validateRoleDefinition({
			...validRole,
			requestedLimits: { ...validRole.requestedLimits, maxPhysicalAttempts: 4 },
		}).requestedLimits.maxPhysicalAttempts,
		4,
	);
	assert.throws(
		() =>
			validateRoleDefinition({
				...validRole,
				requestedLimits: { ...validRole.requestedLimits, maxPhysicalAttempts: 5 },
			}),
		/physical-attempt ceiling/,
	);

	// Invalid routingStrategy
	assert.throws(
		() => validateRoleDefinition({ ...validRole, routingStrategy: 'invalid-strat' }),
		/role\.routingStrategy is invalid/,
	);

	// Invalid minQualityTier
	assert.throws(
		() => validateRoleDefinition({ ...validRole, minQualityTier: 4 }),
		/role\.minQualityTier is invalid/,
	);
	assert.throws(
		() => validateRoleDefinition({ ...validRole, minQualityTier: 0 }),
		/role\.minQualityTier is invalid/,
	);

	// Invalid phase in phaseStrategies
	assert.throws(
		() =>
			validateRoleDefinition({
				...validRole,
				phaseStrategies: { 'invalid-phase': 'min-cost' },
			}),
		/is an invalid phase/,
	);

	// Invalid strategy in phaseStrategies
	assert.throws(
		() =>
			validateRoleDefinition({
				...validRole,
				phaseStrategies: { interview: 'ultra-cheap' },
			}),
		/strategy is invalid/,
	);

	// Invalid phase in phaseMinQualityTiers
	assert.throws(
		() =>
			validateRoleDefinition({
				...validRole,
				phaseMinQualityTiers: { 'invalid-phase': 2 },
			}),
		/is an invalid phase/,
	);

	// Invalid tier in phaseMinQualityTiers
	assert.throws(
		() =>
			validateRoleDefinition({
				...validRole,
				phaseMinQualityTiers: { synthesis: 5 },
			}),
		/tier is invalid/,
	);

	// Unknown field fails closed
	assert.throws(
		() => validateRoleDefinition({ ...validRole, unexpectedField: 'bad' }),
		/unknown field 'unexpectedField'/,
	);
});

test('VALID_ATTRIBUTION_PHASES lists the expected phases', () => {
	assert.deepEqual([...VALID_ATTRIBUTION_PHASES], [
		'spec',
		'interview',
		'synthesis',
		'plan',
		'code',
		'execution',
		'repair',
		'qa',
		'review',
	]);
});
