// Generation snapshot, reviewer, preflight verifier, and QA critic nodes.

import fs from 'node:fs';
import path from 'node:path';
import { formatPullRequestBody } from '../../adapters/github-pr.ts';
import { executeRolePipeline } from '../../execution/pipeline-executor.ts';
import { type RuntimeState, createEvent, sha256 } from '../../policy/contracts.ts';
import { runQaCritic } from '../../review/critic-gate.ts';
import { getEvaluator } from '../../review/evaluator-registry.ts';
import { executeReviewerWithRetry } from '../../review/review-execution.ts';
import {
	ReviewGenerationAdapter,
	materializeGenerationTree,
} from '../../review/review-generation.ts';
import { assessSemanticFindings } from '../../review/semantic-review-evidence.ts';
import { getCapability } from '../../roles/capability-registry.ts';
import {
	type GraphStateValues,
	type WorkflowRuntimeLike,
	blockForGovernorError,
	collectQaBriefAndAdvisories,
	deferUnavailableCritic,
	getAndValidateAuthorization,
	resolvePreflightWorktree,
} from '../node-helpers.ts';
import { executePreflightForSnapshot } from '../preflight-gate.ts';

async function applyQaP1({
	runtime,
	snapshot,
	criticResult,
}: {
	runtime: WorkflowRuntimeLike;
	snapshot: Readonly<RuntimeState>;
	criticResult: {
		findings?: readonly unknown[];
		artifactHash?: string | null;
		attemptKey?: string | null;
	};
}): Promise<{ snapshot: Readonly<RuntimeState> }> {
	const auth = getAndValidateAuthorization(runtime, snapshot);
	const findings = criticResult.findings ?? [];
	const worktreeDir = snapshot.integrationWorktreePath || snapshot.worktreePath || '';
	const semanticAdvisories = assessSemanticFindings({
		findings,
		worktreeDir,
		allowedPathPrefixes: auth.allowedPathPrefixes,
		source: 'qa-critic',
	});
	const advisorySnapshot = runtime.transition(snapshot, {
		to: snapshot.state,
		eventType: 'REVIEW_EVALUATED',
		causalId: `qa-p1-advisory-${snapshot.runtimeRevision}`,
		updates: {},
		payload: {
			source: 'qa-critic',
			findings,
			semanticAdvisories,
			repairAuthorized: false,
			artifactHash: criticResult.artifactHash,
			attemptKey: criticResult.attemptKey,
		},
	});
	await runtime.onBoundary('semantic-review-advisory-recorded', {
		runId: advisorySnapshot.runId,
		runtimeRevision: advisorySnapshot.runtimeRevision,
	});
	return advanceAfterGreenPreflight(runtime, advisorySnapshot);
}

export async function advanceAfterGreenPreflight(
	runtime: WorkflowRuntimeLike,
	snapshot: Readonly<RuntimeState>,
): Promise<{ snapshot: Readonly<RuntimeState> }> {
	const auth = getAndValidateAuthorization(runtime, snapshot);
	const worktreeDir = snapshot.integrationWorktreePath || snapshot.worktreePath || '';
	const binding = snapshot.preflightBindingArtifact
		? runtime.artifactStore.readJson(snapshot.preflightBindingArtifact)
		: null;
	let patchSummary = '';
	try {
		const rawDiff = runtime.gitCli('git', ['diff', '--stat', auth.baseCommitSha], {
			cwd: worktreeDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		patchSummary = (typeof rawDiff === 'string' ? rawDiff : rawDiff.toString('utf8')).trim();
	} catch {
		patchSummary = '';
	}
	const verificationEvidenceHash =
		(typeof binding?.preflightResultHash === 'string' && binding.preflightResultHash) ||
		sha256(binding ?? snapshot.preflightBindingArtifact);

	const { qaDivergences, coverageAdvisories, semanticReviewAdvisories } =
		collectQaBriefAndAdvisories(runtime, snapshot);

	if (auth.allowedOperations?.createLocalCommits) {
		const next = runtime.transition(snapshot, {
			to: 'COMMITTING_CHANGES',
			eventType: 'QA_CRITIC_COMPLETED',
			causalId: `qa-commit-${snapshot.runtimeRevision}`,
			updates: {},
			payload: {
				worktreePath: worktreeDir,
				baseCommitSha: auth.baseCommitSha,
				targetTreeSha: snapshot.targetTreeSha,
				preflightBindingArtifact: snapshot.preflightBindingArtifact,
				verificationEvidenceHash,
				patchSummary,
				qaDivergences,
				coverageAdvisories,
				semanticReviewAdvisories,
			},
		});
		await runtime.onBoundary('committing-changes-transition-recorded', {
			runId: next.runId,
			runtimeRevision: next.runtimeRevision,
		});
		return { snapshot: next };
	}

	let prBodyArtifact: string | null = null;
	try {
		const draft = runtime.artifactStore.readJson(snapshot.draftArtifact) as {
			goal?: string;
			owningContext?: string;
			assumptions?: readonly unknown[];
			touchedSurfaces?: readonly string[];
		};
		const prBody = formatPullRequestBody({
			spec: draft,
			decisions: draft?.assumptions ?? [],
			repairs: snapshot.semanticRepairsCount ?? 0,
			preflightEvidence: binding,
			touchedSurfaces: draft?.touchedSurfaces ?? [],
			allowedPackages: auth.allowedPackages ?? [],
			runId: snapshot.runId,
			branchName: auth.targetBranch,
			qaDivergences,
			coverageAdvisories,
			semanticReviewAdvisories,
		});
		prBodyArtifact = runtime.artifactStore.writeText('pr-body.md', prBody);
		try {
			fs.writeFileSync(
				path.join(runtime.artifactStore.artifactsDir, 'pr-body.md'),
				prBody,
				'utf8',
			);
		} catch {
			// Best-effort copy beside the hashed artifact.
		}
		runtime.runtimeStore.recordEvent(
			createEvent({
				runId: snapshot.runId,
				runtimeRevision: snapshot.runtimeRevision,
				eventType: 'PR_BODY_PREPARED',
				causalId: `pr-body-${snapshot.runtimeRevision}`,
				payload: { prBodyArtifact },
			}),
		);
	} catch {
		// Non-fatal if PR body formatting fails
	}

	const terminal = runtime.transition(snapshot, {
		to: 'READY_FOR_GIT_APPROVAL',
		eventType: 'RUN_READY_FOR_GIT_APPROVAL',
		causalId: `ready-git-${snapshot.runtimeRevision}`,
		updates: {},
		payload: {
			worktreePath: worktreeDir,
			baseCommitSha: auth.baseCommitSha,
			targetTreeSha: snapshot.targetTreeSha,
			preflightBindingArtifact: snapshot.preflightBindingArtifact,
			verificationEvidenceHash,
			patchSummary,
			prBodyArtifact,
			qaDivergences,
			coverageAdvisories,
			semanticReviewAdvisories,
		},
	});
	await runtime.onBoundary('ready-git-approval-transition-recorded', {
		runId: terminal.runId,
		runtimeRevision: terminal.runtimeRevision,
	});
	return { snapshot: terminal };
}

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
		let criticResult: {
			status: string;
			hasP1: boolean;
			findings: readonly unknown[];
			artifactHash: string | null | undefined;
			attemptKey: string | null;
		};
		try {
			criticResult = await runQaCritic({ runtime, snapshot });
		} catch (error: unknown) {
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
		if (
			(criticResult.status === 'SKIP' || criticResult.status === 'BUDGET_EXHAUSTED') &&
			criticResult.hasP1 === true &&
			(snapshot.semanticRepairsCount ?? 0) === 0
		) {
			return await applyQaP1({ runtime, snapshot, criticResult });
		}
		if (criticResult.status === 'BUDGET_EXHAUSTED' || criticResult.status === 'SKIP') {
			return advanceAfterGreenPreflight(runtime, snapshot);
		}
		if (criticResult.hasP1 === true) {
			return await applyQaP1({ runtime, snapshot, criticResult });
		}
		return advanceAfterGreenPreflight(runtime, snapshot);
	};
}
