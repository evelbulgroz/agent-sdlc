import { bytesHash, fail } from './primitives.mjs';

export const DIMENSIONS = ['logicalCalls', 'physicalCalls', 'inputTokens', 'outputTokens', 'costMicrousd'];
export const MAX_APPROVED_SPEND_MICROUSD = 20_000_000;
const EXPERIMENT_CEILINGS = {
  maxElapsedMs: 5400000, logicalCalls: 200, physicalCalls: 400,
  inputTokens: 20000000, outputTokens: 10000000,
};
// First-run envelope: sized so one healthy scenario can complete; scale back after it is proven.
const SCENARIO_CEILINGS = { ...EXPERIMENT_CEILINGS };
export const DISPATCH_CEILINGS = {
  maxPromptTokens: 120000, maxCompletionTokens: 48000, criticAttempts: 2, otherAttempts: 2,
};

export function freezeConfiguration(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeConfiguration(child);
    Object.freeze(value);
  }
  return value;
}

function inventoryKey(entry) {
  return `${entry.scenario}\0${entry.runId}\0${entry.roleId}`;
}

export function validateExperimentConfiguration(configuration) {
  if (!configuration || !Number.isSafeInteger(configuration.maxElapsedMs)
    || configuration.maxElapsedMs <= 0 || configuration.maxElapsedMs > EXPERIMENT_CEILINGS.maxElapsedMs
    || !configuration.scenarios || typeof configuration.scenarios !== 'object'
    || Array.isArray(configuration.scenarios)
    || !Number.isSafeInteger(configuration.maxAttemptCostMicrousd)
    || configuration.maxAttemptCostMicrousd <= 0) fail('invalid experiment configuration');
  for (const key of DIMENSIONS) {
    const ceiling = key === 'costMicrousd' ? MAX_APPROVED_SPEND_MICROUSD : EXPERIMENT_CEILINGS[key];
    if (!Number.isSafeInteger(configuration[key]) || configuration[key] <= 0
      || configuration[key] > ceiling) {
      fail(`invalid/over-limit cap ${key}`);
    }
  }
  const scenarios = Object.entries(configuration.scenarios);
  if (!scenarios.length) fail('empty experiment scenarios');
  if (new Set(scenarios.map(([, limits]) => limits?.runId)).size !== scenarios.length) {
    fail('scenario run IDs must be unique');
  }
  for (const [name, limits] of scenarios) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || !/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/.test(limits?.runId ?? '')) {
      fail('invalid experiment scenario');
    }
    for (const key of DIMENSIONS) {
      const ceiling = key === 'costMicrousd' ? MAX_APPROVED_SPEND_MICROUSD : SCENARIO_CEILINGS[key];
      if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0
        || limits[key] > ceiling) {
        fail(`invalid/over-limit scenario cap ${key}`);
      }
    }
  }
  const inventory = configuration.dispatchInventory;
  if (!Array.isArray(inventory) || !inventory.length) fail('missing dispatch inventory');
  const keys = new Set(), demand = Object.fromEntries(DIMENSIONS.map(key => [key, 0]));
  const scenarioDemand = new Map(scenarios.map(([name]) =>
    [name, Object.fromEntries(DIMENSIONS.map(key => [key, 0]))]));
  for (const entry of inventory) {
    if (!entry || Object.keys(entry).sort().join() !==
      'logicalCalls,maxCompletionTokens,maxPhysicalAttempts,maxPromptTokens,roleId,runId,scenario'
      || !configuration.scenarios[entry.scenario]
      || configuration.scenarios[entry.scenario].runId !== entry.runId
      || !/^[a-z][a-z0-9-]*$/.test(entry.roleId)
      || !Number.isSafeInteger(entry.logicalCalls) || entry.logicalCalls <= 0
      || !Number.isSafeInteger(entry.maxPhysicalAttempts)
      || entry.maxPhysicalAttempts < 1 || entry.maxPhysicalAttempts > (entry.roleId === 'critic-reviewer' ? DISPATCH_CEILINGS.criticAttempts : DISPATCH_CEILINGS.otherAttempts)
      || !Number.isSafeInteger(entry.maxPromptTokens) || entry.maxPromptTokens <= 0 || entry.maxPromptTokens > DISPATCH_CEILINGS.maxPromptTokens
      || !Number.isSafeInteger(entry.maxCompletionTokens) || entry.maxCompletionTokens <= 0
      || entry.maxCompletionTokens > DISPATCH_CEILINGS.maxCompletionTokens || keys.has(inventoryKey(entry))) {
      fail('invalid dispatch inventory');
    }
    keys.add(inventoryKey(entry));
    const calls = entry.logicalCalls, attempts = calls * entry.maxPhysicalAttempts;
    const amounts = {
      logicalCalls: calls, physicalCalls: attempts,
      inputTokens: attempts * entry.maxPromptTokens,
      outputTokens: attempts * entry.maxCompletionTokens,
      costMicrousd: attempts * configuration.maxAttemptCostMicrousd,
    };
    for (const key of DIMENSIONS) {
      if (!Number.isSafeInteger(amounts[key])) fail('dispatch inventory arithmetic overflow');
      demand[key] += amounts[key];
      scenarioDemand.get(entry.scenario)[key] += amounts[key];
      if (!Number.isSafeInteger(demand[key]) || !Number.isSafeInteger(scenarioDemand.get(entry.scenario)[key])) {
        fail('dispatch inventory arithmetic overflow');
      }
    }
  }
  for (const key of DIMENSIONS) {
    if (demand[key] > configuration[key]) fail(`dispatch inventory exceeds shared ${key}`);
  }
  for (const [name, limits] of scenarios) {
    const required = scenarioDemand.get(name);
    for (const key of DIMENSIONS) {
      if (required[key] > limits[key]) fail(`dispatch inventory exceeds scenario ${name} ${key}`);
    }
    if (!inventory.some(entry => entry.scenario === name)) fail(`missing scenario dispatch inventory: ${name}`);
  }
  return { demand, scenarioDemand };
}

export function validateExperimentRoleLimits(configuration, roleDefinitions) {
  const roles = roleDefinitions?.roles;
  if (!Array.isArray(roles) || !roles.length) fail('missing resolved role definitions');
  const byId = new Map();
  for (const role of roles) {
    const limits = role?.requestedLimits;
    if (!role || typeof role.roleId !== 'string' || byId.has(role.roleId)
      || !limits || ['maxPromptTokens', 'maxCompletionTokens', 'maxPhysicalAttempts',
        'maxRetriesPerRoute', 'maxFailovers'].some(key => !Number.isSafeInteger(limits[key]) || limits[key] < 0)) {
      fail('invalid resolved role limits');
    }
    byId.set(role.roleId, limits);
  }
  for (const entry of configuration?.dispatchInventory ?? []) {
    const role = byId.get(entry.roleId);
    if (!role || entry.maxPromptTokens > role.maxPromptTokens
      || entry.maxCompletionTokens > role.maxCompletionTokens
      || entry.maxPhysicalAttempts > role.maxPhysicalAttempts
      || Math.min(entry.maxPhysicalAttempts - 1, role.maxRetriesPerRoute) > 1) {
      fail(`dispatch inventory widens role limits: ${entry.roleId}`);
    }
  }
  return true;
}

export function validateCanaryQualityPolicy(policy) {
  if (!policy || policy.schemaVersion !== '1.0.0' || policy.policyId !== 'checkpoint-evidence-v1'
    || policy.testRetryPolicy !== 'clean-success'
    || policy.additionalCandidateReviews !== 1 || policy.followUpDispatches !== 1
    || policy.retrieval?.maxPacketBytes !== 24576 || policy.retrieval?.maxPacketLines !== 1000
    || policy.retrieval?.maxTotalBytesPerCandidate !== 49152
    || policy.retrieval?.maxTotalLinesPerCandidate !== 2000
    || !Number.isSafeInteger(policy.execution?.maxInvocations) || policy.execution.maxInvocations > 48
    || !Number.isSafeInteger(policy.execution?.maxTotalDurationMs) || policy.execution.maxTotalDurationMs > 1800000
    || !Number.isSafeInteger(policy.review?.maxLogicalDispatches) || policy.review.maxLogicalDispatches > 20
    || !Number.isSafeInteger(policy.review?.maxPhysicalCalls) || policy.review.maxPhysicalCalls > 40
    || !Number.isSafeInteger(policy.review?.maxInputTokens) || policy.review.maxInputTokens > 768000
    || !Number.isSafeInteger(policy.review?.maxOutputTokens) || policy.review.maxOutputTokens > 192000) {
    fail('canary quality policy exceeds the reviewed ceilings');
  }
  return true;
}

export function controlQualificationHash(control) {
  const payload = Object.fromEntries(Object.entries(control ?? {}).filter(([key]) => key !== 'qualificationHash'));
  return bytesHash(Buffer.from(JSON.stringify(payload)));
}
