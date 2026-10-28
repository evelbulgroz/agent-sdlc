import { assertAuthoritativeInputSafe } from '../persistence/artifacts.ts';
import { validateAuthorizationEnvelope } from '../policy/authorization.ts';
import {
	type AnswerDocument,
	type ApprovalResponse,
	type QuestionBatch,
	RUNTIME_SCHEMA_VERSION,
	type RunAuthorizationRecord,
	type SpecDraft,
	sha256,
	validateAnswerDocument,
	validateApprovalResponse,
	validateQuestionBatch,
} from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { applyAnswers, applyPatch } from '../workflow/specification.ts';

export interface InterruptEnvelope<TPayload extends Record<string, unknown>> {
	readonly interruptId: string;
	readonly stateHash: string;
	readonly payload: Readonly<TPayload>;
}

export function createQuestionInterrupt({
	runId, runtimeRevision, draftHash, questionBatch,
}: {
	runId: string; runtimeRevision: number; draftHash: string; questionBatch: unknown;
}) {
	const batch = validateQuestionBatch(questionBatch);
	const stateHash = sha256({ runId, runtimeRevision, draftHash, kind: 'questions' });
	const payload = Object.freeze({
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		kind: 'questions' as const,
		stateHash,
		questions: batch.questions,
		expectedResponse: {
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			interruptId: '<pending-interrupt-id>',
			stateHash,
			answers: [{ questionId: '<question-id>', value: '<matching-response-kind>' }],
		},
	});
	const interruptId = sha256({ runId, kind: 'questions', runtimeRevision, payload }).slice(0, 48);
	return Object.freeze({
		interruptId, stateHash,
		payload: Object.freeze({ ...payload, expectedResponse: { ...payload.expectedResponse, interruptId } }),
	});
}

export function createApprovalInterrupt({
	runId, runtimeRevision, draftHash, approval, criticReport = null,
}: {
	runId: string; runtimeRevision: number; draftHash: string;
	approval: { approvalHash: string } & Record<string, unknown>; criticReport?: unknown;
}) {
	const stateHash = sha256({ runId, runtimeRevision, draftHash, approval, criticReport, kind: 'approval' });
	const payload = Object.freeze({
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		kind: 'approval' as const,
		stateHash, draftHash, approval, criticReport,
		actions: ['approve', 'revise', 'reject', 'cancel'],
		expectedResponse: {
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			interruptId: '<pending-interrupt-id>',
			stateHash,
			action: 'approve|revise|reject|cancel',
			approvalHash: approval.approvalHash,
			draftHash,
			changes: [],
		},
	});
	const interruptId = sha256({ runId, kind: 'approval', runtimeRevision, payload }).slice(0, 48);
	return Object.freeze({
		interruptId, stateHash,
		payload: Object.freeze({ ...payload, expectedResponse: { ...payload.expectedResponse, interruptId } }),
	});
}

export function createAuthorizationInterrupt({
	runId,
	runtimeRevision,
	approvedSpecHash,
	baseCommitSha,
	candidateEnvelope,
}: {
	runId: string;
	runtimeRevision: number;
	approvedSpecHash: string | null | undefined;
	baseCommitSha: string;
	candidateEnvelope?: unknown;
}) {
	const stateHash = sha256({
		runId,
		runtimeRevision,
		approvedSpecHash,
		baseCommitSha,
		kind: 'authorization',
	});
	const payload = Object.freeze({
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		kind: 'authorization' as const,
		stateHash,
		approvedSpecHash,
		baseCommitSha,
		candidateEnvelope,
		expectedResponse: {
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			interruptId: '<pending-interrupt-id>',
			stateHash,
			envelope: candidateEnvelope,
		},
	});
	const interruptId = sha256({
		runId,
		kind: 'authorization',
		runtimeRevision,
		payload,
	}).slice(0, 48);
	return Object.freeze({
		interruptId,
		stateHash,
		payload: Object.freeze({
			...payload,
			expectedResponse: { ...payload.expectedResponse, interruptId },
		}),
	});
}

export function createPlanCriticInterrupt({
	runId,
	runtimeRevision,
	taskPlanHash,
	approvedPlanPolicyHash,
	criticReport,
}: {
	runId: string;
	runtimeRevision: number;
	taskPlanHash: string | null | undefined;
	approvedPlanPolicyHash: string | null | undefined;
	criticReport: unknown;
}) {
	const stateHash = sha256({
		runId,
		runtimeRevision,
		taskPlanHash,
		approvedPlanPolicyHash,
		criticReport,
		kind: 'plan_critic',
	});
	const payload = Object.freeze({
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		kind: 'plan_critic' as const,
		stateHash,
		taskPlanHash,
		approvedPlanPolicyHash,
		criticReport,
		actions: ['accept_residual', 'reauthorize', 'cancel'],
		expectedResponse: {
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			interruptId: '<pending-interrupt-id>',
			stateHash,
			action: 'accept_residual|reauthorize|cancel',
		},
	});
	const interruptId = sha256({
		runId,
		kind: 'plan_critic',
		runtimeRevision,
		payload,
	}).slice(0, 48);
	return Object.freeze({
		interruptId,
		stateHash,
		payload: Object.freeze({
			...payload,
			expectedResponse: { ...payload.expectedResponse, interruptId },
		}),
	});
}

export function createReconciliationConflictInterrupt({
	runId,
	runtimeRevision,
	failingTaskId,
	conflictDetails,
}: {
	runId: string;
	runtimeRevision: number;
	failingTaskId: string;
	conflictDetails: unknown;
}) {
	const stateHash = sha256({
		runId,
		runtimeRevision,
		failingTaskId,
		conflictDetails,
		kind: 'reconciliation_conflict',
	});
	const payload = Object.freeze({
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		kind: 'reconciliation_conflict' as const,
		stateHash,
		failingTaskId,
		conflictDetails,
		actions: ['escalate', 'cancel'],
		defaultAction: 'escalate',
		expectedResponse: {
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			interruptId: '<pending-interrupt-id>',
			stateHash,
			action: 'escalate|cancel',
		},
	});
	const interruptId = sha256({
		runId,
		kind: 'reconciliation_conflict',
		runtimeRevision,
		payload,
	}).slice(0, 48);
	return Object.freeze({
		interruptId,
		stateHash,
		payload: Object.freeze({
			...payload,
			expectedResponse: { ...payload.expectedResponse, interruptId },
		}),
	});
}

export function createHighRiskReviewInterrupt({
	runId,
	runtimeRevision,
	taskPlanHash,
	tasks,
}: {
	runId: string;
	runtimeRevision: number;
	taskPlanHash: string | null | undefined;
	tasks: readonly {
		taskId: string;
		sliceId?: string | null;
		targetTreeSha?: string | null;
		pathPrefixes?: readonly string[];
	}[];
}) {
	const reviewTasks = tasks.map((task) => ({
		taskId: task.taskId,
		sliceId: task.sliceId ?? null,
		targetTreeSha: task.targetTreeSha,
		pathPrefixes: task.pathPrefixes,
	}));
	const stateHash = sha256({
		runId,
		runtimeRevision,
		taskPlanHash,
		tasks: reviewTasks,
		kind: 'high_risk_review',
	});
	const payload = Object.freeze({
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		kind: 'high_risk_review' as const,
		stateHash,
		taskPlanHash,
		tasks: reviewTasks,
		actions: ['approve', 'cancel'],
		defaultAction: 'cancel',
		expectedResponse: {
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			interruptId: '<pending-interrupt-id>',
			stateHash,
			taskPlanHash,
			action: 'approve|cancel',
		},
	});
	const interruptId = sha256({
		runId,
		kind: 'high_risk_review',
		runtimeRevision,
		payload,
	}).slice(0, 48);
	return Object.freeze({
		interruptId,
		stateHash,
		payload: Object.freeze({
			...payload,
			expectedResponse: { ...payload.expectedResponse, interruptId },
		}),
	});
}

export interface InterruptRef {
	interruptId: string;
	stateHash: string;
	kind?: string;
}

export function validateQuestionResponse(
	response: unknown,
	interrupt: InterruptRef,
	questionBatch: Readonly<QuestionBatch>,
): Readonly<AnswerDocument> {
	const answer = validateAnswerDocument(response, questionBatch);
	assertCurrentResponse(answer, interrupt);
	return answer;
}

export function validateApprovalAction(
	response: unknown,
	interrupt: InterruptRef,
): Readonly<ApprovalResponse> {
	const action = validateApprovalResponse(response);
	assertCurrentResponse(action, interrupt);
	return action;
}

export function validateAuthorizationAction(
	response: unknown,
	interrupt: InterruptRef,
	request: { baseCommitSha?: string; approvedSpecHash?: string },
): RunAuthorizationRecord {
	assertCurrentResponse(response, interrupt);
	const rec = response && typeof response === 'object' ? (response as { envelope?: unknown }) : {};
	const envelopeInput = rec.envelope ?? response;
	return validateAuthorizationEnvelope(envelopeInput, {
		currentBaseCommitSha: request.baseCommitSha,
		currentSpecHash: request.approvedSpecHash,
	});
}

export function validatePendingResponse({
	state,
	interrupt,
	request,
	response,
	draft,
}: {
	state: { taskPlanHash?: string | null; draftHash?: string | null };
	interrupt: InterruptRef;
	request: Record<string, unknown>;
	response: unknown;
	draft?: unknown;
}): Readonly<{
	response: Record<string, unknown>;
	revisedDraft: Readonly<SpecDraft> | null;
	envelope?: RunAuthorizationRecord;
}> {
	const respRec =
		response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
	if (interrupt.kind === 'questions') {
		const questionBatch = validateQuestionBatch({
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			questions: request.questions,
		});
		const answer = validateQuestionResponse(response, interrupt, questionBatch);
		const revisedDraft = applyAnswers(draft, questionBatch, answer);
		assertAuthoritativeInputSafe(revisedDraft, 'Human-revised specification draft');
		return Object.freeze({ response: answer, revisedDraft });
	}
	if (interrupt.kind === 'authorization') {
		const validatedAuth = validateAuthorizationAction(response, interrupt, {
			baseCommitSha:
				typeof request.baseCommitSha === 'string' ? request.baseCommitSha : undefined,
			approvedSpecHash:
				typeof request.approvedSpecHash === 'string'
					? request.approvedSpecHash
					: undefined,
		});
		return Object.freeze({ response: validatedAuth, revisedDraft: null });
	}
	if (interrupt.kind === 'plan_critic') {
		assertCurrentResponse(response, interrupt);
		const action = respRec.action;
		if (action !== 'accept_residual' && action !== 'reauthorize' && action !== 'cancel') {
			throw new SdlcError(
				'INVALID_INPUT',
				`Invalid plan critic action: ${String(action)} (must be accept_residual, reauthorize, or cancel)`,
			);
		}
		return Object.freeze({
			response: {
				interruptId: respRec.interruptId,
				stateHash: respRec.stateHash,
				action,
			},
			revisedDraft: null,
		});
	}
	if (interrupt.kind === 'reconciliation_conflict') {
		assertCurrentResponse(response, interrupt);
		const action = respRec.action;
		if (action !== 'escalate' && action !== 'cancel') {
			throw new SdlcError(
				'INVALID_INPUT',
				`Invalid reconciliation conflict action: ${String(action)} (must be escalate or cancel)`,
			);
		}
		return Object.freeze({
			response: {
				interruptId: respRec.interruptId,
				stateHash: respRec.stateHash,
				action,
			},
			revisedDraft: null,
		});
	}
	if (interrupt.kind === 'high_risk_review') {
		assertCurrentResponse(response, interrupt);
		if (
			typeof request.taskPlanHash !== 'string' ||
			respRec.taskPlanHash !== request.taskPlanHash ||
			respRec.taskPlanHash !== state.taskPlanHash
		) {
			throw new SdlcError(
				'STALE_RESPONSE',
				'High-risk review does not match the frozen task plan hash',
			);
		}
		const action = respRec.action;
		if (action !== 'approve' && action !== 'cancel') {
			throw new SdlcError(
				'INVALID_INPUT',
				`Invalid high-risk review action: ${String(action)} (must be approve or cancel)`,
			);
		}
		return Object.freeze({
			response: {
				interruptId: respRec.interruptId,
				stateHash: respRec.stateHash,
				taskPlanHash: respRec.taskPlanHash,
				action,
			},
			revisedDraft: null,
		});
	}
	const action = validateApprovalAction(response, interrupt);
	if (action.action === 'approve') {
		const reqApproval =
			request.approval && typeof request.approval === 'object'
				? (request.approval as { approvalHash?: unknown })
				: null;
		if (
			action.approvalHash !== reqApproval?.approvalHash ||
			action.draftHash !== request.draftHash ||
			action.draftHash !== state.draftHash
		) {
			throw new SdlcError('STALE_RESPONSE', 'Approval hashes do not match current draft');
		}
		return Object.freeze({ response: action, revisedDraft: null });
	}
	if (action.action === 'revise') {
		const revisedDraft = applyPatch(draft, action.changes);
		assertAuthoritativeInputSafe(revisedDraft, 'Human-revised specification draft');
		return Object.freeze({ response: action, revisedDraft });
	}
	return Object.freeze({ response: action, revisedDraft: null });
}

function assertCurrentResponse(response: unknown, interrupt: InterruptRef): void {
	const rec =
		response && typeof response === 'object'
			? (response as { interruptId?: unknown; stateHash?: unknown })
			: null;
	if (rec?.interruptId !== interrupt.interruptId) {
		throw new SdlcError('STALE_RESPONSE', 'Response interrupt ID is stale');
	}
	if (rec?.stateHash !== interrupt.stateHash) {
		throw new SdlcError('STALE_RESPONSE', 'Response state hash is stale');
	}
}
