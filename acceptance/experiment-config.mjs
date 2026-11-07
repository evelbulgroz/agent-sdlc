import {
  argumentsFor, fail, isMain, main, readJson, writeJson,
} from './primitives.mjs';
import {
  DISPATCH_CEILINGS, validateCanaryQualityPolicy, validateExperimentConfiguration,
  validateExperimentRoleLimits,
} from './experiment-budget.mjs';

const MAX_ATTEMPT_COST_MICROUSD = 100_000;
// Per-role worst case: logical calls (one per executor step for the implementer), attempts per call, optional completion cap.
// Worst-case demand is calls x attempts x per-attempt cost, so the total stays inside the approved USD 20.
const PLAN = {
  specifier: { logicalCalls: 2, attempts: 1 },
  implementer: { logicalCalls: 160, attempts: 1, completion: 48000 },
  reviewer: { logicalCalls: 2, attempts: 1 },
  'critic-reviewer': { logicalCalls: 10, attempts: 2 },
};

// The caller supplies the run id (YYYY-MM-DD-<name>); the engine derives none from host naming.
export function buildExperiment(roleRecord, runId) {
  if (!runId) fail('runId is required');
  const dispatchInventory = Object.entries(PLAN).map(([roleId, plan]) => {
    const role = roleRecord.roles.find((entry) => entry.roleId === roleId);
    if (!role) fail(`missing resolved role: ${roleId}`);
    const limits = role.requestedLimits;
    return { scenario: 'healthy', runId, roleId, logicalCalls: plan.logicalCalls,
      maxPhysicalAttempts: Math.min(plan.attempts, limits.maxPhysicalAttempts),
      maxPromptTokens: Math.min(limits.maxPromptTokens, 100_000, DISPATCH_CEILINGS.maxPromptTokens),
      maxCompletionTokens: Math.min(limits.maxCompletionTokens, plan.completion ?? Infinity, DISPATCH_CEILINGS.maxCompletionTokens) };
  });
  const caps = { logicalCalls: 200, physicalCalls: 400, inputTokens: 20_000_000,
    outputTokens: 10_000_000, costMicrousd: 20_000_000 };
  const experiment = { ...caps, maxAttemptCostMicrousd: MAX_ATTEMPT_COST_MICROUSD, maxElapsedMs: 5_400_000,
    scenarios: { healthy: { ...caps, runId } }, dispatchInventory };
  validateExperimentConfiguration(experiment);
  validateExperimentRoleLimits(experiment, roleRecord);
  return experiment;
}

export function buildQualityPolicy() {
  const policy = {
    schemaVersion: '1.0.0', policyId: 'checkpoint-evidence-v1', additionalCandidateReviews: 1,
    followUpDispatches: 1, testRetryPolicy: 'clean-success',
    retrieval: { maxPacketBytes: 24576, maxPacketLines: 1000,
      maxTotalBytesPerCandidate: 49152, maxTotalLinesPerCandidate: 2000 },
    execution: { maxInvocations: 48, maxTotalDurationMs: 1_800_000 },
    review: { maxLogicalDispatches: 20, maxPhysicalCalls: 40, maxInputTokens: 768_000, maxOutputTokens: 192_000 },
  };
  validateCanaryQualityPolicy(policy);
  return policy;
}

if (isMain(import.meta.url)) await main(async () => {
  const args = argumentsFor(process.argv.slice(2), ['--role-definitions', '--output-dir', '--run-id']);
  const roles = readJson(args['--role-definitions']);
  if (roles.status !== 'passed') fail('role definitions not passed');
  const experiment = buildExperiment(roles, args['--run-id']);
  writeJson(`${args['--output-dir']}/experiment.json`, { schemaVersion: '1.0.0', experiment });
  writeJson(`${args['--output-dir']}/quality-policy.json`, buildQualityPolicy());
  process.stdout.write(`${JSON.stringify(experiment.dispatchInventory, null, 1)}\n`);
});
