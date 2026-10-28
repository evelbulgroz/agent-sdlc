// Spec interview nodes: present questions, wait, and apply the operator answers.

import { interrupt } from '@langchain/langgraph';
import { createQuestionInterrupt, validatePendingResponse } from '../../cli/hitl.ts';
import {
	type QuestionItem,
	RUNTIME_SCHEMA_VERSION,
	type RuntimeState,
} from '../../policy/contracts.ts';
import { resolveReversibleDecisions } from '../../policy/reversible-decisions.ts';
import type { GraphStateValues, WorkflowRuntimeLike } from '../node-helpers.ts';
import { approvedInputHash } from '../specification.ts';

export function createPrepareQuestionsNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced };
		const loaded = runtime.registry.load();
		const proposal = runtime.artifactStore.readJson(snapshot.activeProposalArtifact) as {
			questions?: readonly QuestionItem[];
		};
		const draft = runtime.artifactStore.readJson(snapshot.draftArtifact);
		const resolved = resolveReversibleDecisions({
			draft,
			questions: Array.isArray(proposal.questions) ? proposal.questions : [],
		});
		let draftArtifact = snapshot.draftArtifact;
		let draftHash = snapshot.draftHash ?? '';
		if (resolved.autoDecisions.length > 0) {
			draftArtifact = runtime.artifactStore.writeJson(
				'specification-draft',
				resolved.updatedDraft,
			);
			draftHash = approvedInputHash(
				resolved.updatedDraft,
				snapshot.taskManifestHash,
			);
		}
		if (resolved.remainingQuestions.length === 0) {
			const next = runtime.transition(snapshot, {
				to: 'SPEC_DRAFTING',
				eventType: 'DRAFT_REVISED',
				causalId: `auto-decisions-${snapshot.runtimeRevision}`,
				updates: {
					draftArtifact,
					draftHash,
					activeProposalArtifact: null,
				},
				payload: {
					draftArtifact,
					source: 'reversible-decisions',
					autoDecisions: resolved.autoDecisions,
				},
			});
			await runtime.onBoundary('model-patch-transition-recorded', {
				runId: next.runId,
				runtimeRevision: next.runtimeRevision,
			});
			return { snapshot: next };
		}
		const questionBatch = {
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			questions: resolved.remainingQuestions.slice(
				0,
				loaded.workflow.limits.maxQuestionsPerBatch,
			),
		};
		const request = createQuestionInterrupt({
			runId: snapshot.runId,
			runtimeRevision: snapshot.runtimeRevision + 1,
			draftHash,
			questionBatch,
		});
		const requestArtifact = runtime.artifactStore.writeJson(
			'question-interrupt',
			request.payload,
		);
		const next = runtime.transition(snapshot, {
			to: 'WAITING_FOR_ANSWERS',
			eventType: 'QUESTIONS_PRESENTED',
			causalId: request.interruptId,
			updates: {
				pendingInterruptId: request.interruptId,
				draftArtifact,
				draftHash,
			},
			payload: {
				interruptId: request.interruptId,
				requestArtifact,
				autoDecisions: resolved.autoDecisions,
			},
			effects: {
				createInterrupt: {
					interruptId: request.interruptId,
					runId: snapshot.runId,
					kind: 'questions',
					stateHash: request.stateHash,
					requestArtifact,
					createdAt: runtime.now().toISOString(),
				},
			},
		});
		await runtime.onBoundary('questions-transition-recorded', {
			runId: next.runId,
			runtimeRevision: next.runtimeRevision,
		});
		return { snapshot: next };
	};
}

export function createAskQuestionsNode(runtime: WorkflowRuntimeLike) {
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

export function createApplyAnswersNode(runtime: WorkflowRuntimeLike) {
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
		const { revisedDraft: revised } = validatePendingResponse({
			state: snapshot,
			interrupt: pending,
			request,
			response: humanResponse,
			draft,
		});
		const draftArtifact = runtime.artifactStore.writeJson('specification-draft', revised);
		const next = runtime.transition(snapshot, {
			to: 'SPEC_DRAFTING',
			eventType: 'ANSWERS_ACCEPTED',
			causalId: pending.interruptId,
			updates: {
				draftArtifact,
				draftHash: approvedInputHash(revised, snapshot.taskManifestHash),
				pendingInterruptId: null,
				activeModelOperationId: null,
				activeProposalArtifact: null,
			},
			payload: {
				interruptId: pending.interruptId,
				draftArtifact,
			},
			effects: { resolveInterruptId: pending.interruptId },
		});
		await runtime.onBoundary('answers-transition-recorded', {
			runId: next.runId,
			runtimeRevision: next.runtimeRevision,
		});
		return { snapshot: next, humanResponse: null };
	};
}
