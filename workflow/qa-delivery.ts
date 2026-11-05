import fs from 'node:fs';
import path from 'node:path';
import { formatPullRequestBody } from '../adapters/github-pr.ts';
import { type RuntimeState, createEvent, sha256 } from '../policy/contracts.ts';
import type { QualityAnswer } from '../policy/contracts/quality-schema.ts';
import { SdlcError } from '../policy/errors.ts';
import type { CriticGateResult } from '../review/critic-gate.ts';
import { qaCheckpointAttemptKey } from '../review/critic-budget.ts';
import { assessSemanticFindings } from '../review/semantic-review-evidence.ts';
import { assertQualityDeliveryAllowed } from './quality-delivery.ts';
import {
	type WorkflowRuntimeLike,
	collectQaBriefAndAdvisories,
	getAndValidateAuthorization,
	resolveCheckpointQualityContext,
} from './node-helpers.ts';
import { blockQualityCheckpoint } from './quality-interrupt.ts';

export async function advanceAfterGreenPreflight(
	runtime: WorkflowRuntimeLike,
	snapshot: Readonly<RuntimeState>,
	qaResult?: Readonly<CriticGateResult>,
	qualityRefutation?: { answer: QualityAnswer; request: Readonly<Record<string, unknown>> },
): Promise<{ snapshot: Readonly<RuntimeState> }> {
	let deliverySnapshot = snapshot;
	const qualityContext = resolveCheckpointQualityContext(runtime, snapshot, {
		allowAccepted: qualityRefutation !== undefined,
	});
	if (qualityContext) {
		const quality = runtime.runtimeStore.quality;
		const checkpointId = snapshot.qualityCheckpointId;
		if (!quality || !checkpointId) {
			throw new SdlcError('STORE_RECONCILIATION_FAILED', 'Bound quality checkpoint store is unavailable');
		}
		let attemptKey: string;
		if (qualityRefutation) {
			const { answer, request } = qualityRefutation;
			const findings = Array.isArray(request.findings)
				? request.findings as Array<{ findingId?: unknown }>
				: [];
			const findingIds = findings.map((finding) => finding.findingId)
				.filter((id): id is string => typeof id === 'string');
			const allowedActions = Array.isArray(request.allowedActions) ? request.allowedActions : [];
			if (
				snapshot.qualityCheckpointKind !== 'final' ||
				qualityContext.closure.status !== 'accepted' ||
				answer.action !== 'refute' ||
				request.status !== 'FAIL' ||
				!allowedActions.includes('refute') ||
				answer.bindingHash !== snapshot.qualityCheckpointBindingHash ||
				answer.findingIds.length === 0 ||
				answer.findingIds.length !== findingIds.length ||
				answer.findingIds.some((id) => !findingIds.includes(id)) ||
				answer.evidenceHashes.length === 0
			) {
				throw new SdlcError('POLICY_VIOLATION', 'Human refutation is not eligible to resume final delivery');
			}
			const treeSha = snapshot.qualityCheckpointTreeSha;
			if (!treeSha) throw new SdlcError('POLICY_VIOLATION', 'Final refutation is missing its candidate tree');
			attemptKey = qaCheckpointAttemptKey({
				approvedSpecHash: snapshot.approvedSpecHash ?? '',
				taskPlanHash: snapshot.taskPlanHash ?? '',
				checkpointKind: 'final',
				treeSha,
			});
			const qualityHumanRefutation = {
				attemptKey,
				bindingHash: snapshot.qualityCheckpointBindingHash,
				qualityPolicyHash: sha256(qualityContext.policy),
				answerHash: sha256(answer),
				findingIds: answer.findingIds,
				evidenceHashes: answer.evidenceHashes,
			};
			const recorded = runtime.runtimeStore.listEvents(snapshot.runId).some(event =>
				event.eventType === 'REVIEW_EVALUATED' &&
				event.payload.qualityCheckpointBindingHash === snapshot.qualityCheckpointBindingHash &&
				event.payload.qualityHumanRefutation != null &&
				sha256(event.payload.qualityHumanRefutation) === sha256(qualityHumanRefutation));
			if (!recorded) deliverySnapshot = runtime.transition(snapshot, {
				to: snapshot.state,
				eventType: 'REVIEW_EVALUATED',
				causalId: `quality-review-refuted-${answer.answerId}`,
				updates: {
					lastError: null,
				},
				payload: {
					phase: 'qa',
					status: 'HUMAN_REFUTED',
					qualityCheckpointId: snapshot.qualityCheckpointId,
					qualityCheckpointKind: snapshot.qualityCheckpointKind,
					qualityCheckpointBindingHash: snapshot.qualityCheckpointBindingHash,
					qualityCheckpointTreeSha: snapshot.qualityCheckpointTreeSha,
					qualityHumanRefutation,
				},
			});
			if (!recorded) await runtime.onBoundary('quality-human-refutation-recorded', {
				runId: deliverySnapshot.runId,
				runtimeRevision: deliverySnapshot.runtimeRevision,
			});
		} else {
		const exactStoredPass =
			qaResult?.status === 'SKIP' &&
			qaResult.hasP1 === false &&
			qaResult.review?.attemptKey === qaResult.attemptKey &&
			qaResult.review?.artifactHash === qaResult.artifactHash;
		if (!qaResult || (qaResult.status !== 'PASS' && !exactStoredPass) || qaResult.hasP1) {
			return {
				snapshot: await blockQualityCheckpoint({
					runtime,
					snapshot,
					context: qualityContext,
					status: qaResult?.status ?? 'INSUFFICIENT_EVIDENCE',
					reason: qaResult?.reason
						? `Current checkpoint has no exact completed passing adequacy review: ${qaResult.reason}`
						: 'Current checkpoint has no exact completed passing adequacy review',
					findings: qaResult?.findings ?? [],
				}),
			};
		}
			attemptKey = qaResult.attemptKey;
			deliverySnapshot = runtime.transition(snapshot, {
				to: snapshot.state,
				eventType: 'QA_CRITIC_COMPLETED',
				causalId: `qa-completed-${sha256(attemptKey).slice(0, 20)}`,
				updates: {},
				payload: {
					phase: 'qa',
					status: 'PASS',
					attemptKey,
					artifactHash: qaResult.artifactHash,
					qualityPolicyHash: sha256(qualityContext.policy),
					qualityCheckpointId: snapshot.qualityCheckpointId,
					qualityCheckpointKind: snapshot.qualityCheckpointKind,
					qualityCheckpointBindingHash: snapshot.qualityCheckpointBindingHash,
					qualityCheckpointTreeSha: snapshot.qualityCheckpointTreeSha,
					qualityRetrievalArtifacts: qaResult?.retrievalArtifacts ?? [],
				},
			});
			await runtime.onBoundary('quality-qa-completed-recorded', {
				runId: deliverySnapshot.runId,
				runtimeRevision: deliverySnapshot.runtimeRevision,
			});
		}
		if (qualityContext.correctionId) return { snapshot: deliverySnapshot };
		if (snapshot.qualityCheckpointKind === 'slice') {
			quality.setClosureStatus(
				snapshot.runId,
				checkpointId,
				qualityContext.closure.binding.candidateRevision,
				'accepted',
			);
			const continued = runtime.transition(deliverySnapshot, {
				to: 'EXECUTING_IMPLEMENTATION',
				eventType: 'REVIEW_EVALUATED',
				causalId: `quality-slice-accepted-${sha256(attemptKey).slice(0, 20)}`,
				updates: {},
				payload: {
					status: 'PASS',
					qualityCheckpointId: snapshot.qualityCheckpointId,
					qualityCheckpointSliceId: snapshot.qualityCheckpointSliceId,
					qualityCheckpointTreeSha: snapshot.qualityCheckpointTreeSha,
					qualityCheckpointBindingHash: snapshot.qualityCheckpointBindingHash,
					attemptKey,
					closureStatus: 'accepted',
				},
			});
			await runtime.onBoundary('quality-slice-accepted-recorded', {
				runId: continued.runId,
				runtimeRevision: continued.runtimeRevision,
			});
			return { snapshot: continued };
		}
		if (!qualityRefutation) {
			quality.setClosureStatus(
				snapshot.runId,
				checkpointId,
				qualityContext.closure.binding.candidateRevision,
				'accepted',
			);
		}
		assertQualityDeliveryAllowed(runtime, deliverySnapshot);
	}

	const auth = getAndValidateAuthorization(runtime, deliverySnapshot);
	const worktreeDir =
		deliverySnapshot.integrationWorktreePath || deliverySnapshot.worktreePath || '';
	const binding = deliverySnapshot.preflightBindingArtifact
		? runtime.artifactStore.readJson(deliverySnapshot.preflightBindingArtifact)
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
		sha256(binding ?? deliverySnapshot.preflightBindingArtifact);
	const { qaDivergences, coverageAdvisories, semanticReviewAdvisories } =
		collectQaBriefAndAdvisories(runtime, deliverySnapshot);

	if (auth.allowedOperations?.createLocalCommits) {
		const next = runtime.transition(deliverySnapshot, {
			to: 'COMMITTING_CHANGES',
			eventType: qualityContext ? 'REVIEW_EVALUATED' : 'QA_CRITIC_COMPLETED',
			causalId: `qa-commit-${deliverySnapshot.runtimeRevision}`,
			updates: { pendingInterruptId: null, blockedReason: null, lastError: null },
			payload: {
				...(qualityContext ? { status: 'PASS' } : {}),
				worktreePath: worktreeDir,
				baseCommitSha: auth.baseCommitSha,
				targetTreeSha: deliverySnapshot.targetTreeSha,
				preflightBindingArtifact: deliverySnapshot.preflightBindingArtifact,
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
		const draft = runtime.artifactStore.readJson(deliverySnapshot.draftArtifact) as {
			goal?: string;
			owningContext?: string;
			assumptions?: readonly unknown[];
			touchedSurfaces?: readonly string[];
		};
		const prBody = formatPullRequestBody({
			spec: draft,
			decisions: draft?.assumptions ?? [],
			repairs: deliverySnapshot.semanticRepairsCount ?? 0,
			preflightEvidence: binding,
			touchedSurfaces: draft?.touchedSurfaces ?? [],
			allowedPackages: auth.allowedPackages ?? [],
			runId: deliverySnapshot.runId,
			branchName: auth.targetBranch,
			qaDivergences,
			coverageAdvisories,
			semanticReviewAdvisories,
		});
		prBodyArtifact = runtime.artifactStore.writeText('pr-body.md', prBody);
		try {
			fs.writeFileSync(path.join(runtime.artifactStore.artifactsDir, 'pr-body.md'), prBody, 'utf8');
		} catch {
			// Best-effort copy beside the hashed artifact.
		}
		runtime.runtimeStore.recordEvent(
			createEvent({
				runId: deliverySnapshot.runId,
				runtimeRevision: deliverySnapshot.runtimeRevision,
				eventType: 'PR_BODY_PREPARED',
				causalId: `pr-body-${deliverySnapshot.runtimeRevision}`,
				payload: { prBodyArtifact },
			}),
		);
	} catch {
		// PR-body formatting does not determine delivery eligibility.
	}

	const terminal = runtime.transition(deliverySnapshot, {
		to: 'READY_FOR_GIT_APPROVAL',
		eventType: 'RUN_READY_FOR_GIT_APPROVAL',
		causalId: `ready-git-${deliverySnapshot.runtimeRevision}`,
		updates: { pendingInterruptId: null, blockedReason: null, lastError: null },
		payload: {
			worktreePath: worktreeDir,
			baseCommitSha: auth.baseCommitSha,
			targetTreeSha: deliverySnapshot.targetTreeSha,
			preflightBindingArtifact: deliverySnapshot.preflightBindingArtifact,
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

export async function resumeAfterQualityRefutation(
	runtime: WorkflowRuntimeLike,
	snapshot: Readonly<RuntimeState>,
	answer: QualityAnswer,
	request: Readonly<Record<string, unknown>>,
): Promise<{ snapshot: Readonly<RuntimeState> }> {
	if (answer.action !== 'refute') {
		throw new SdlcError('INVALID_INPUT', 'Only a human refutation can resume this final checkpoint');
	}
	return advanceAfterGreenPreflight(runtime, snapshot, undefined, { answer, request });
}

export async function applyLegacyQaP1({
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
	const worktreeDir = snapshot.integrationWorktreePath || snapshot.worktreePath || '';
	const semanticAdvisories = assessSemanticFindings({
		findings: criticResult.findings ?? [],
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
			findings: criticResult.findings ?? [],
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
