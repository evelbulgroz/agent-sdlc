import { z } from 'zod';
import {
	RUNTIME_SCHEMA_VERSION,
	assertClosedContract,
	assertContractObject,
	failContract,
	validateOpaqueId,
} from './primitives.ts';

export const VALID_ATTRIBUTION_PHASES = Object.freeze([
	'spec',
	'interview',
	'synthesis',
	'plan',
	'code',
	'execution',
	'repair',
	'qa',
	'review',
] as const);

const ROLE_ID = /^[a-z][a-z0-9-]{0,63}$/;

export const ROLE_KINDS = Object.freeze([
	'synthesis',
	'mutation',
	'review',
	'verification',
	'coordination',
] as const);

export const INSERTION_POINTS = Object.freeze(['post_implement', 'pre_review', 'review'] as const);

export const AttributionPhaseSchema = z.enum(VALID_ATTRIBUTION_PHASES);
export type AttributionPhase = z.infer<typeof AttributionPhaseSchema>;

export const RoleKindSchema = z.enum(ROLE_KINDS);
export type RoleKind = z.infer<typeof RoleKindSchema>;

export const InsertionPointSchema = z.enum(INSERTION_POINTS);
export type InsertionPoint = z.infer<typeof InsertionPointSchema>;

export const WorkflowLimitsSchema = z.object({
	maxInterviewRounds: z.number().int().positive(),
	maxQuestionsPerBatch: z.number().int().positive(),
	maxModelOperations: z.number().int().positive(),
	maxGoalBytes: z.number().int().positive(),
	maxAnswerBytes: z.number().int().positive(),
	maxArtifactBytes: z.number().int().positive(),
	maxExportBytes: z.number().int().positive(),
});
export type WorkflowLimits = z.infer<typeof WorkflowLimitsSchema>;

export const WorkflowPipelinesSchema = z.object({
	post_implement: z.array(z.string()).readonly().optional(),
	pre_review: z.array(z.string()).readonly().optional(),
	review: z.array(z.string()).readonly().optional(),
});
export type WorkflowPipelines = z.infer<typeof WorkflowPipelinesSchema>;

export const WorkflowDefinitionSchema = z.object({
	schemaVersion: z.literal(RUNTIME_SCHEMA_VERSION),
	workflowId: z.string(),
	roleId: z.string(),
	roles: z.array(z.string()).readonly().optional(),
	pipelines: WorkflowPipelinesSchema.optional(),
	limits: WorkflowLimitsSchema,
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const RoleRequestedLimitsSchema = z.object({
	maxPromptTokens: z.number().int().min(0),
	maxCompletionTokens: z.number().int().min(0),
	timeoutMs: z.number().int().positive(),
	maxPhysicalAttempts: z.number().int().positive().max(4),
	maxRetriesPerRoute: z.number().int().min(0),
	maxFailovers: z.number().int().min(0),
});
export type RoleRequestedLimits = z.infer<typeof RoleRequestedLimitsSchema>;

export const RoleDefinitionSchema = z.object({
	schemaVersion: z.literal(RUNTIME_SCHEMA_VERSION),
	roleId: z.string(),
	roleKind: RoleKindSchema.optional(),
	insertionPoint: InsertionPointSchema.optional(),
	capabilityId: z.string(),
	evaluatorId: z.string(),
	promptFile: z.string(),
	modelProfile: z.string(),
	requestedLimits: RoleRequestedLimitsSchema,
	routingStrategy: z.enum(['min-cost', 'balanced', 'quality-first']).optional(),
	minQualityTier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
	phaseStrategies: z.record(z.string(), z.enum(['min-cost', 'balanced', 'quality-first'])).optional(),
	phaseMinQualityTiers: z.record(z.string(), z.union([z.literal(1), z.literal(2), z.literal(3)])).optional(),
});
export type RoleDefinition = z.infer<typeof RoleDefinitionSchema>;

export function validateWorkflowDefinition(input: unknown): Readonly<WorkflowDefinition> {
	assertClosedContract(input, ['schemaVersion', 'workflowId', 'roleId', 'roles', 'pipelines', 'limits'], 'workflow');
	if (input.schemaVersion !== RUNTIME_SCHEMA_VERSION) failContract('Unsupported workflow schemaVersion');
	if (typeof input.workflowId !== 'string' || !ROLE_ID.test(input.workflowId)) {
		failContract('Unsupported workflowId');
	}
	const limits = input.limits;
	assertClosedContract(
		limits,
		[
			'maxInterviewRounds',
			'maxQuestionsPerBatch',
			'maxModelOperations',
			'maxGoalBytes',
			'maxAnswerBytes',
			'maxArtifactBytes',
			'maxExportBytes',
		],
		'workflow.limits',
	);
	for (const [key, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || (value as number) <= 0) {
			failContract(`workflow.limits.${key} must be positive`);
		}
	}
	if (
		(limits.maxInterviewRounds as number) > 10 ||
		(limits.maxQuestionsPerBatch as number) > 10 ||
		(limits.maxModelOperations as number) > 10
	) {
		failContract('Workflow operation and interview limits exceed ceilings');
	}
	if (input.roles !== undefined) {
		if (
			!Array.isArray(input.roles) ||
			input.roles.length === 0 ||
			!input.roles.every((r) => typeof r === 'string' && ROLE_ID.test(r))
		) {
			failContract('workflow.roles must be a non-empty array of valid role IDs');
		}
	}
	let pipelines: Readonly<WorkflowPipelines> | undefined;
	if (input.pipelines !== undefined) {
		const rawPipelines = assertContractObject(input.pipelines, 'workflow.pipelines');
		const allowedPoints = ['post_implement', 'pre_review', 'review'] as const;
		assertClosedContract(rawPipelines, allowedPoints, 'workflow.pipelines');
		const built: WorkflowPipelines = {};
		for (const point of allowedPoints) {
			const pointVal = rawPipelines[point];
			if (pointVal !== undefined) {
				if (
					!Array.isArray(pointVal) ||
					!pointVal.every((r) => typeof r === 'string' && ROLE_ID.test(r))
				) {
					failContract(`workflow.pipelines.${point} must be an array of valid role IDs`);
				}
				if (new Set(pointVal).size !== pointVal.length) {
					failContract(`workflow.pipelines.${point} contains duplicate roles`);
				}
				built[point] = Object.freeze([...(pointVal as string[])]);
			}
		}
		pipelines = Object.freeze(built);
	}
	const limitsObj: unknown = { ...limits };
	return Object.freeze({
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		workflowId: input.workflowId,
		roleId: validateRoleId(input.roleId),
		...(Array.isArray(input.roles) ? { roles: Object.freeze([...(input.roles as string[])]) } : {}),
		...(pipelines ? { pipelines } : {}),
		limits: Object.freeze(limitsObj as WorkflowLimits),
	});
}

export function validateRoleId(value: unknown): string {
	if (typeof value !== 'string' || !ROLE_ID.test(value)) failContract('roleId is invalid');
	return value;
}

export function validateRoleDefinition(input: unknown): Readonly<RoleDefinition> {
	assertClosedContract(
		input,
		[
			'schemaVersion',
			'roleId',
			'roleKind',
			'insertionPoint',
			'capabilityId',
			'evaluatorId',
			'promptFile',
			'modelProfile',
			'requestedLimits',
			'routingStrategy',
			'minQualityTier',
			'phaseStrategies',
			'phaseMinQualityTiers',
		],
		'role',
	);
	if (input.schemaVersion !== RUNTIME_SCHEMA_VERSION) failContract('Unsupported role schemaVersion');
	if (
		input.roleKind !== undefined &&
		(typeof input.roleKind !== 'string' || !(ROLE_KINDS as readonly string[]).includes(input.roleKind))
	) {
		failContract('role.roleKind is invalid');
	}
	if (
		input.insertionPoint !== undefined &&
		(typeof input.insertionPoint !== 'string' || !(INSERTION_POINTS as readonly string[]).includes(input.insertionPoint))
	) {
		failContract('role.insertionPoint is invalid');
	}
	if (input.routingStrategy !== undefined) {
		if (
			typeof input.routingStrategy !== 'string' ||
			!['min-cost', 'balanced', 'quality-first'].includes(input.routingStrategy)
		) {
			failContract('role.routingStrategy is invalid');
		}
	}
	if (input.minQualityTier !== undefined) {
		if (
			typeof input.minQualityTier !== 'number' ||
			![1, 2, 3].includes(input.minQualityTier) ||
			!Number.isSafeInteger(input.minQualityTier)
		) {
			failContract('role.minQualityTier is invalid');
		}
	}
	if (input.phaseStrategies !== undefined) {
		if (
			typeof input.phaseStrategies !== 'object' ||
			input.phaseStrategies === null ||
			Array.isArray(input.phaseStrategies)
		) {
			failContract('role.phaseStrategies must be an object');
		}
		for (const [phase, strat] of Object.entries(input.phaseStrategies)) {
			if (!(VALID_ATTRIBUTION_PHASES as readonly string[]).includes(phase)) {
				failContract(`role.phaseStrategies.${phase} is an invalid phase`);
			}
			if (typeof strat !== 'string' || !['min-cost', 'balanced', 'quality-first'].includes(strat)) {
				failContract(`role.phaseStrategies.${phase} strategy is invalid`);
			}
		}
	}
	if (input.phaseMinQualityTiers !== undefined) {
		if (
			typeof input.phaseMinQualityTiers !== 'object' ||
			input.phaseMinQualityTiers === null ||
			Array.isArray(input.phaseMinQualityTiers)
		) {
			failContract('role.phaseMinQualityTiers must be an object');
		}
		for (const [phase, tier] of Object.entries(input.phaseMinQualityTiers)) {
			if (!(VALID_ATTRIBUTION_PHASES as readonly string[]).includes(phase)) {
				failContract(`role.phaseMinQualityTiers.${phase} is an invalid phase`);
			}
			if (typeof tier !== 'number' || ![1, 2, 3].includes(tier) || !Number.isSafeInteger(tier)) {
				failContract(`role.phaseMinQualityTiers.${phase} tier is invalid`);
			}
		}
	}
	const requestedLimits = input.requestedLimits;
	assertClosedContract(
		requestedLimits,
		[
			'maxPromptTokens',
			'maxCompletionTokens',
			'timeoutMs',
			'maxPhysicalAttempts',
			'maxRetriesPerRoute',
			'maxFailovers',
		],
		'role.requestedLimits',
	);
	for (const [key, value] of Object.entries(requestedLimits)) {
		const allowZero =
			key === 'maxRetriesPerRoute' ||
			key === 'maxFailovers' ||
			(input.modelProfile === 'agent-sdlc-deterministic' &&
				(key === 'maxPromptTokens' || key === 'maxCompletionTokens'));
		if (!Number.isSafeInteger(value) || (value as number) < 0 || (!allowZero && value === 0)) {
			failContract(`role.requestedLimits.${key} is invalid`);
		}
	}
	if (input.modelProfile === 'agent-sdlc-deterministic') {
		if (requestedLimits.maxPromptTokens !== 0 || requestedLimits.maxCompletionTokens !== 0) {
			failContract('Deterministic role must specify zero token limits');
		}
	}
	if ((requestedLimits.maxPhysicalAttempts as number) > 4) {
		failContract('Role physical-attempt ceiling exceeds Slice 1');
	}
	if (typeof input.promptFile !== 'string' || !/^[a-z][a-z0-9-]*\.md$/.test(input.promptFile)) {
		failContract('role.promptFile is invalid');
	}
	const limitsUnknown: unknown = { ...requestedLimits };
	const phaseStratUnknown: unknown = input.phaseStrategies !== undefined ? { ...(input.phaseStrategies as Record<string, unknown>) } : undefined;
	const phaseTiersUnknown: unknown = input.phaseMinQualityTiers !== undefined ? { ...(input.phaseMinQualityTiers as Record<string, unknown>) } : undefined;
	return Object.freeze({
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		roleId: validateRoleId(input.roleId),
		...(input.roleKind !== undefined ? { roleKind: input.roleKind as RoleKind } : {}),
		...(input.insertionPoint !== undefined ? { insertionPoint: input.insertionPoint as InsertionPoint } : {}),
		capabilityId: validateOpaqueId(input.capabilityId, 'role.capabilityId'),
		evaluatorId: validateOpaqueId(input.evaluatorId, 'role.evaluatorId'),
		promptFile: input.promptFile,
		modelProfile: validateOpaqueId(input.modelProfile, 'role.modelProfile'),
		requestedLimits: Object.freeze(limitsUnknown as RoleRequestedLimits),
		...(input.routingStrategy !== undefined
			? { routingStrategy: input.routingStrategy as RoleDefinition['routingStrategy'] }
			: {}),
		...(input.minQualityTier !== undefined
			? { minQualityTier: input.minQualityTier as RoleDefinition['minQualityTier'] }
			: {}),
		...(phaseStratUnknown !== undefined
			? { phaseStrategies: Object.freeze(phaseStratUnknown as NonNullable<RoleDefinition['phaseStrategies']>) }
			: {}),
		...(phaseTiersUnknown !== undefined
			? { phaseMinQualityTiers: Object.freeze(phaseTiersUnknown as NonNullable<RoleDefinition['phaseMinQualityTiers']>) }
			: {}),
	});
}
