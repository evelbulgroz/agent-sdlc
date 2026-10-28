import { assertProjectionSafe } from '../persistence/artifacts.ts';
import {
	HOST_APPROVAL_CHOICES,
	HOST_FORBIDDEN_FLAGS,
	HOST_HIGH_RISK_REVIEW_CHOICES,
	HOST_PLAN_CRITIC_CHOICES,
	HOST_RECONCILIATION_CHOICES,
	type HostInvocationRecord,
	hostInvocationChangeSlots,
	validateHostInvocation,
} from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { exitCodeForContinuation } from './exit-codes.ts';
import {
	type ContinuationStateLike,
	computeContinuation,
	isInfrastructureContinuation,
} from './continuation.ts';

const RECOGNIZED_INTERRUPT_KINDS = new Set([
	'questions',
	'approval',
	'authorization',
	'plan_critic',
	'reconciliation_conflict',
	'high_risk_review',
]);

function freezeDeep<T>(value: T): Readonly<T> {
	if (!value || typeof value !== 'object') return value;
	for (const child of Object.values(value as Record<string, unknown>)) {
		freezeDeep(child);
	}
	return Object.freeze(value);
}

export interface HostInvocationStateLike extends ContinuationStateLike {
	runId?: string | null;
}

export interface HostInvocationInterruptInput {
	interruptId?: string;
	kind?: string | null;
	stateHash?: string | null;
	request?: Record<string, unknown> | null;
	payload?: Record<string, unknown> | null;
	[key: string]: unknown;
}

interface InterruptView {
	interruptId: string;
	kind: string | null;
	stateHash: string | null;
	request: Record<string, unknown> | null;
}

function requireRunId(state: HostInvocationStateLike | null | undefined): string {
	if (typeof state?.runId !== 'string' || state.runId.length === 0) {
		throw new SdlcError('INVALID_CONTRACT', 'hostInvocation requires a run id');
	}
	return state.runId;
}

function interruptView(
	pendingInterrupt: HostInvocationInterruptInput | null | undefined,
): InterruptView | null {
	if (!pendingInterrupt) return null;
	const request = pendingInterrupt.request ?? pendingInterrupt.payload ?? null;
	const kind =
		pendingInterrupt.kind ??
		(typeof request?.kind === 'string' ? request.kind : null) ??
		null;
	const stateHash =
		pendingInterrupt.stateHash ??
		(typeof request?.stateHash === 'string' ? request.stateHash : null) ??
		null;
	return {
		interruptId: pendingInterrupt.interruptId ?? '',
		kind,
		stateHash,
		request,
	};
}

function baseArgv(runId: string, command: string, extra: readonly string[] = []): string[] {
	return ['pnpm', 'run', 'agent:sdlc', '--', command, '--run', runId, ...extra, '--json'];
}

function finishCard(fields: {
	executable: boolean;
	packetConsumed: boolean;
	exitCode: number;
	argv: string[] | null;
	retryAllowed: boolean;
	responseDocument: Record<string, unknown> | null;
	responseSlots: unknown;
}): Readonly<HostInvocationRecord> {
	const value = {
		schemaVersion: '1.0.0' as const,
		executable: fields.executable,
		packetConsumed: fields.packetConsumed,
		exitCode: fields.exitCode,
		argv: fields.argv,
		forbiddenFlags: [...HOST_FORBIDDEN_FLAGS],
		retry: {
			allowed: fields.retryAllowed,
			maxAdditionalInvocations: fields.retryAllowed ? 1 : 0,
		},
		responseDocument: fields.responseDocument,
		responseSlots: fields.responseSlots,
	};
	assertProjectionSafe(JSON.stringify(value));
	const validated = validateHostInvocation(value);
	return freezeDeep(validated);
}

function consumedStop(exitCode: number): Readonly<HostInvocationRecord> {
	return finishCard({
		executable: false,
		packetConsumed: true,
		exitCode,
		argv: null,
		retryAllowed: false,
		responseDocument: null,
		responseSlots: null,
	});
}

function unrecognizedCard(exitCode: number): Readonly<HostInvocationRecord> {
	return finishCard({
		executable: false,
		packetConsumed: false,
		exitCode,
		argv: null,
		retryAllowed: false,
		responseDocument: null,
		responseSlots: null,
	});
}

function questionCard(
	runId: string,
	interrupt: InterruptView,
	exitCode: number,
): Readonly<HostInvocationRecord> {
	const rawQuestions = interrupt.request?.questions;
	const questions = Array.isArray(rawQuestions)
		? (rawQuestions as Array<{
				questionId?: unknown;
				responseKind?: unknown;
				options?: unknown;
				required?: unknown;
		  }>)
		: [];
	return finishCard({
		executable: true,
		packetConsumed: true,
		exitCode,
		argv: baseArgv(runId, 'answer', [
			'--interrupt',
			interrupt.interruptId,
			'--response-file',
			'{response-file}',
		]),
		retryAllowed: false,
		responseDocument: {
			schemaVersion: '1.0.0',
			interruptId: interrupt.interruptId,
			stateHash: interrupt.stateHash,
			answers: questions.map((question) => ({
				questionId: question.questionId,
				value: null,
			})),
		},
		responseSlots: questions.map((question) => ({
			questionId: question.questionId,
			responseKind: question.responseKind,
			options: Array.isArray(question.options) ? question.options : [],
			required: question.required,
		})),
	});
}

function approvalCard(
	runId: string,
	interrupt: InterruptView,
	exitCode: number,
): Readonly<HostInvocationRecord> {
	const approvalObj =
		interrupt.request?.approval && typeof interrupt.request.approval === 'object'
			? (interrupt.request.approval as { approvalHash?: unknown })
			: null;
	return finishCard({
		executable: true,
		packetConsumed: true,
		exitCode,
		argv: baseArgv(runId, 'resume', ['--response-file', '{response-file}']),
		retryAllowed: false,
		responseDocument: {
			schemaVersion: '1.0.0',
			interruptId: interrupt.interruptId,
			stateHash: interrupt.stateHash,
			action: null,
			approvalHash: approvalObj?.approvalHash ?? null,
			draftHash: interrupt.request?.draftHash ?? null,
			changes: [],
		},
		responseSlots: {
			field: 'action',
			choices: [...HOST_APPROVAL_CHOICES],
			changes: hostInvocationChangeSlots(),
		},
	});
}

function actionCard(
	runId: string,
	interrupt: InterruptView,
	choices: readonly string[],
	exitCode: number,
): Readonly<HostInvocationRecord> {
	return finishCard({
		executable: true,
		packetConsumed: true,
		exitCode,
		argv: baseArgv(runId, 'resume', ['--response-file', '{response-file}']),
		retryAllowed: false,
		responseDocument: {
			schemaVersion: '1.0.0',
			interruptId: interrupt.interruptId,
			stateHash: interrupt.stateHash,
			action: null,
			...(interrupt.request?.taskPlanHash
				? { taskPlanHash: interrupt.request.taskPlanHash }
				: {}),
		},
		responseSlots: {
			field: 'action',
			choices: [...choices],
		},
	});
}

/**
 * Pure host card for one run snapshot. The host executes argv when executable
 * is true. retry.allowed does not suppress that argv; the engine enforces the
 * infrastructure cap when it records the next continuation attempt.
 */
export function projectHostInvocation(
	state: HostInvocationStateLike | null | undefined,
	{
		authorization = null,
		pendingInterrupt = null,
		continuationAttempts = 0,
	}: {
		authorization?: { baseCommitSha?: string | null; [key: string]: unknown } | null;
		pendingInterrupt?: HostInvocationInterruptInput | null;
		continuationAttempts?: number;
	} = {},
): Readonly<HostInvocationRecord> {
	const continuation = computeContinuation(state, {
		authorization,
		pendingInterrupt,
		continuationAttempts,
	});
	const exitCode = exitCodeForContinuation(continuation, state) ?? 3;
	const interrupt = interruptView(pendingInterrupt);
	const pending = Boolean(state?.pendingInterruptId || pendingInterrupt);
	if (pending && (!interrupt?.kind || !RECOGNIZED_INTERRUPT_KINDS.has(interrupt.kind))) {
		return unrecognizedCard(exitCode);
	}
	if (continuation.action === 'stop') return consumedStop(exitCode);
	const runId = requireRunId(state);
	if (continuation.action === 'authorize') {
		return finishCard({
			executable: true,
			packetConsumed: true,
			exitCode,
			argv: baseArgv(runId, 'authorize'),
			retryAllowed: false,
			responseDocument: null,
			responseSlots: null,
		});
	}
	if (continuation.action === 'resume') {
		const retryAllowed =
			isInfrastructureContinuation(state) &&
			(continuationAttempts === 0 || continuationAttempts === 1);
		return finishCard({
			executable: true,
			packetConsumed: true,
			exitCode,
			argv: baseArgv(runId, 'resume'),
			retryAllowed,
			responseDocument: null,
			responseSlots: null,
		});
	}
	if (interrupt?.kind === 'questions') return questionCard(runId, interrupt, exitCode);
	if (interrupt?.kind === 'approval') return approvalCard(runId, interrupt, exitCode);
	if (interrupt?.kind === 'plan_critic') {
		return actionCard(runId, interrupt, HOST_PLAN_CRITIC_CHOICES, exitCode);
	}
	if (interrupt?.kind === 'reconciliation_conflict') {
		return actionCard(runId, interrupt, HOST_RECONCILIATION_CHOICES, exitCode);
	}
	if (interrupt?.kind === 'high_risk_review') {
		return actionCard(runId, interrupt, HOST_HIGH_RISK_REVIEW_CHOICES, exitCode);
	}
	return unrecognizedCard(exitCode);
}
