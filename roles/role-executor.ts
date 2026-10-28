import { assertAuthoritativeInputSafe } from '../persistence/artifacts.ts';
import type { ModelOperationInput } from '../persistence/model-operation-records.ts';
import {
	type CompletenessEvaluation,
	type RoleDefinition,
	type SpecDraft,
	sha256,
} from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { getEvaluator } from '../review/evaluator-registry.ts';
import {
	applyPatch,
	evaluateCompleteness,
	validateProposalCompatibility,
} from '../workflow/specification.ts';
import { getCapability } from './capability-registry.ts';
import { resolveScopeLearnings } from './upstream-recall.ts';

export interface RoleExecutorGovernorPort {
	readonly synthetic?: boolean;
	assertAvailable?(): Promise<unknown>;
	assertCanReserve?(request: Record<string, unknown>): Promise<unknown> | unknown;
	execute(request: unknown): Promise<{
		synthetic?: boolean;
		output?: unknown;
		usageRecordIds?: readonly string[];
		replayed?: boolean;
		effectiveStrategy?: string;
		selectedQualityTier?: number;
		counterfactualTier2CostMicrousd?: number | null;
		attempts?: number;
		attemptedRoutes?: readonly unknown[];
		route?: {
			routeId?: string;
			provider?: string;
			model?: string;
			canonicalVendor?: string;
		} | null;
	}>;
}

export interface RoleExecutorRuntimeStorePort {
	readonly rootDir?: string;
	getModelOperation(operationId: string): {
		status?: string;
		outputArtifact?: string | null;
		synthetic?: boolean;
		usageRecordIds?: readonly string[];
		effectiveStrategy?: string | null;
		selectedQualityTier?: number | null;
		counterfactualTier2CostMicrousd?: number | null;
	} | null;
	recordModelOperation(record: ModelOperationInput): unknown;
}

export interface RoleExecutorArtifactStorePort {
	readJson(hash: string): unknown;
	writeJson(prefix: string, payload: unknown): string;
}

export interface RoleExecutorExecuteOptions {
	runId: string;
	role: Readonly<RoleDefinition>;
	roleHash: string;
	promptPolicy: string;
	draft: Readonly<SpecDraft>;
	completeness: Readonly<CompletenessEvaluation>;
	generation: number;
	maxQuestions: number;
	criticFindings?: readonly unknown[];
	phase?: string;
}

export class RoleExecutor {
	readonly governor: RoleExecutorGovernorPort;
	readonly runtimeStore: RoleExecutorRuntimeStorePort;
	readonly artifactStore: RoleExecutorArtifactStorePort;
	readonly onBoundary: (boundary: string, context: Record<string, unknown>) => Promise<void>;

	constructor({
		governor,
		runtimeStore,
		artifactStore,
		onBoundary,
	}: {
		governor: RoleExecutorGovernorPort;
		runtimeStore: RoleExecutorRuntimeStorePort;
		artifactStore: RoleExecutorArtifactStorePort;
		onBoundary?: (boundary: string, context: Record<string, unknown>) => Promise<void>;
	}) {
		this.governor = governor;
		this.runtimeStore = runtimeStore;
		this.artifactStore = artifactStore;
		this.onBoundary = onBoundary ?? (async () => {});
	}

	async execute({
		runId,
		role,
		roleHash,
		promptPolicy,
		draft,
		completeness,
		generation,
		maxQuestions,
		criticFindings = [],
		phase = 'synthesis',
	}: RoleExecutorExecuteOptions) {
		const operationId = `${runId}:role:${roleHash.slice(0, 16)}:g${generation}`;
		const existing = this.runtimeStore.getModelOperation(operationId);
		if (existing?.status === 'succeeded' && existing.outputArtifact) {
			return Object.freeze({
				operationId,
				proposal: this.artifactStore.readJson(existing.outputArtifact),
				outputArtifact: existing.outputArtifact,
				synthetic: existing.synthetic,
				usageRecordIds: existing.usageRecordIds,
				replayed: true,
				effectiveStrategy: existing.effectiveStrategy,
				selectedQualityTier: existing.selectedQualityTier,
				counterfactualTier2CostMicrousd: existing.counterfactualTier2CostMicrousd,
			});
		}
		const capability = getCapability(role.capabilityId);
		const evaluator = getEvaluator(role.evaluatorId);
		assertAuthoritativeInputSafe(draft, 'Specification draft');
		const targetPaths = draft?.touchedSurfaces ?? (draft?.owningContext ? [draft.owningContext] : []);
		const scopeLearnings = await resolveScopeLearnings({
			rootDir: this.runtimeStore?.rootDir,
			targetPaths,
			roleId: role.roleId,
			roleKind: role.roleId,
			taskDescription: draft?.goal ?? '',
			modelProfile: role.modelProfile,
			requestedLimits: role.requestedLimits,
		});
		if (!capability.buildPrompt) {
			throw new SdlcError('INVALID_CONTRACT', `Capability '${role.capabilityId}' does not support buildPrompt`);
		}
		const prompt = capability.buildPrompt({
			promptPolicy,
			draft,
			completeness,
			maxQuestions,
			criticFindings,
			scopeLearnings,
		});
		assertAuthoritativeInputSafe(prompt, 'Governor prompt');
		const strategy = role.phaseStrategies?.[phase] ?? role.routingStrategy ?? 'balanced';
		const minQualityTier = role.phaseMinQualityTiers?.[phase] ?? role.minQualityTier ?? undefined;
		const request = {
			schemaVersion: '1.0.0',
			operationId,
			runId,
			consumer: 'agent-sdlc',
			profile: role.modelProfile,
			attribution: {
				taskId: sha256(runId).slice(0, 24),
				nodeId: 'run-configured-role',
				roleId: role.roleId,
				generation,
				nodeAttempt: 1,
				phase,
			},
			prompt,
			structuredOutputSchema: capability.structuredOutputSchema,
			routingConstraints: {
				requiredCapabilities: ['structured-output'],
				strategy,
				...(minQualityTier !== undefined ? { minQualityTier } : {}),
			},
			requestedLimits: role.requestedLimits,
		};
		this.runtimeStore.recordModelOperation({
			operationId,
			runId,
			synthetic: this.governor.synthetic === true,
			status: 'requested',
			taskId: request.attribution.taskId,
			roleId: role.roleId,
		});
		try {
			const result = await this.governor.execute(request);
			const outObj =
				result.output && typeof result.output === 'object'
					? (result.output as { patch?: unknown; questions?: unknown })
					: null;
			let allowEmptyQuestions =
				Boolean(criticFindings && criticFindings.length > 0) ||
				(completeness?.complete === true && (completeness?.missingFields?.length ?? 0) === 0);
			if (
				!allowEmptyQuestions &&
				Array.isArray(outObj?.patch) &&
				Array.isArray(outObj?.questions) &&
				outObj.questions.length === 0
			) {
				try {
					const revised = applyPatch(draft, outObj.patch);
					if (evaluateCompleteness(revised).complete) {
						allowEmptyQuestions = true;
					}
				} catch {
					// Fall through to strict evaluation
				}
			}
			const proposal = evaluator.evaluate(result.output, {
				maxQuestions,
				allowEmptyQuestions,
			});
			validateProposalCompatibility(draft, proposal);
			assertAuthoritativeInputSafe(proposal, 'Configured role proposal');
			const outputArtifact = this.artifactStore.writeJson('model-proposal', proposal);
			this.runtimeStore.recordModelOperation({
				operationId,
				runId,
				synthetic: result.synthetic === true,
				status: 'succeeded',
				outputArtifact,
				usageRecordIds: result.usageRecordIds,
				effectiveStrategy: result.effectiveStrategy ?? null,
				selectedQualityTier: result.selectedQualityTier ?? null,
				counterfactualTier2CostMicrousd: result.counterfactualTier2CostMicrousd ?? null,
				taskId: request.attribution.taskId,
				roleId: role.roleId,
				routeId: result.route?.routeId ?? null,
				provider: result.route?.provider ?? null,
				modelId: result.route?.model ?? null,
				physicalAttempts: result.attempts ?? 1,
				attemptedRoutes: result.attemptedRoutes ?? [],
			});
			await this.onBoundary('model-operation-result-recorded', {
				runId,
				operationId,
			});
			return Object.freeze({
				operationId,
				proposal,
				outputArtifact,
				synthetic: result.synthetic === true,
				usageRecordIds: result.usageRecordIds,
				replayed: result.replayed,
				authorVendor: result.route?.canonicalVendor ?? null,
				effectiveStrategy: result.effectiveStrategy,
				selectedQualityTier: result.selectedQualityTier,
				counterfactualTier2CostMicrousd: result.counterfactualTier2CostMicrousd,
			});
		} catch (error: unknown) {
			const errObj =
				error && typeof error === 'object'
					? (error as { code?: unknown; name?: unknown })
					: null;
			const errCode = typeof errObj?.code === 'string' ? errObj.code : null;
			const errName = typeof errObj?.name === 'string' ? errObj.name : null;
			this.runtimeStore.recordModelOperation({
				operationId,
				runId,
				synthetic: this.governor.synthetic === true,
				status: 'failed',
				errorCode: errCode ?? 'MODEL_OUTPUT_INVALID',
				taskId: request.attribution.taskId,
				roleId: role.roleId,
			});
			if (
				error instanceof SdlcError ||
				errName === 'SdlcError' ||
				(errCode !== null && errCode.startsWith('GOVERNOR_'))
			) {
				throw error;
			}
			throw new SdlcError(
				'MODEL_OUTPUT_INVALID',
				'Configured role output is invalid',
				{},
				{
					cause: error,
				},
			);
		}
	}
}
