import type { ClosureRecord, EvidenceObligation, QualityPolicy } from '../policy/contracts/quality-schema.ts';
import type { TaskPlanV2Runtime } from '../policy/contracts/dag-schema.ts';
import { sha256 } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import type { CriticGateRuntimeLike, CriticGateSnapshot, CriticGateResult } from './critic-gate.ts';
import { resolveCodeAuthorVendors } from './author-vendor.ts';
import {
	assertCriticAllowed,
	findingsFromExistingReview,
	nextRound,
	qaCheckpointAttemptKey,
	type CriticReviewLike,
} from './critic-budget.ts';
import { CriticReviewAdapter } from './critic-review.ts';
import { packQualityEvidencePacket } from './quality-evidence-packing.ts';
import { makeQualityRetrievalRequest, retrieveQualitySource } from './quality-evidence-retrieval.ts';
import { governedQaDispatch, qaDispatchIntent, qaDispatchLimits, qaReplayAccounted,
	recoverAbandonedQaDispatches, settleUndispatchedQa } from './qa-resources.ts';
import { qaReviewScope } from './qa-slice-scope.ts';
import { checkpointQaDispatchSlot } from './qa-dispatch-slot.ts';

export interface QaCheckpointContext {
	plan: TaskPlanV2Runtime;
	policy: QualityPolicy;
	closure: ClosureRecord;
	worktreeDir: string;
}

function scopedObligations(
	plan: TaskPlanV2Runtime,
	closure: ClosureRecord,
): readonly EvidenceObligation[] {
	if (closure.binding.checkpointKind === 'final') return plan.evidenceObligations;
	const sliceId = closure.binding.ownerId;
	const taskIds = new Set(
		plan.tasks.filter((task) => task.sliceId === sliceId).map((task) => task.taskId),
	);
	return plan.evidenceObligations.filter((obligation) =>
		(obligation.owner.kind === 'slice' && obligation.owner.id === sliceId) ||
		(obligation.owner.kind === 'task' && taskIds.has(obligation.owner.id)),
	);
}

function existingResult(existing: CriticReviewLike, artifactHash: string, attemptKey: string): CriticGateResult {
	return Object.freeze({
		status: existing.attemptKey === attemptKey ? 'SKIP' : existing.hasP1 ? 'FAIL' : 'PASS',
		hasP1: existing.hasP1 === true,
		findings: Object.freeze(findingsFromExistingReview(existing)),
		review: existing,
		artifactHash,
		attemptKey,
	});
}

export async function runCheckpointQaCritic({
	runtime,
	snapshot,
	context,
}: {
	runtime: CriticGateRuntimeLike;
	snapshot: CriticGateSnapshot;
	context: QaCheckpointContext;
}): Promise<Readonly<CriticGateResult>> {
	const { closure, plan, policy, worktreeDir } = context;
	assertCriticAllowed({ phase: 'qa', snapshot, checkpointAware: true });
	const binding = closure.binding;
	const checkpointId = binding.checkpointId;
	const candidateRevision = binding.candidateRevision;
	const attemptKey = qaCheckpointAttemptKey({
		approvedSpecHash: binding.approvedSpecHash,
		taskPlanHash: binding.taskPlanHash,
		checkpointKind: binding.checkpointKind === 'final' ? 'final' : 'slice',
		sliceId: binding.checkpointKind === 'slice' ? binding.ownerId : null,
		treeSha: binding.treeSha,
	});
	const artifactHash = sha256({
		attemptKey,
		bindingHash: sha256(binding),
		qualityPolicyHash: binding.qualityPolicyHash,
		receiptHashes: closure.receiptHashes,
	});
	const quality = runtime.runtimeStore.quality;
	if (!quality) throw new SdlcError('STORE_RECONCILIATION_FAILED', 'Quality record store is unavailable');
	recoverAbandonedQaDispatches(runtime, snapshot.runId);
	const budget = quality.getBudget(snapshot.runId);
	if (!budget || budget.qualityPolicyHash !== binding.qualityPolicyHash) {
		throw new SdlcError('POLICY_VIOLATION', 'Checkpoint QA has no matching persisted review budget');
	}
	const { operationId, dispatchAttemptKey, reservation } = checkpointQaDispatchSlot({
		runId: snapshot.runId,
		checkpointId,
		candidateRevision,
		attemptKey,
	}, budget, runtime.runtimeStore.listCriticReviews(snapshot.runId));
	const round = nextRound({
		phase: 'qa', snapshot, artifactHash, attemptKey: dispatchAttemptKey,
		runtimeStore: runtime.runtimeStore, checkpointAware: true,
	});
	if (round.action === 'skip') {
		if (!reservation || reservation.status !== 'consumed' ||
			!qaReplayAccounted(runtime, snapshot.runId, policy, operationId, round.existing)) {
			return Object.freeze({
				status: 'BUDGET_EXHAUSTED',
				hasP1: false,
				findings: Object.freeze([]),
				review: null,
				artifactHash,
				attemptKey,
			});
		}
		const followUp = runtime.runtimeStore.listCriticReviews(snapshot.runId)
			.filter((review) => review.phase === 'qa' && review.attemptKey?.startsWith(`${dispatchAttemptKey}:follow-up:`))
			.at(-1);
		const followUpReservationId = followUp?.attemptKey?.slice(`${dispatchAttemptKey}:follow-up:`.length);
		if (followUp && (!followUpReservationId || !budget.reservations.some(entry =>
			entry.operationId === followUpReservationId && entry.kind === 'follow-up' &&
			entry.checkpointId === checkpointId && entry.candidateRevision === candidateRevision && entry.status === 'consumed') ||
			!qaReplayAccounted(runtime, snapshot.runId, policy, followUpReservationId, followUp))) {
			return Object.freeze({
				status: 'BUDGET_EXHAUSTED', hasP1: false, findings: Object.freeze([]),
				review: null, artifactHash, attemptKey,
			});
		}
		if (followUp) {
			return Object.freeze({
				status: followUp.hasP1 ? 'FAIL' : 'PASS',
				hasP1: followUp.hasP1 === true,
				findings: Object.freeze(findingsFromExistingReview(followUp)),
				review: followUp,
				artifactHash: followUp.artifactHash,
				attemptKey,
			});
		}
		return existingResult(round.existing, artifactHash, attemptKey);
	}
	if (round.action === 'budget_exhausted' || reservation) {
		return Object.freeze({
			status: 'BUDGET_EXHAUSTED',
			hasP1: false,
			findings: Object.freeze([]),
			review: round.action === 'budget_exhausted' ? round.last ?? null : null,
			artifactHash,
			attemptKey,
		});
	}
	const obligations = scopedObligations(plan, closure);
	const packet = packQualityEvidencePacket({
		worktreeDir,
		obligations,
		receipts: closure.receiptHashes.map((receiptHash) => ({
			receiptHash,
			completion: quality.getEvidenceCompletionByReceiptHash(snapshot.runId, receiptHash),
		})),
		policy,
	});
	if (packet.status !== 'complete') {
		return Object.freeze({
			status: 'INSUFFICIENT_EVIDENCE',
			hasP1: false,
			findings: Object.freeze([]),
			review: null,
			artifactHash,
			attemptKey,
		});
	}
	const requestedLimits = qaDispatchLimits(runtime, snapshot.runId, policy, operationId);
	if (!requestedLimits) {
		return Object.freeze({
			status: 'BUDGET_EXHAUSTED', hasP1: false, findings: Object.freeze([]),
			review: null, artifactHash, attemptKey,
		});
	}
	try {
		quality.reserveBudget(snapshot.runId, {
			operationId,
			kind: 'review',
			checkpointId,
			candidateRevision,
			status: 'reserved',
		}, qaDispatchIntent(snapshot.runId, dispatchAttemptKey,
			snapshot.activeGeneration ?? candidateRevision, requestedLimits));
	} catch (error: unknown) {
		if (error instanceof Error && /budget exhausted/i.test(error.message)) {
			return Object.freeze({
				status: 'BUDGET_EXHAUSTED',
				hasP1: false,
				findings: Object.freeze([]),
				review: null,
				artifactHash,
				attemptKey,
			});
		}
		throw error;
	}

	const draft = runtime.artifactStore.readJson(snapshot.draftArtifact);
	const loaded = runtime.registry.loadRole('critic-reviewer');
	const adapter = new CriticReviewAdapter({
		rootDir: runtime.registry.rootDir,
		governor: governedQaDispatch(runtime, snapshot.runId, operationId, requestedLimits, policy),
		runtimeStore: runtime.runtimeStore,
	});
	const scope = qaReviewScope(typeof draft.goal === 'string' ? draft.goal : '',
		closure.binding.checkpointKind, obligations);
	let result;
	try {
		result = await adapter.executeReview({
			runId: snapshot.runId,
			generation: snapshot.activeGeneration ?? candidateRevision,
			phase: 'qa',
			scope: dispatchAttemptKey,
			authorVendors: resolveCodeAuthorVendors(snapshot, runtime.runtimeStore, {
				synthetic: runtime.governor?.synthetic === true,
			}),
			promptPolicy: loaded.promptPolicy,
			specSummary: scope.specSummary,
			acceptanceCriteria: scope.acceptanceCriteria,
			touchedFiles: [],
			testOutput: packet.text,
			requireUntruncatedInput: true,
			artifactHash,
			attemptKey: dispatchAttemptKey,
			groundingRootDir: worktreeDir,
			requestedLimits,
		});
	} catch (error: unknown) {
		settleUndispatchedQa(runtime, snapshot.runId, operationId, 'interrupted');
		throw error;
	}
	if (result.hasP1 && policy.followUpDispatches > 0) {
		const request = makeQualityRetrievalRequest({
			findings: result.findings,
			obligations,
			bindingHash: sha256(binding),
			reviewOperationId: operationId,
		});
		if (request) {
			const followUpLimits = qaDispatchLimits(runtime, snapshot.runId, policy, request.operationId);
			if (!followUpLimits) return Object.freeze({
				status: 'FAIL', hasP1: true, findings: result.findings, review: result, artifactHash, attemptKey,
			});
			try {
				quality.reserveBudget(snapshot.runId, {
					operationId: request.operationId,
					kind: 'follow-up',
					checkpointId,
					candidateRevision,
					status: 'reserved',
				}, qaDispatchIntent(snapshot.runId, `${dispatchAttemptKey}:follow-up:${request.operationId}`,
					snapshot.activeGeneration ?? candidateRevision, followUpLimits));
			} catch (error: unknown) {
				if (!(error instanceof Error) || !/budget exhausted/i.test(error.message)) throw error;
				return Object.freeze({
					status: 'FAIL', hasP1: true, findings: result.findings, review: result,
					artifactHash, attemptKey,
				});
			}
			const writeJson = runtime.artifactStore.writeJson;
			if (!writeJson) {
				settleUndispatchedQa(runtime, snapshot.runId, request.operationId, 'interrupted');
				throw new SdlcError('STORE_RECONCILIATION_FAILED', 'QA retrieval requires artifact persistence');
			}
			let requestArtifact: string;
			let responseArtifact: string;
			let retrieval: ReturnType<typeof retrieveQualitySource>;
			try {
				requestArtifact = writeJson.call(runtime.artifactStore, 'qa-follow-up-request', request);
				retrieval = retrieveQualitySource({
					worktreeDir,
					request,
					policy,
					alreadyRetrievedBytes: packet.byteCount,
					alreadyRetrievedLines: packet.lineCount,
				});
				responseArtifact = writeJson.call(runtime.artifactStore, 'qa-follow-up-response', retrieval.response);
			} catch (error: unknown) {
				settleUndispatchedQa(runtime, snapshot.runId, request.operationId, 'interrupted');
				throw error;
			}
			const retrievalArtifacts = Object.freeze([{ requestArtifact, responseArtifact }]);
			if (retrieval.response.outcome !== 'complete') {
				settleUndispatchedQa(runtime, snapshot.runId, request.operationId, 'consumed');
				return Object.freeze({
					status: 'FAIL', hasP1: true, findings: result.findings, review: result,
					artifactHash, attemptKey, retrievalArtifacts,
				});
			}
			const followUpAttemptKey = `${dispatchAttemptKey}:follow-up:${request.operationId}`;
			const followUpArtifactHash = sha256({
				originalArtifactHash: artifactHash,
				requestHash: sha256(request),
				responseHash: sha256(retrieval.response),
			});
			let followUpResult;
			try {
				const followUpAdapter = new CriticReviewAdapter({
					rootDir: runtime.registry.rootDir,
					governor: governedQaDispatch(runtime, snapshot.runId, request.operationId, followUpLimits, policy),
					runtimeStore: runtime.runtimeStore,
				});
				followUpResult = await followUpAdapter.executeReview({
					runId: snapshot.runId,
					generation: snapshot.activeGeneration ?? candidateRevision,
					phase: 'qa',
					scope: followUpAttemptKey,
					authorVendors: resolveCodeAuthorVendors(snapshot, runtime.runtimeStore, {
						synthetic: runtime.governor?.synthetic === true,
					}),
					promptPolicy: loaded.promptPolicy,
					specSummary: typeof draft.goal === 'string' ? draft.goal : '',
					acceptanceCriteria: obligations.map((obligation) => obligation.criterionId),
					touchedFiles: [],
					testOutput: `${packet.text}\nFollow-up retrieval: ${JSON.stringify(retrieval.response)}`,
					requireUntruncatedInput: true,
					artifactHash: followUpArtifactHash,
					attemptKey: followUpAttemptKey,
					groundingRootDir: worktreeDir,
					requestedLimits: followUpLimits,
				});
			} catch (error: unknown) {
				settleUndispatchedQa(runtime, snapshot.runId, request.operationId, 'interrupted');
				throw error;
			}
			return Object.freeze({
				status: followUpResult.hasP1 ? 'FAIL' : 'PASS',
				hasP1: followUpResult.hasP1,
				findings: followUpResult.findings,
				review: followUpResult,
				artifactHash: followUpArtifactHash,
				attemptKey,
				retrievalArtifacts,
			});
		}
	}
	return Object.freeze({
		status: result.hasP1 ? 'FAIL' : 'PASS',
		hasP1: result.hasP1,
		findings: result.findings,
		review: result,
		artifactHash,
		attemptKey,
	});
}
