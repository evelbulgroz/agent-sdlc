import type { ModelOperationInput } from '../persistence/model-operation-records.ts';
import { SdlcError } from '../policy/errors.ts';

const REVIEW_OUTPUT_RETRY_LIMIT = 1;

export interface ReviewerGovernorLike {
	synthetic?: boolean;
	execute(request: Record<string, unknown>): Promise<{
		output?: unknown;
		synthetic?: boolean;
		usageRecordIds?: readonly string[];
		route?: {
			routeId?: string | null;
			provider?: string | null;
			model?: string | null;
		} | null;
		attempts?: number;
		attemptedRoutes?: readonly unknown[];
	}>;
}

export interface ReviewerEvaluatorLike<TEvaluated = Record<string, unknown>> {
	evaluate(
		value: unknown,
		options?: { runId?: string; generation?: number },
	): TEvaluated;
}

export interface ReviewerRuntimeStoreLike {
	getModelOperation(operationId: string): {
		status?: string;
		outputArtifact?: string | null;
		errorCode?: string | null;
	} | null;
	recordModelOperation(record: ModelOperationInput): unknown;
}

export interface ReviewerArtifactStoreLike {
	readJson(artifactRef: string): unknown;
	writeJson(prefix: string, payload: unknown): string;
}

export interface ReviewerRequestLike {
	operationId: string;
	prompt: string;
	attribution: {
		taskId?: string;
		roleId?: string;
		nodeAttempt?: number;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

function isReviewOutputError(error: unknown): boolean {
	if (!error || typeof error !== 'object' || !('code' in error)) return false;
	return typeof error.code === 'string' && ['INVALID_CONTRACT', 'MODEL_OUTPUT_INVALID'].includes(error.code);
}

function retryPrompt(prompt: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error ?? '');
	return [
		prompt,
		'',
		'## Contract correction',
		`The prior review output was rejected: ${message}`,
		'Return P1 only for a concrete defect that requires a code or test change.',
		'Do not emit findings that praise compliant behavior or recommend retaining it.',
		'Every claimed defect must be directly supported by cited evidence; do not infer missing state wiring when the cited excerpt shows it.',
	].join('\n');
}

export async function executeReviewerWithRetry<TEvaluated = Record<string, unknown>>({
	governor,
	evaluator,
	runtimeStore,
	artifactStore,
	request,
	runId,
	generation,
}: {
	governor: ReviewerGovernorLike;
	evaluator: ReviewerEvaluatorLike<TEvaluated>;
	runtimeStore: ReviewerRuntimeStoreLike;
	artifactStore: ReviewerArtifactStoreLike;
	request: ReviewerRequestLike;
	runId: string;
	generation: number;
}): Promise<{ evaluated: TEvaluated; outputArtifact: string }> {
	let previousError: unknown = null;
	for (let attempt = 0; attempt <= REVIEW_OUTPUT_RETRY_LIMIT; attempt += 1) {
		const operationId =
			attempt === 0
				? request.operationId
				: `${request.operationId}:contract-retry-${attempt}`;
		const existing = runtimeStore.getModelOperation(operationId);
		if (existing?.status === 'succeeded' && existing.outputArtifact) {
			const cached: unknown = artifactStore.readJson(existing.outputArtifact);
			return {
				evaluated: cached as TEvaluated,
				outputArtifact: existing.outputArtifact,
			};
		}
		if (existing?.status === 'failed') {
			const existingError = new SdlcError(
				existing.errorCode ?? 'ROLE_EXECUTION_FAILED',
				'Reviewer operation previously failed output validation',
			);
			if (isReviewOutputError(existingError) && attempt < REVIEW_OUTPUT_RETRY_LIMIT) {
				previousError = existingError;
				continue;
			}
			throw existingError;
		}
		const attemptRequest = {
			...request,
			operationId,
			attribution: {
				...request.attribution,
				nodeAttempt: attempt + 1,
			},
			prompt:
				attempt === 0
					? request.prompt
					: retryPrompt(request.prompt, previousError),
		};
		runtimeStore.recordModelOperation({
			operationId,
			runId,
			synthetic: governor.synthetic === true,
			status: 'requested',
			taskId: request.attribution.taskId,
			roleId: request.attribution.roleId,
		});
		try {
			const result = await governor.execute(attemptRequest);
			const evaluated = evaluator.evaluate(result.output, {
				runId,
				generation,
			});
			const outputArtifact = artifactStore.writeJson(
				'review-findings',
				evaluated,
			);
			runtimeStore.recordModelOperation({
				operationId,
				runId,
				synthetic: result.synthetic === true,
				status: 'succeeded',
				outputArtifact,
				usageRecordIds: result.usageRecordIds,
				taskId: request.attribution.taskId,
				roleId: request.attribution.roleId,
				routeId: result.route?.routeId ?? null,
				provider: result.route?.provider ?? null,
				modelId: result.route?.model ?? null,
				physicalAttempts: result.attempts ?? 1,
				attemptedRoutes: result.attemptedRoutes ?? [],
			});
			return { evaluated, outputArtifact };
		} catch (error: unknown) {
			const errorCode =
				error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
					? error.code
					: 'MODEL_OUTPUT_INVALID';
			runtimeStore.recordModelOperation({
				operationId,
				runId,
				synthetic: governor.synthetic === true,
				status: 'failed',
				errorCode,
				taskId: request.attribution.taskId,
				roleId: request.attribution.roleId,
			});
			if (!isReviewOutputError(error) || attempt === REVIEW_OUTPUT_RETRY_LIMIT) {
				throw error;
			}
			previousError = error;
		}
	}
	throw new SdlcError(
		'MODEL_OUTPUT_INVALID',
		'Reviewer output retry exhausted',
	);
}
