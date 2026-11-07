import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bytesHash, fail, LAUNCHER } from './primitives.mjs';
import { controlQualificationHash } from './experiment-budget.mjs';
import { allowedPaths } from './run-authorization.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sha = (value) => bytesHash(Buffer.from(JSON.stringify(value)));

export function engineRecord(config, engineRoot) {
  if (git(engineRoot, 'status', '--porcelain=v1', '--untracked-files=no')) fail('engine has uncommitted tracked changes');
  const lock = path.join(engineRoot, 'pnpm-lock.yaml');
  return { schemaVersion: '1.0.0', engineRoot, engineCommit: git(engineRoot, 'rev-parse', 'HEAD'),
    lockfileSha256: bytesHash(fs.readFileSync(lock)), node: config.node, nodeVersion: process.version,
    downloadsAllowed: false, installationCommands: [] };
}

export function priceRecord(governor, experiment) {
  const routes = governor.profiles['critic-review'].routes.filter((route) => route.enabled);
  if (!routes.length || routes.some((route) => route.pricingStatus !== 'known')) fail('unpriced live route');
  return { schemaVersion: '1.0.0', pricingVersion: governor.pricingVersion,
    routes: routes.map(({ routeId, provider, model, canonicalVendor, pricingStatus }) =>
      ({ routeId, provider, model, canonicalVendor, pricingStatus })),
    unknownUsage: 'charge-full-reservation', experiment,
    worstCaseAttempts: experiment.dispatchInventory.reduce((sum, entry) =>
      sum + entry.logicalCalls * entry.maxPhysicalAttempts, 0) };
}

export function commandsRecord(config, runtimeVerify) {
  if (!config.taskVerificationCommand) fail('acceptanceEvidence.taskVerificationCommand is not configured');
  return { schemaVersion: '1.0.0', node: config.node, launcher: LAUNCHER, packages: [config.packageRoot],
    allowedPathPrefixes: allowedPaths(config), verify: runtimeVerify, taskVerification: [...config.taskVerificationCommand],
    environment: { HOME: '/tmp', TMPDIR: '/tmp', PATH: '/nonexistent', LANG: 'C.UTF-8' },
    inheritedSecrets: false, network: false };
}

export function ownershipRecord(config) {
  return { schemaVersion: '1.0.0', evidenceRoot: config.output, runtimeRoot: config.stateDir,
    gitignored: true, mergeCanary: false, deliveryOperations: 'forbidden',
    retention: 'retain run artifacts and ledgers; no pruning during the experiment' };
}

export function semanticPackets(corpus) {
  const cases = corpus.cases.filter((entry) => entry.kind === 'semantic');
  return { schemaVersion: '1.0.0', status: 'pending-live-qualification',
    note: 'Expected outcomes frozen before any provider call; no results are recorded here.',
    cases: cases.map(({ id, expected }) => ({ id, expected })), corpusSha256: sha(corpus) };
}

// Runs the caller-supplied control specs, then records the hashes they were run against.
// NODE_TEST_CONTEXT is dropped: inherited, it makes a child test run report to its parent and always exit 0.
export function controlRecord({ config, root, experiment, policy, roles, specPaths }) {
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  execFileSync(config.node, ['--test', ...specPaths], { cwd: root, stdio: 'pipe', timeout: 600000, env });
  const control = { schemaVersion: '1.0.0', status: 'passed', failures: [], qualifiedLauncher: true,
    launcherSha256: bytesHash(fs.readFileSync(LAUNCHER)), experimentSha256: sha(experiment),
    qualityPolicySha256: sha(policy), roleDefinitionsSha256: sha(roles), allRoleEnforced: true,
    deadlineEnforced: true, spendEnforced: true, containmentEnforced: true };
  return { ...control, qualificationHash: controlQualificationHash(control) };
}

// The six admission records, keyed by their engine-owned file names.
export function buildAdmissionRecords(config, root, { engineRoot, governor, experiment, policy, roles, corpus, runtimeVerify, specPaths }) {
  return {
    engineBuildAndDependencies: engineRecord(config, engineRoot),
    routePricesAndReservationInventory: priceRecord(governor, experiment),
    allowedCommandsAndEnvironment: commandsRecord(config, runtimeVerify),
    artifactOwnershipAndRetention: ownershipRecord(config),
    semanticQualificationPackets: semanticPackets(corpus),
    controllerAndContainmentReceipts: controlRecord({ config, root, experiment, policy, roles, specPaths }),
  };
}
