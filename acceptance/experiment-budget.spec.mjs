import assert from 'node:assert/strict';
import test from 'node:test';
import {
  controlQualificationHash, validateCanaryQualityPolicy, validateExperimentConfiguration,
  validateExperimentRoleLimits,
} from './experiment-budget.mjs';
import { buildExperiment, buildQualityPolicy } from './experiment-config.mjs';

function configuration() {
  const scenarioCaps = { logicalCalls: 2, physicalCalls: 3, inputTokens: 60000,
    outputTokens: 18000, costMicrousd: 150 };
  return {
    logicalCalls: 4, physicalCalls: 6, inputTokens: 120000, outputTokens: 36000,
    costMicrousd: 300, maxAttemptCostMicrousd: 50, maxElapsedMs: 1000,
    scenarios: {
      healthy: { ...scenarioCaps, runId: '2026-11-02-healthy' },
      defect: { ...scenarioCaps, runId: '2026-11-02-defect' },
    },
    dispatchInventory: ['healthy', 'defect'].flatMap((scenario, index) => [
      { scenario, runId: `2026-11-02-${index ? 'defect' : 'healthy'}`, roleId: 'implementer',
        logicalCalls: 1, maxPhysicalAttempts: 1, maxPromptTokens: 20000, maxCompletionTokens: 6000 },
      { scenario, runId: `2026-11-02-${index ? 'defect' : 'healthy'}`, roleId: 'critic-reviewer',
        logicalCalls: 1, maxPhysicalAttempts: 2, maxPromptTokens: 20000, maxCompletionTokens: 6000 },
    ]),
  };
}

test('dispatch inventory arithmetic fits the shared and per-run hard ceilings', () => {
  const result = validateExperimentConfiguration(configuration());
  assert.deepEqual(result.demand, {
    logicalCalls: 4, physicalCalls: 6, inputTokens: 120000, outputTokens: 36000, costMicrousd: 300,
  });
  assert.equal(result.scenarioDemand.get('healthy').physicalCalls, 3);
});

test('aggregate and per-scenario spend caps cannot exceed the approved $20 ceiling', () => {
  const source = configuration();
  assert.equal(validateExperimentConfiguration({
    ...source, costMicrousd: 20_000_000,
  }).demand.costMicrousd, 300);
  assert.throws(() => validateExperimentConfiguration({
    ...source, costMicrousd: 20_000_001,
  }), /cap costMicrousd/);
  assert.throws(() => validateExperimentConfiguration({
    ...source, scenarios: { ...source.scenarios,
      healthy: { ...source.scenarios.healthy, costMicrousd: 20_000_001 } },
  }), /cap costMicrousd/);
});

test('quality policy cannot raise retries, retrieval, execution or review ceilings', () => {
  const policy = {
    schemaVersion: '1.0.0', policyId: 'checkpoint-evidence-v1', additionalCandidateReviews: 1,
    followUpDispatches: 1, testRetryPolicy: 'clean-success',
    retrieval: { maxPacketBytes: 24576, maxPacketLines: 1000,
      maxTotalBytesPerCandidate: 49152, maxTotalLinesPerCandidate: 2000 },
    execution: { maxInvocations: 48, maxTotalDurationMs: 1800000 },
    review: { maxLogicalDispatches: 12, maxPhysicalCalls: 24, maxInputTokens: 768000, maxOutputTokens: 192000 },
  };
  assert.equal(validateCanaryQualityPolicy(policy), true);
  for (const candidate of [
    { ...policy, followUpDispatches: 2 },
    { ...policy, retrieval: { ...policy.retrieval, maxPacketBytes: 24577 } },
    { ...policy, execution: { ...policy.execution, maxTotalDurationMs: 1800001 } },
    { ...policy, review: { ...policy.review, maxPhysicalCalls: 41 } },
    { ...policy, review: { ...policy.review, maxLogicalDispatches: 21 } },
    { ...policy, review: { ...policy.review, maxInputTokens: 768001 } },
    { ...policy, review: undefined },
  ]) assert.throws(() => validateCanaryQualityPolicy(candidate), /reviewed ceilings/);
});

test('control qualification hash excludes itself and changes with any control claim', () => {
  const control = {
    schemaVersion: '1.0.0', status: 'passed', qualifiedLauncher: true,
    launcherSha256: 'a'.repeat(64), experimentSha256: 'b'.repeat(64),
    qualityPolicySha256: 'c'.repeat(64), roleDefinitionsSha256: 'd'.repeat(64),
    allRoleEnforced: true, deadlineEnforced: true, spendEnforced: true, containmentEnforced: true,
  };
  const hash = controlQualificationHash(control);
  assert.equal(controlQualificationHash({ ...control, qualificationHash: hash }), hash);
  assert.notEqual(controlQualificationHash({ ...control, spendEnforced: false }), hash);
});

test('dispatch inventory never widens the hash-bound role limits', () => {
  const roles = { roles: [
    { roleId: 'implementer', requestedLimits: { maxPromptTokens: 968000, maxCompletionTokens: 16000,
      maxPhysicalAttempts: 4, maxRetriesPerRoute: 1, maxFailovers: 2 } },
    { roleId: 'critic-reviewer', requestedLimits: { maxPromptTokens: 20000, maxCompletionTokens: 6000,
      maxPhysicalAttempts: 3, maxRetriesPerRoute: 2, maxFailovers: 1 } },
  ] };
  assert.equal(validateExperimentRoleLimits(configuration(), roles), true);
  const narrowed = structuredClone(roles);
  narrowed.roles[1].requestedLimits.maxPhysicalAttempts = 1;
  assert.throws(() => validateExperimentRoleLimits(configuration(), narrowed), /widens role limits/);
  assert.throws(() => validateExperimentRoleLimits(configuration(), { roles: [roles.roles[0]] }),
    /widens role limits/);
});

test('null, empty, duplicate, unbound and over-budget dispatch inventories fail closed', () => {
  const source = configuration();
  for (const candidate of [
    null,
    {},
    { ...source, dispatchInventory: [] },
    { ...source, dispatchInventory: [...source.dispatchInventory, source.dispatchInventory[0]] },
    { ...source, dispatchInventory: source.dispatchInventory.map((entry, index) =>
      index ? entry : { ...entry, runId: '2026-11-02-unbound' }) },
    { ...source, maxElapsedMs: 5400001 },
    { ...source, physicalCalls: 401 },
    { ...source, physicalCalls: 5 },
    { ...source, scenarios: { ...source.scenarios,
      healthy: { ...source.scenarios.healthy, outputTokens: 17999 } } },
    { ...source, dispatchInventory: source.dispatchInventory.map(entry =>
      entry.roleId === 'critic-reviewer' ? { ...entry, maxPhysicalAttempts: 3 } : entry) },
    { ...source, dispatchInventory: source.dispatchInventory.map(entry =>
      entry.roleId === 'implementer' ? { ...entry, maxPhysicalAttempts: 3 } : entry) },
    { ...source, dispatchInventory: source.dispatchInventory.map(entry =>
      ({ ...entry, maxPromptTokens: 120001 })) },
  ]) assert.throws(() => validateExperimentConfiguration(candidate), /EvidenceAdmissionError/);
});

test('built experiment is bound to the supplied run id and passes its own ceilings', () => {
  const limits = { maxPromptTokens: 100000, maxCompletionTokens: 48000, maxPhysicalAttempts: 2,
    maxRetriesPerRoute: 1, maxFailovers: 0 };
  const roles = { roles: ['specifier', 'implementer', 'reviewer', 'critic-reviewer']
    .map((roleId) => ({ roleId, requestedLimits: limits })) };
  const experiment = buildExperiment(roles, '2026-11-07-example');
  assert.ok(experiment.dispatchInventory.every((entry) => entry.runId === '2026-11-07-example'));
  assert.throws(() => buildExperiment(roles, ''), /runId is required/);
  assert.equal(validateCanaryQualityPolicy(buildQualityPolicy()), true);
});
