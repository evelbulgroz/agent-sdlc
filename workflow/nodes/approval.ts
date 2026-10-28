// Spec approval nodes: spec critic, approval interrupt, and the approval answer.

import { interrupt } from '@langchain/langgraph';
import { createApprovalInterrupt, validatePendingResponse } from '../../cli/hitl.ts';
import type { RuntimeState } from '../../policy/contracts.ts';
import { SdlcError } from '../../policy/errors.ts';
import { resolveAuthorVendor } from '../../review/author-vendor.ts';
import { SPEC_CRITIC_CAP, latestPhaseReview } from '../../review/critic-budget.ts';
import { runSpecCritic } from '../../review/critic-gate.ts';
import type { SpecDocumentPackingInput } from '../../review/critic-input-packing.ts';
import { evaluateAcceptanceCriteriaQuality } from '../acceptance-criteria.ts';
import {
	type GraphStateValues,
	type WorkflowRuntimeLike,
	blockForGovernorError,
	deferUnavailableCritic,
} from '../node-helpers.ts';
import {
	approvedInputHash,
	createApprovalBinding,
} from '../specification.ts';

export function createExecuteSpecCriticNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced };
		if (snapshot.approvedSpecHash) {
			throw new SdlcError(
				'POLICY_VIOLATION',
				'Spec critic is forbidden after approvedSpecHash is frozen',
			);
		}
		let current = snapshot;
		const draft = runtime.artifactStore.readJson(current.draftArtifact) as SpecDocumentPackingInput & {
			goal?: string;
			acceptanceCriteria?: readonly string[];
		};
		const quality = evaluateAcceptanceCriteriaQuality(draft);
		if (!quality.complete) {
			throw new SdlcError(
				'POLICY_VIOLATION',
				'Spec critic requires unique AC-NN Given/Then acceptance criteria',
				{ errors: quality.errors },
			);
		}
		let criticResult: {
			status: string;
			hasP1: boolean;
			artifactHash: string | null | undefined;
			attemptKey: string | null;
		};
		try {
			criticResult = await runSpecCritic({
				runtime,
				snapshot: current,
				draft,
			});
		} catch (error: unknown) {
			const deferred = deferUnavailableCritic(runtime, current, 'spec', error);
			if (!deferred) {
				return { snapshot: blockForGovernorError(runtime, current, error) };
			}
			current = deferred;
			criticResult = {
				status: 'UNAVAILABLE',
				hasP1: false,
				artifactHash: current.draftHash,
				attemptKey: null,
			};
		}

		const hasP1 = criticResult.hasP1 === true;
		const existingSpecReviews = runtime.runtimeStore
			.listCriticReviews(current.runId)
			.filter((review) => review.phase === 'spec');
		const specCriticCount = existingSpecReviews.length;
		const loaded = runtime.registry.load();
		const canModelRepair =
			current.modelOperations.length < loaded.workflow.limits.maxModelOperations;
		const shouldAutoRepair = hasP1 && specCriticCount < SPEC_CRITIC_CAP && canModelRepair;

		const next = runtime.transition(current, {
			to: shouldAutoRepair ? 'SPEC_DRAFTING' : 'REVIEWING_SPEC',
			eventType: 'SPEC_CRITIC_COMPLETED',
			causalId: `spec-critic-ready-${current.runtimeRevision}`,
			updates: {
				specCriticRepairPending: shouldAutoRepair,
				...(current.authorVendor ? {} : { authorVendor: resolveAuthorVendor(current) }),
			},
			payload: {
				phase: 'spec',
				status: criticResult.status,
				hasP1,
				artifactHash: criticResult.artifactHash,
				attemptKey: criticResult.attemptKey,
			},
		});
		await runtime.onBoundary('spec-critic-recorded', {
			runId: next.runId,
			runtimeRevision: next.runtimeRevision,
		});
		return { snapshot: next };
	};
}

export function createPrepareApprovalNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced };
		if (snapshot.state !== 'REVIEWING_SPEC') {
			return { snapshot };
		}
		const approval = createApprovalBinding({
			runId: snapshot.runId,
			draftHash: snapshot.draftHash ?? '',
			runtimeRevision: snapshot.runtimeRevision + 1,
			workflowHash: snapshot.workflowHash,
			roleHash: snapshot.roleHash,
			promptPolicyHash: snapshot.promptPolicyHash,
			completenessResultHash: snapshot.completenessHash ?? '',
			timestamp: runtime.now().toISOString(),
		});
		const lastSpecReview = latestPhaseReview(runtime.runtimeStore, snapshot.runId, 'spec');
		const request = createApprovalInterrupt({
			runId: snapshot.runId,
			runtimeRevision: snapshot.runtimeRevision + 1,
			draftHash: snapshot.draftHash ?? '',
			approval,
			criticReport: lastSpecReview
				? {
						reviewId: lastSpecReview.reviewId,
						hasP1: lastSpecReview.hasP1,
						findingsCount: lastSpecReview.findingsCount,
						artifactHash: lastSpecReview.artifactHash,
						attemptKey: lastSpecReview.attemptKey,
						draftHashReviewed: lastSpecReview.artifactHash,
					}
				: null,
		});
		const requestArtifact = runtime.artifactStore.writeJson(
			'approval-interrupt',
			request.payload,
		);
		const next = runtime.transition(snapshot, {
			to: 'WAITING_FOR_APPROVAL',
			eventType: 'APPROVAL_REQUESTED',
			causalId: request.interruptId,
			updates: {
				pendingInterruptId: request.interruptId,
				activeModelOperationId: null,
				activeProposalArtifact: null,
			},
			payload: { interruptId: request.interruptId, requestArtifact },
			effects: {
				createInterrupt: {
					interruptId: request.interruptId,
					runId: snapshot.runId,
					kind: 'approval',
					stateHash: request.stateHash,
					requestArtifact,
					createdAt: runtime.now().toISOString(),
				},
			},
		});
		await runtime.onBoundary('approval-request-transition-recorded', {
			runId: next.runId,
			runtimeRevision: next.runtimeRevision,
		});
		return { snapshot: next };
	};
}

export function createAskApprovalNode(runtime: WorkflowRuntimeLike) {
	return ({
		snapshot,
	}: GraphStateValues): { snapshot: Readonly<RuntimeState>; humanResponse: unknown } => {
		if (!snapshot.pendingInterruptId) return { snapshot, humanResponse: null };
		const pending = runtime.runtimeStore.getInterrupt(snapshot.pendingInterruptId);
		if (!pending) return { snapshot, humanResponse: null };
		const request = runtime.artifactStore.readJson(pending.requestArtifact);
		const humanResponse: unknown = interrupt(request);
		return { snapshot, humanResponse };
	};
}

export function createApplyApprovalNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
		humanResponse,
	}: GraphStateValues): Promise<{
		snapshot: Readonly<RuntimeState>;
		humanResponse: null;
	}> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced, humanResponse: null };
		if (!snapshot.pendingInterruptId) return { snapshot, humanResponse: null };
		const pending = runtime.runtimeStore.getInterrupt(snapshot.pendingInterruptId);
		if (!pending) return { snapshot, humanResponse: null };
		const request = runtime.artifactStore.readJson(pending.requestArtifact);
		const draft = runtime.artifactStore.readJson(snapshot.draftArtifact);
		const { response: action, revisedDraft } = validatePendingResponse({
			state: snapshot,
			interrupt: pending,
			request,
			response: humanResponse,
			draft,
		});
		const actionRecord = action as { action?: string; approvalHash?: string | null };
		if (actionRecord.action === 'approve') {
			const quality = evaluateAcceptanceCriteriaQuality(draft);
			if (!quality.complete) {
				throw new SdlcError(
					'POLICY_VIOLATION',
					'Cannot approve a specification whose acceptance criteria fail AC-NN Given/Then grammar',
					{ errors: quality.errors },
				);
			}
			const approved = runtime.transition(snapshot, {
				to: 'SPEC_APPROVED',
				eventType: 'SPEC_APPROVED',
				causalId: pending.interruptId,
				updates: {
					pendingInterruptId: null,
					approvedSpecHash: snapshot.draftHash,
				},
				payload: {
					interruptId: pending.interruptId,
					approvedSpecHash: snapshot.draftHash,
					approvalHash: actionRecord.approvalHash,
				},
				effects: { resolveInterruptId: pending.interruptId },
			});
			await runtime.onBoundary('approval-transition-recorded', {
				runId: approved.runId,
				runtimeRevision: approved.runtimeRevision,
			});
			return {
				snapshot: approved,
				humanResponse: null,
			};
		}
		if (actionRecord.action === 'revise') {
			const draftArtifact = runtime.artifactStore.writeJson('specification-draft', revisedDraft);
			const revised = runtime.transition(snapshot, {
				to: 'SPEC_DRAFTING',
				eventType: 'DRAFT_REVISED',
				causalId: pending.interruptId,
				updates: {
					draftArtifact,
					draftHash: approvedInputHash(revisedDraft, snapshot.taskManifestHash),
					pendingInterruptId: null,
					approvedSpecHash: null,
					specApprovalAttempt: (snapshot.specApprovalAttempt ?? 0) + 1,
					specCriticRepairPending: false,
				},
				payload: { interruptId: pending.interruptId, draftArtifact },
				effects: { resolveInterruptId: pending.interruptId },
			});
			await runtime.onBoundary('approval-revision-transition-recorded', {
				runId: revised.runId,
				runtimeRevision: revised.runtimeRevision,
			});
			return {
				snapshot: revised,
				humanResponse: null,
			};
		}
		const rejected = actionRecord.action === 'reject';
		const terminal = runtime.transition(snapshot, {
			to: rejected ? 'SPEC_REJECTED' : 'CANCELLED',
			eventType: rejected ? 'SPEC_REJECTED' : 'RUN_CANCELLED',
			causalId: pending.interruptId,
			updates: {
				pendingInterruptId: null,
				blockedReason: rejected ? null : 'RUN_CANCELLED',
			},
			payload: { interruptId: pending.interruptId },
			effects: { resolveInterruptId: pending.interruptId },
		});
		await runtime.onBoundary('approval-terminal-transition-recorded', {
			runId: terminal.runId,
			runtimeRevision: terminal.runtimeRevision,
		});
		return {
			snapshot: terminal,
			humanResponse: null,
		};
	};
}
