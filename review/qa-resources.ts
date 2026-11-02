import { z } from 'zod';
import type { QualityPolicy } from '../policy/contracts/quality-schema.ts';
import { SdlcError } from '../policy/errors.ts';
import type { CriticGateRuntimeLike } from './critic-gate.ts';
import type { CriticGovernorLike, CriticGovernorResult } from './critic-review.ts';
import { buildCriticOperationId, computeScopeDigest } from './critic-review.ts';

const Count = z.number().int().nonnegative().safe();
const Charge = z.object({
	promptTokens: Count, completionTokens: Count, totalTokens: Count, physicalCalls: Count,
}).refine(value => value.promptTokens + value.completionTokens === value.totalTokens);
const UsageLedger = z.object({
	runId: z.string(),
	operations: z.record(z.string(), z.object({
		state: z.enum(['succeeded', 'failed', 'recovery_charged', 'active', 'reserved']),
		usageRecordIds: z.array(z.string().min(1)),
	})),
	attempts: z.array(z.object({ operationId: z.string(), usageRecordId: z.string().min(1), charge: Charge })),
	reservations: z.array(z.object({ operationId: z.string() })),
});

export type QaDispatchLimits = {
	maxPromptTokens: number;
	maxCompletionTokens: number;
	maxPhysicalAttempts: number;
	maxRetriesPerRoute: number;
	maxFailovers: number;
};

export function qaDispatchIntent(runId: string, attemptKey: string, generation: number, limits: QaDispatchLimits) {
	return {
		governorOperationId: buildCriticOperationId({
			runId, phase: 'qa', scopeDigest: computeScopeDigest(attemptKey), generation,
		}),
		physicalCalls: limits.maxPhysicalAttempts,
		inputTokens: limits.maxPhysicalAttempts * limits.maxPromptTokens,
		outputTokens: limits.maxPhysicalAttempts * limits.maxCompletionTokens,
	};
}

export function recoverAbandonedQaDispatches(runtime: CriticGateRuntimeLike, runId: string): void {
	const quality = runtime.runtimeStore.quality;
	if (!quality) throw new SdlcError('STORE_RECONCILIATION_FAILED', 'Quality store is unavailable');
	for (const reservation of quality.getBudget(runId)?.reservations ?? []) {
		if (reservation.kind === 'execution' || reservation.status !== 'reserved') continue;
		const intent = quality.getQaDispatchIntent(runId, reservation.operationId);
		if (!intent) throw new SdlcError('STORE_RECONCILIATION_FAILED',
			`QA reservation '${reservation.operationId}' lacks durable dispatch limits; operator reconciliation required`);
		let usage;
		try {
			if (!runtime.governor || runtime.governor.synthetic) throw new Error('Unproven dispatch');
			usage = accounting(runtime.governor, runId, intent.governorOperationId, undefined, false);
		} catch {
			usage = { physicalCalls: intent.physicalCalls, inputTokens: intent.inputTokens, outputTokens: intent.outputTokens };
		}
		quality.chargeBudget(runId, reservation.operationId, usage, 'interrupted');
	}
}

export function qaDispatchLimits(
	runtime: CriticGateRuntimeLike, runId: string, policy: QualityPolicy, operationId: string,
): QaDispatchLimits | null {
	const budget = runtime.runtimeStore.quality?.getBudget(runId);
	if (!budget || budget.reservations.some(reservation =>
		reservation.kind !== 'execution' && reservation.status === 'reserved' && reservation.operationId !== operationId,
	)) return null;
	const remaining = {
		calls: policy.review.maxPhysicalCalls - budget.counters.physicalCalls,
		input: policy.review.maxInputTokens - budget.counters.inputTokens,
		output: policy.review.maxOutputTokens - budget.counters.outputTokens,
	};
	if (Math.min(remaining.calls, remaining.input, remaining.output) <= 0 ||
		budget.counters.logicalDispatches >= policy.review.maxLogicalDispatches) return null;
	const role = runtime.registry.loadRole('critic-reviewer').role?.requestedLimits;
	const attempts = Math.min(role?.maxPhysicalAttempts ?? 1, remaining.calls, remaining.input, remaining.output);
	return {
		maxPromptTokens: Math.min(role?.maxPromptTokens ?? 20_000, Math.floor(remaining.input / attempts)),
		maxCompletionTokens: Math.min(role?.maxCompletionTokens ?? 6_000, Math.floor(remaining.output / attempts)),
		maxPhysicalAttempts: attempts,
		maxRetriesPerRoute: Math.max(0, attempts - 1),
		maxFailovers: 0,
	};
}

function accounting(
	governor: CriticGovernorLike, runId: string, operationId: string, result?: CriticGovernorResult,
	requireSuccess = result !== undefined,
) {
	if (governor.synthetic === true && !result?.usageRecordIds?.length) {
		return { physicalCalls: 0, inputTokens: 0, outputTokens: 0 };
	}
	const ledger = UsageLedger.parse(governor.getRunUsageLedger?.(runId));
	const operation = ledger.operations[operationId];
	const attempts = ledger.attempts.filter(attempt => attempt.operationId === operationId);
	if (ledger.runId !== runId || !operation ||
		!['succeeded', 'failed', 'recovery_charged'].includes(operation.state) ||
		ledger.reservations.some(reservation => reservation.operationId === operationId) ||
		(requireSuccess && operation.state !== 'succeeded') ||
		(result && result.operationId !== operationId) ||
		new Set(operation.usageRecordIds).size !== operation.usageRecordIds.length ||
		attempts.length !== operation.usageRecordIds.length ||
		attempts.some(attempt => !operation.usageRecordIds.includes(attempt.usageRecordId)) ||
		new Set(attempts.map(attempt => attempt.usageRecordId)).size !== attempts.length ||
		(result && (!Array.isArray(result.usageRecordIds) ||
			result.usageRecordIds.length !== attempts.length ||
			new Set(result.usageRecordIds).size !== attempts.length ||
			result.usageRecordIds.some(id => !operation.usageRecordIds.includes(id)))) ||
		(requireSuccess && attempts.length === 0)
	) throw new Error('Invalid governed QA accounting identity or terminal state');
	const usage = attempts.reduce((total, attempt) => ({
		physicalCalls: total.physicalCalls + attempt.charge.physicalCalls,
		inputTokens: total.inputTokens + attempt.charge.promptTokens,
		outputTokens: total.outputTokens + attempt.charge.completionTokens,
	}), { physicalCalls: 0, inputTokens: 0, outputTokens: 0 });
	if (Object.values(usage).some(value => !Number.isSafeInteger(value))) throw new Error('Governed QA accounting overflow');
	return usage;
}

export function governedQaDispatch(
	runtime: CriticGateRuntimeLike, runId: string, reservationId: string, limits: QaDispatchLimits, policy: QualityPolicy,
): CriticGovernorLike {
	const governor = runtime.governor;
	const quality = runtime.runtimeStore.quality;
	if (!governor || !quality) throw new SdlcError('GOVERNOR_UNAVAILABLE', 'QA governor or quality store is unavailable');
	return {
		synthetic: governor.synthetic,
		getRunOperations: governor.getRunOperations?.bind(governor),
		async execute(request) {
			const operationId = request.operationId;
			if (typeof operationId !== 'string') throw new SdlcError('INVALID_CONTRACT', 'QA dispatch operation identity missing');
			let result: CriticGovernorResult | undefined;
			let failure: unknown;
			try { result = await governor.execute(request); } catch (error: unknown) { failure = error; }
			let usage;
			try { usage = accounting(governor, runId, operationId, result); }
			catch (error: unknown) {
				quality.chargeBudget(runId, reservationId, {
					physicalCalls: limits.maxPhysicalAttempts,
					inputTokens: limits.maxPhysicalAttempts * limits.maxPromptTokens,
					outputTokens: limits.maxPhysicalAttempts * limits.maxCompletionTokens,
				}, 'interrupted');
				throw new SdlcError('STORE_RECONCILIATION_FAILED', 'Governed QA accounting is missing or invalid', {}, { cause: error });
			}
			quality.chargeBudget(runId, reservationId, usage, failure === undefined ? 'consumed' : 'interrupted');
			if (failure !== undefined) throw failure;
			if (!result) throw new SdlcError('GOVERNOR_UNAVAILABLE', 'QA governor returned no result');
			if (usage.physicalCalls > limits.maxPhysicalAttempts ||
				usage.inputTokens > limits.maxPhysicalAttempts * limits.maxPromptTokens ||
				usage.outputTokens > limits.maxPhysicalAttempts * limits.maxCompletionTokens ||
				!qaUsageWithinPolicy(runtime, runId, policy)) {
				throw new SdlcError('BUDGET_EXHAUSTED', 'Governed QA dispatch exceeded its narrowed resource limits');
			}
			return result;
		},
	};
}

function qaUsageWithinPolicy(runtime: CriticGateRuntimeLike, runId: string, policy: QualityPolicy): boolean {
	const counters = runtime.runtimeStore.quality?.getBudget(runId)?.counters;
	return Boolean(counters &&
		counters.physicalCalls <= policy.review.maxPhysicalCalls &&
		counters.inputTokens <= policy.review.maxInputTokens &&
		counters.outputTokens <= policy.review.maxOutputTokens &&
		counters.logicalDispatches <= policy.review.maxLogicalDispatches);
}

export function qaReplayAccounted(
	runtime: CriticGateRuntimeLike, runId: string, policy: QualityPolicy, reservationId: string,
	review: { generation?: unknown; attemptKey?: unknown },
): boolean {
	const quality = runtime.runtimeStore.quality;
	const governor = runtime.governor;
	if (!quality || !governor || !qaUsageWithinPolicy(runtime, runId, policy)) return false;
	if (governor.synthetic === true) return true;
	if (typeof review.generation !== 'number' || !Number.isSafeInteger(review.generation) ||
		review.generation < 0 || typeof review.attemptKey !== 'string') return false;
	try {
		const operationId = buildCriticOperationId({
			runId, phase: 'qa', scopeDigest: computeScopeDigest(review.attemptKey), generation: review.generation,
		});
		const usage = accounting(governor, runId, operationId, undefined, true);
		// The store rejects changed charge contents and does not apply an identical charge twice.
		quality.chargeBudget(runId, reservationId, usage, 'consumed');
		return true;
	} catch { return false; }
}

export function settleUndispatchedQa(
	runtime: CriticGateRuntimeLike, runId: string, operationId: string, status: 'consumed' | 'interrupted',
): void {
	const quality = runtime.runtimeStore.quality;
	if (!quality) throw new SdlcError('STORE_RECONCILIATION_FAILED', 'Quality store is unavailable');
	if (quality.getBudget(runId)?.reservations.find(entry => entry.operationId === operationId)?.status === 'reserved') {
		quality.chargeBudget(runId, operationId, { physicalCalls: 0, inputTokens: 0, outputTokens: 0 }, status);
	}
}
