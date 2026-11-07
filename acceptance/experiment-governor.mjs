import { fail } from './primitives.mjs';

// Wraps the engine's model-usage governor so every physical dispatch is reserved against, and settled in, the frozen ledger.
export class ExperimentGovernor {
  constructor({ governor, ledger, scenario, maxAttemptCostMicrousd, maxRunCostMicrousd }) {
    if (!governor || governor.synthetic === true || !Number.isSafeInteger(maxAttemptCostMicrousd)
      || maxAttemptCostMicrousd <= 0) fail('unpriced/synthetic experiment governor');
    this.governor = governor;
    this.ledger = ledger;
    this.scenario = scenario;
    this.maxAttemptCostMicrousd = maxAttemptCostMicrousd;
    this.maxRunCostMicrousd = maxRunCostMicrousd;
    this.synthetic = false;
  }

  assertAvailable() { return this.governor.assertAvailable(); }
  getRunUsageLedger(runId) { return this.governor.getRunUsageLedger(runId); }
  getRunOperations(runId) { return this.governor.getRunOperations(runId); }

  narrow(request) {
    const dispatch = this.ledger.dispatchLimits(request, this.scenario);
    const limits = request.requestedLimits;
    if (!limits || ['maxPromptTokens', 'maxCompletionTokens', 'maxPhysicalAttempts',
      'maxRetriesPerRoute', 'maxFailovers'].some(key => !Number.isSafeInteger(limits[key]))) {
      fail('missing frozen role limits');
    }
    for (const key of ['maxPromptTokens', 'maxCompletionTokens', 'maxPhysicalAttempts']) {
      if (limits[key] <= 0) {
        fail(`invalid requested limit ${key}`);
      }
    }
    for (const key of ['maxRetriesPerRoute', 'maxFailovers']) {
      if (limits[key] !== undefined && (!Number.isSafeInteger(limits[key]) || limits[key] < 0)) {
        fail(`invalid requested limit ${key}`);
      }
    }
    if (limits.maxCostMicrousd !== undefined
      && (!Number.isSafeInteger(limits.maxCostMicrousd) || limits.maxCostMicrousd < 0)) {
      fail('invalid requested limit maxCostMicrousd');
    }
    const attempts = Math.min(dispatch.maxPhysicalAttempts, limits.maxPhysicalAttempts ?? dispatch.maxPhysicalAttempts);
    return { ...request, requestedLimits: {
      ...limits, maxPromptTokens: Math.min(dispatch.maxPromptTokens, limits.maxPromptTokens),
      maxCompletionTokens: Math.min(dispatch.maxCompletionTokens, limits.maxCompletionTokens),
      maxPhysicalAttempts: attempts,
      maxRetriesPerRoute: Math.min(attempts - 1, limits.maxRetriesPerRoute), maxFailovers: 0,
      maxCostMicrousd: Math.min(limits.maxCostMicrousd ?? Infinity,
        attempts * this.maxAttemptCostMicrousd),
    } };
  }

  // The governor treats requestedLimits.maxCostMicrousd as a run-cumulative cap; the ledger enforces per-attempt reservations.
  forGovernor(narrowed) {
    if (this.maxRunCostMicrousd === undefined) return narrowed;
    return { ...narrowed, requestedLimits: { ...narrowed.requestedLimits, maxCostMicrousd: this.maxRunCostMicrousd } };
  }

  async assertCanReserve(request) {
    await this.ledger.clock();
    return this.governor.assertCanReserve(this.forGovernor(this.narrow(request)));
  }

  async execute(request) {
    const narrowed = this.narrow(request);
    const limits = narrowed.requestedLimits;
    const attempts = limits.maxPhysicalAttempts;
    await this.ledger.reserve(narrowed, this.scenario, {
      logicalCalls: 1, physicalCalls: attempts, inputTokens: attempts * limits.maxPromptTokens,
      outputTokens: attempts * limits.maxCompletionTokens, costMicrousd: limits.maxCostMicrousd,
    });
    try {
      return await this.governor.execute(this.forGovernor(narrowed));
    } finally {
      await this.ledger.settle(narrowed, terminalUsage(this.governor, narrowed));
    }
  }
}

function terminalUsage(governor, request) {
  let ledger;
  try { ledger = governor.getRunUsageLedger(request.runId); }
  catch { return null; } // Full reservation remains charged when accounting is unprovable.
  const operation = ledger?.operations?.[request.operationId];
  if (!['succeeded', 'failed', 'recovery_charged'].includes(operation?.state)
    || ledger.runId !== request.runId
    || ledger.reservations.some((entry) => entry.operationId === request.operationId)) return null;
  const attempts = ledger.attempts.filter((entry) => entry.operationId === request.operationId);
  if (!attempts.length || attempts.some((entry) => !Number.isSafeInteger(entry.charge?.costMicrousd))) return null;
  const usage = attempts.reduce((total, entry) => ({
    physicalCalls: total.physicalCalls + entry.charge.physicalCalls,
    inputTokens: total.inputTokens + entry.charge.promptTokens,
    outputTokens: total.outputTokens + entry.charge.completionTokens,
    costMicrousd: total.costMicrousd + entry.charge.costMicrousd,
  }), { physicalCalls: 0, inputTokens: 0, outputTokens: 0, costMicrousd: 0 });
  return { logicalCalls: 1, ...usage };
}
