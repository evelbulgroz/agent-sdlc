// Spec-draft nodes: completeness, the model request, role execution, and applying the patch.

import { createQuestionInterrupt } from '../../cli/hitl.ts';
import { RUNTIME_SCHEMA_VERSION, type RuntimeState, validateDraft } from '../../policy/contracts.ts';
import { canonicalizeAuthorVendor } from '../../review/author-vendor.ts';
import { latestPhaseReview } from '../../review/critic-budget.ts';
import {
	type AcceptanceCriteriaQuality,
	buildAcceptanceCriteriaGrammarQuestion,
	evaluateAcceptanceCriteriaQuality,
} from '../acceptance-criteria.ts';
import { type GraphStateValues, type WorkflowRuntimeLike, blockForGovernorError } from '../node-helpers.ts';
import {
	applyPatch,
	approvedInputHash,
	completenessHash,
	evaluateCompleteness,
} from '../specification.ts';

async function presentAcceptanceCriteriaGrammarQuestions(
	runtime: WorkflowRuntimeLike,
	snapshot: Readonly<RuntimeState>,
	draft: unknown,
	quality: AcceptanceCriteriaQuality,
): Promise<Readonly<RuntimeState>> {
	const loaded = runtime.registry.load();
	if (snapshot.interviewRound >= loaded.workflow.limits.maxInterviewRounds) {
		return runtime.transition(snapshot, {
			to: 'ESCALATED',
			eventType: 'RUN_BLOCKED',
			causalId: `ac-quality-limit-${snapshot.runtimeRevision}`,
			updates: {
				blockedReason: 'INTERVIEW_LIMIT_REACHED',
				lastError: {
					code: 'INTERVIEW_LIMIT_REACHED',
					message: 'Acceptance-criteria grammar interview limit reached',
				},
			},
			payload: { reason: 'INTERVIEW_LIMIT_REACHED', source: 'ac-quality' },
		});
	}
	const questionBatch = {
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		questions: [buildAcceptanceCriteriaGrammarQuestion(draft, quality)],
	};
	const request = createQuestionInterrupt({
		runId: snapshot.runId,
		runtimeRevision: snapshot.runtimeRevision + 1,
		draftHash: snapshot.draftHash ?? '',
		questionBatch,
	});
	const requestArtifact = runtime.artifactStore.writeJson('question-interrupt', request.payload);
	const next = runtime.transition(snapshot, {
		to: 'WAITING_FOR_ANSWERS',
		eventType: 'QUESTIONS_PRESENTED',
		causalId: request.interruptId,
		updates: {
			pendingInterruptId: request.interruptId,
			interviewRound: snapshot.interviewRound + 1,
			activeModelOperationId: null,
			activeProposalArtifact: null,
		},
		payload: {
			interruptId: request.interruptId,
			requestArtifact,
			source: 'ac-quality',
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
	return next;
}

export function createCheckCompletenessNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{
		snapshot: Readonly<RuntimeState>;
		humanResponse?: null;
	}> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced };
		const draft = runtime.artifactStore.readJson(snapshot.draftArtifact);
		const completeness = evaluateCompleteness(draft);
		let next = runtime.transition(snapshot, {
			to: 'SPEC_DRAFTING',
			eventType: 'COMPLETENESS_EVALUATED',
			causalId: `check-completeness-${snapshot.runtimeRevision}`,
			updates: {
				completeness,
				completenessHash: completenessHash(completeness),
				blockedReason: null,
				lastError: null,
			},
			payload: {
				draftArtifact: snapshot.draftArtifact,
				completenessHash: completenessHash(completeness),
			},
		});
		await runtime.onBoundary('completeness-transition-recorded', {
			runId: next.runId,
			runtimeRevision: next.runtimeRevision,
		});
		if (completeness.complete) {
			const quality = evaluateAcceptanceCriteriaQuality(draft);
			if (!quality.complete) {
				next = await presentAcceptanceCriteriaGrammarQuestions(runtime, next, draft, quality);
			}
		}
		return { snapshot: next, humanResponse: null };
	};
}

export function createPrepareModelRequestNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced };
		const loaded = runtime.registry.load();
		if (
			snapshot.interviewRound >= loaded.workflow.limits.maxInterviewRounds ||
			snapshot.modelOperations.length >= loaded.workflow.limits.maxModelOperations
		) {
			if (snapshot.completeness?.complete) {
				return {
					snapshot: runtime.transition(snapshot, {
						to: 'REVIEWING_SPEC',
						eventType: 'SPEC_CRITIC_COMPLETED',
						causalId: `spec-critic-bypass-${snapshot.runtimeRevision}`,
						updates: {
							specCriticRepairPending: false,
							activeModelOperationId: null,
						},
						payload: {
							phase: 'spec',
							reason: 'MODEL_OPERATIONS_EXHAUSTED',
						},
					}),
				};
			}
			return {
				snapshot: runtime.transition(snapshot, {
					to: 'ESCALATED',
					eventType: 'RUN_BLOCKED',
					causalId: `interview-limit-${snapshot.runtimeRevision}`,
					updates: {
						blockedReason: 'INTERVIEW_LIMIT_REACHED',
						lastError: {
							code: 'INTERVIEW_LIMIT_REACHED',
							message: 'Specification interview limit reached',
						},
					},
					payload: { reason: 'INTERVIEW_LIMIT_REACHED' },
				}),
			};
		}
		const generation = snapshot.interviewRound + 1;
		const operationId = `${snapshot.runId}:role:${loaded.hashes.roleHash.slice(0, 16)}:g${generation}`;
		const next = runtime.transition(snapshot, {
			to: 'SPEC_DRAFTING',
			eventType: 'MODEL_OPERATION_REQUESTED',
			causalId: operationId,
			updates: {
				modelOperations: [...snapshot.modelOperations, operationId],
				activeModelOperationId: operationId,
				activeProposalArtifact: null,
				interviewRound: generation,
			},
			payload: { operationId },
			effects: {
				recordModelOperation: {
					operationId,
					runId: snapshot.runId,
					synthetic: runtime.governor.synthetic === true,
					status: 'requested',
				},
			},
		});
		await runtime.onBoundary('model-request-transition-recorded', {
			runId: next.runId,
			runtimeRevision: next.runtimeRevision,
		});
		return { snapshot: next };
	};
}

export function createExecuteConfiguredRoleNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced };
		const loaded = runtime.registry.load();
		const draft = validateDraft(runtime.artifactStore.readJson(snapshot.draftArtifact));
		const lastSpecReview = latestPhaseReview(runtime.runtimeStore, snapshot.runId, 'spec') as {
			hasP1?: boolean;
			findingsJson?: string | null;
			reportArtifact?: string | null;
		} | null;
		const phase =
			snapshot.interviewRound > 0 && snapshot.completeness?.complete === false
				? 'interview'
				: 'synthesis';
		try {
			let criticFindings: unknown[] = [];
			if (snapshot.specCriticRepairPending === true && lastSpecReview?.hasP1) {
				if (lastSpecReview.findingsJson) {
					const parsed = JSON.parse(lastSpecReview.findingsJson) as Array<{
						severity?: string;
					}>;
					criticFindings = parsed.filter((f) => f.severity === 'P1');
				} else if (lastSpecReview.reportArtifact) {
					const report = runtime.artifactStore.readJson(
						lastSpecReview.reportArtifact,
					) as { findings?: Array<{ severity?: string }> };
					criticFindings = (report.findings ?? []).filter((f) => f.severity === 'P1');
				}
			}
			const result = await runtime.roleExecutor.execute({
				runId: snapshot.runId,
				role: loaded.role,
				roleHash: loaded.hashes.roleHash,
				promptPolicy: loaded.promptPolicy,
				draft,
				completeness: snapshot.completeness,
				generation: snapshot.interviewRound,
				maxQuestions: loaded.workflow.limits.maxQuestionsPerBatch,
				phase,
				criticFindings,
			});
			const resultRec = result as {
				operationId: string;
				outputArtifact: string;
				synthetic?: boolean;
				usageRecordIds?: readonly string[];
				authorVendor?: string | null;
			};
			let authorVendor: string | null = snapshot.authorVendor ?? null;
			if (!authorVendor) {
				try {
					authorVendor = canonicalizeAuthorVendor(
						resultRec.authorVendor ??
							(runtime.governor?.synthetic === true ? 'google' : null),
					);
				} catch {
					authorVendor = runtime.governor?.synthetic === true ? 'google' : null;
				}
			}
			const next = runtime.transition(snapshot, {
				to: 'SPEC_DRAFTING',
				eventType: 'MODEL_OPERATION_COMPLETED',
				causalId: resultRec.operationId,
				updates: {
					activeProposalArtifact: resultRec.outputArtifact,
					blockedReason: null,
					lastError: null,
					authorVendor,
					specCriticRepairPending: false,
				},
				payload: {
					operationId: resultRec.operationId,
					proposalArtifact: resultRec.outputArtifact,
					synthetic: resultRec.synthetic,
					usageRecordIds: resultRec.usageRecordIds,
				},
			});
			await runtime.onBoundary('model-completed-transition-recorded', {
				runId: next.runId,
				runtimeRevision: next.runtimeRevision,
			});
			return { snapshot: next };
		} catch (error: unknown) {
			const errRec =
				error && typeof error === 'object' ? (error as { code?: unknown }) : null;
			if (
				snapshot.specCriticRepairPending &&
				snapshot.completeness?.complete &&
				(errRec?.code === 'GOVERNOR_BUDGET_DENIED' || errRec?.code === 'BUDGET_EXHAUSTED')
			) {
				const next = runtime.transition(snapshot, {
					to: 'REVIEWING_SPEC',
					eventType: 'SPEC_CRITIC_COMPLETED',
					causalId: `spec-critic-repair-budget-${snapshot.runtimeRevision}`,
					updates: {
						specCriticRepairPending: false,
						activeModelOperationId: null,
					},
					payload: {
						phase: 'spec',
						reason: 'CRITIC_REPAIR_BUDGET_DENIED',
					},
				});
				await runtime.onBoundary('spec-critic-recorded', {
					runId: next.runId,
					runtimeRevision: next.runtimeRevision,
				});
				return { snapshot: next };
			}
			const blocked = blockForGovernorError(runtime, snapshot, error);
			await runtime.onBoundary('model-blocked-transition-recorded', {
				runId: blocked.runId,
				runtimeRevision: blocked.runtimeRevision,
			});
			return { snapshot: blocked };
		}
	};
}

function extractCriterionId(line: string): string | null {
	const match = line.match(/\b(AC-\d+)\b/);
	return match?.[1] ?? null;
}

function preserveBoundManifestAcceptanceIds(
	originalDraft: unknown,
	revisedDraft: Readonly<ReturnType<typeof applyPatch>>,
	hasTaskManifest: boolean,
): Readonly<ReturnType<typeof applyPatch>> {
	if (!hasTaskManifest || !originalDraft || typeof originalDraft !== 'object') {
		return revisedDraft;
	}
	const origAc = (originalDraft as { acceptanceCriteria?: unknown }).acceptanceCriteria;
	if (!Array.isArray(origAc) || origAc.length === 0) return revisedDraft;
	const origIds = origAc
		.filter((item): item is string => typeof item === 'string')
		.map(extractCriterionId)
		.filter((id): id is string => id !== null);
	if (origIds.length === 0) return revisedDraft;
	const origIdSet = new Set(origIds);
	const filtered = revisedDraft.acceptanceCriteria.filter((line) => {
		const id = extractCriterionId(line);
		return id !== null && origIdSet.has(id);
	});
	const filteredIds = filtered
		.map(extractCriterionId)
		.filter((id): id is string => id !== null);
	const sameIdSet =
		filteredIds.length === origIds.length &&
		new Set(filteredIds).size === origIdSet.size &&
		filteredIds.every((id) => origIdSet.has(id));
	if (!sameIdSet) {
		return validateDraft({
			...revisedDraft,
			acceptanceCriteria: origAc as string[],
		});
	}
	if (filtered.length === revisedDraft.acceptanceCriteria.length) {
		return revisedDraft;
	}
	return validateDraft({
		...revisedDraft,
		acceptanceCriteria: filtered,
	});
}

export function createApplyModelPatchNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced };
		const proposal = runtime.artifactStore.readJson(snapshot.activeProposalArtifact) as {
			patch: readonly unknown[];
		};
		if (proposal.patch.length === 0) return { snapshot };
		const draft = runtime.artifactStore.readJson(snapshot.draftArtifact);
		const revised = preserveBoundManifestAcceptanceIds(
			draft,
			applyPatch(draft, proposal.patch),
			Boolean(snapshot.taskManifestHash),
		);
		const draftArtifact = runtime.artifactStore.writeJson('specification-draft', revised);
		const next = runtime.transition(snapshot, {
			to: 'SPEC_DRAFTING',
			eventType: 'DRAFT_REVISED',
			causalId: `model-patch-${snapshot.activeModelOperationId ?? ''}`,
			updates: {
				draftArtifact,
				draftHash: approvedInputHash(revised, snapshot.taskManifestHash),
			},
			payload: { draftArtifact, source: 'model-proposal' },
		});
		await runtime.onBoundary('model-patch-transition-recorded', {
			runId: next.runId,
			runtimeRevision: next.runtimeRevision,
		});
		return { snapshot: next };
	};
}
