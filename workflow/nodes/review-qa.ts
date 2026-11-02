// Generation snapshot, reviewer, preflight verifier, and QA critic nodes.

import { executeRolePipeline } from '../../execution/pipeline-executor.ts';
import { type RuntimeState, sha256 } from '../../policy/contracts.ts';
import { runQaCritic, type CriticGateResult } from '../../review/critic-gate.ts';
import { getEvaluator } from '../../review/evaluator-registry.ts';
import { executeReviewerWithRetry } from '../../review/review-execution.ts';
import {
	ReviewGenerationAdapter,
	materializeGenerationTree,
} from '../../review/review-generation.ts';
import { assessSemanticFindings } from '../../review/semantic-review-evidence.ts';
import { blockQualityCheckpoint } from '../quality-interrupt.ts';
import { getCapability } from '../../roles/capability-registry.ts';
import {
	type GraphStateValues,
	type WorkflowRuntimeLike,
	blockForGovernorError,
	deferUnavailableCritic,
	getAndValidateAuthorization,
	resolveCheckpointQualityContext,
	resolvePreflightWorktree,
} from '../node-helpers.ts';
import { executePreflightForSnapshot } from '../preflight-gate.ts';
import { advanceAfterGreenPreflight, applyLegacyQaP1 } from '../qa-delivery.ts';

export { advanceAfterGreenPreflight };

export function createSnapshotGenerationNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced };
		const auth = getAndValidateAuthorization(runtime, snapshot);
		const worktreeDir = resolvePreflightWorktree(snapshot);
		const genRecord = materializeGenerationTree({
			runId: snapshot.runId,
			worktreeDir,
			baseCommitSha: auth.baseCommitSha,
			allowedPackages: auth.allowedPackages,
			allowedPathPrefixes: auth.allowedPathPrefixes,
			generation: snapshot.activeGeneration ?? 0,
			runtimeStore: runtime.runtimeStore,
			gitCli: runtime.gitCli,
		});
		const next = runtime.transition(snapshot, {
			to: 'REVIEWING_GENERATION',
			eventType: 'GENERATION_MATERIALIZED',
			causalId: `snapshot-gen-${snapshot.activeGeneration ?? 0}-${snapshot.runtimeRevision}`,
			updates: {
				targetTreeSha: genRecord.targetTreeSha,
				worktreePath: worktreeDir,
			},
			payload: {
				generation: genRecord.generation,
				targetTreeSha: genRecord.targetTreeSha,
			},
		});
		await runtime.onBoundary('generation-materialized-transition-recorded', {
			runId: next.runId,
			runtimeRevision: next.runtimeRevision,
		});
		return { snapshot: next };
	};
}

export function createExecuteReviewerNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced };
		const auth = getAndValidateAuthorization(runtime, snapshot);
		const generation = snapshot.activeGeneration ?? 0;
		const draft = runtime.artifactStore.readJson(snapshot.draftArtifact) as {
			goal?: string;
			acceptanceCriteria?: readonly string[];
		};
		const reviewerWorktree = snapshot.integrationWorktreePath || snapshot.worktreePath || '';

		let diff = '';
		try {
			const rawDiff = runtime.gitCli(
				'git',
				['diff', auth.baseCommitSha, snapshot.targetTreeSha ?? ''],
				{
					cwd: reviewerWorktree,
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
				},
			);
			diff = typeof rawDiff === 'string' ? rawDiff : rawDiff.toString('utf8');
		} catch {
			diff = '';
		}

		// Pre-review pipeline (e.g. architect)
		const semanticAdvisories: unknown[] = [];
		const preReviewResult = await executeRolePipeline({
			insertionPoint: 'pre_review',
			runtime,
			snapshot,
			auth,
			generation,
			specSummary: draft.goal ?? '',
			acceptanceCriteria: draft.acceptanceCriteria ?? [],
			diff,
			touchedFiles: auth.allowedPathPrefixes,
			authorVendor: snapshot.authorVendor,
		});

		if (preReviewResult.status === 'FAIL') {
			semanticAdvisories.push(
				...assessSemanticFindings({
					findings: preReviewResult.findings,
					worktreeDir: reviewerWorktree,
					allowedPathPrefixes: auth.allowedPathPrefixes,
					source: 'architect',
				}),
			);
		}

		const operationId = `${snapshot.runId}:reviewer:g${generation}`;
		let evaluated: { status: string; findings: readonly unknown[] };
		try {
			const loaded = runtime.registry.loadRole('reviewer');
			const capability = getCapability(loaded.role.capabilityId);
			const evaluator = getEvaluator(loaded.role.evaluatorId);
			if (!capability.buildPrompt) {
				throw new Error(`Capability '${loaded.role.capabilityId}' missing buildPrompt`);
			}
			const request = {
				schemaVersion: '1.0.0',
				operationId,
				runId: snapshot.runId,
				consumer: 'agent-sdlc',
				profile: loaded.role.modelProfile,
				attribution: {
					taskId: sha256(snapshot.runId).slice(0, 24),
					nodeId: 'execute_reviewer',
					roleId: 'reviewer',
					generation,
					nodeAttempt: 1,
					phase: 'review',
				},
				prompt: capability.buildPrompt({
					promptPolicy: loaded.promptPolicy,
					specSummary: draft.goal ?? '',
					acceptanceCriteria: draft.acceptanceCriteria ?? [],
					touchedFiles: auth.allowedPathPrefixes,
					diff,
					maxPromptTokens: loaded.role.requestedLimits.maxPromptTokens,
				}),
				structuredOutputSchema: capability.structuredOutputSchema,
				routingConstraints: {
					requiredCapabilities: ['structured-output'],
				},
				requestedLimits: loaded.role.requestedLimits,
			};
			const review = await executeReviewerWithRetry({
				governor: runtime.governor,
				evaluator,
				runtimeStore: runtime.runtimeStore,
				artifactStore: runtime.artifactStore,
				request,
				runId: snapshot.runId,
				generation,
			});
			evaluated = review.evaluated;
			const reviewAdapter = new ReviewGenerationAdapter({
				runtimeStore: runtime.runtimeStore,
			});
			await reviewAdapter.recordReviewOutcome(
				snapshot.runId,
				generation,
				review.outputArtifact,
				evaluated,
			);
		} catch (error: unknown) {
			return {
				snapshot: blockForGovernorError(runtime, snapshot, error),
			};
		}

		const modelOps = runtime.runtimeStore.database
			.prepare('SELECT operation_id FROM model_operations WHERE run_id = ? ORDER BY operation_id')
			.all(snapshot.runId)
			.map((r) => String(r.operation_id ?? ''));

		if (evaluated.status === 'FAIL') {
			semanticAdvisories.push(
				...assessSemanticFindings({
					findings: evaluated.findings,
					worktreeDir: reviewerWorktree,
					allowedPathPrefixes: auth.allowedPathPrefixes,
					source: 'reviewer',
				}),
			);
		}

		// Review pipeline (e.g. critic-reviewer)
		const reviewPipelineResult = await executeRolePipeline({
			insertionPoint: 'review',
			runtime,
			snapshot,
			auth,
			generation,
			specSummary: draft.goal ?? '',
			acceptanceCriteria: draft.acceptanceCriteria ?? [],
			diff,
			touchedFiles: auth.allowedPathPrefixes,
			authorVendor: snapshot.authorVendor,
		});

		if (reviewPipelineResult.status === 'FAIL') {
			semanticAdvisories.push(
				...assessSemanticFindings({
					findings: reviewPipelineResult.findings,
					worktreeDir: reviewerWorktree,
					allowedPathPrefixes: auth.allowedPathPrefixes,
					source: 'review-critic',
				}),
			);
		}

		const next = runtime.transition(snapshot, {
			to: 'VERIFYING_PREFLIGHT',
			eventType: 'REVIEW_EVALUATED',
			causalId: `review-pass-${generation}-${snapshot.runtimeRevision}`,
			updates: {
				modelOperations: modelOps,
				activeModelOperationId: null,
			},
			payload: {
				status: semanticAdvisories.length > 0 ? 'ADVISORY' : 'PASS',
				findings: evaluated.findings,
				semanticAdvisories,
				repairAuthorized: false,
			},
		});
		await runtime.onBoundary('review-evaluated-transition-recorded', {
			runId: next.runId,
			runtimeRevision: next.runtimeRevision,
		});
		return { snapshot: next };
	};
}

export function createExecuteVerifierNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced };
		return executePreflightForSnapshot(runtime, snapshot);
	};
}

export function createExecuteQaCriticNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced };
		const checkpointContext = resolveCheckpointQualityContext(runtime, snapshot);
		if (checkpointContext) {
			const coverage = runtime.runtimeStore.listEvents(snapshot.runId).slice().reverse().find(event =>
				['AC_COVERAGE_FAILED', 'AC_COVERAGE_PASSED'].includes(event.eventType) &&
				event.payload.qualityCheckpointBindingHash === snapshot.qualityCheckpointBindingHash);
			if (coverage?.eventType === 'AC_COVERAGE_FAILED' ||
				(coverage && coverage.payload.coveragePass !== true) ||
				(snapshot.qualityCheckpointKind === 'final' && !coverage)) {
				return { snapshot: await blockQualityCheckpoint({
					runtime, snapshot, context: checkpointContext, status: 'COVERAGE_FAILED',
					reason: 'Bound acceptance coverage is missing or failed; QA admission is forbidden',
				}) };
			}
		}
		let criticResult: Readonly<CriticGateResult>;
		try {
			criticResult = await runQaCritic({
				runtime,
				snapshot,
				...(checkpointContext
					? {
							checkpointContext: {
								plan: checkpointContext.plan,
								policy: checkpointContext.policy,
								closure: checkpointContext.closure,
								worktreeDir: checkpointContext.worktreeDir,
							},
						}
					: {}),
			});
		} catch (error: unknown) {
			if (checkpointContext) {
				return {
					snapshot: await blockQualityCheckpoint({
						runtime,
						snapshot,
						context: checkpointContext,
						status: 'UNAVAILABLE',
						reason: error instanceof Error ? error.message : String(error),
					}),
				};
			}
			const deferred = deferUnavailableCritic(runtime, snapshot, 'qa', error);
			if (!deferred) {
				return { snapshot: blockForGovernorError(runtime, snapshot, error) };
			}
			await runtime.onBoundary('qa-critic-unavailable-recorded', {
				runId: deferred.runId,
				runtimeRevision: deferred.runtimeRevision,
			});
			return advanceAfterGreenPreflight(runtime, deferred);
		}
		await runtime.onBoundary('qa-critic-recorded', {
			runId: snapshot.runId,
			runtimeRevision: snapshot.runtimeRevision,
			status: criticResult.status,
			hasP1: criticResult.hasP1 === true,
		});
		if (checkpointContext) {
			return advanceAfterGreenPreflight(runtime, snapshot, criticResult);
		}
		if (
			(criticResult.status === 'SKIP' || criticResult.status === 'BUDGET_EXHAUSTED') &&
			criticResult.hasP1 === true &&
			(snapshot.semanticRepairsCount ?? 0) === 0
		) {
			return await applyLegacyQaP1({ runtime, snapshot, criticResult });
		}
		if (criticResult.status === 'BUDGET_EXHAUSTED' || criticResult.status === 'SKIP') {
			return advanceAfterGreenPreflight(runtime, snapshot);
		}
		if (criticResult.hasP1 === true) {
			return await applyLegacyQaP1({ runtime, snapshot, criticResult });
		}
		return advanceAfterGreenPreflight(runtime, snapshot);
	};
}
