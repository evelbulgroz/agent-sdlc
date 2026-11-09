import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { bytesHash, engineModule, fail, LAUNCHER, readJson, verifyFile } from './primitives.mjs';
import { engineContracts } from './contracts.mjs';
import { admissionIdentity } from './artifacts.mjs';
import { allowedPaths } from './run-authorization.mjs';
import { verifyScenarioBindings } from './live-records.mjs';
import {
  controlQualificationHash, validateCanaryQualityPolicy, validateExperimentConfiguration,
  validateExperimentRoleLimits,
} from './experiment-budget.mjs';

export const BINDINGS = [
  'engineBuildAndDependencies', 'hostProfile', 'runtimeInventory', 'adapterRegistrations',
  'pretestEquivalenceReceipt', 'canonicalPreflightClosure', 'candidatePreparationManifests',
  'corpusAndExpectedOutcomes', 'offlineQualificationReceipt', 'semanticQualificationPackets',
  'caseIdentityMap', 'approvedRunSpecsAndTaskPlans', 'resolvedGovernorPolicyAndRoutes',
  'resolvedRoleDefinitions', 'promptFitMeasurements', 'routePricesAndReservationInventory',
  'controllerAndContainmentReceipts', 'allowedCommandsAndEnvironment',
  'artifactOwnershipAndRetention', 'runAuthorizations',
];

export function bindingRecords(root, manifest) {
  const bindings = {};
  for (const name of BINDINGS) {
    const reference = manifest.bindings?.[name];
    const record = readJson(verifyFile(root, reference));
    if (record.schemaVersion !== reference.schemaVersion) fail(`binding schema mismatch: ${name}`);
    bindings[name] = record;
  }
  return bindings;
}

export function unexpectedDirtyEntries(porcelainZ, runPrefixes) {
  return porcelainZ.split('\0').filter(Boolean).filter(entry => !(entry.startsWith('?? ')
    && !entry.includes('..') && runPrefixes.some(prefix => entry.slice(3).startsWith(prefix))));
}

// Turns a proposal into an assembled manifest: always BLOCKED, bound to the exact proposal bytes.
export function assembleManifest(proposal, proposalBytes) {
  return { ...proposal, admission: 'BLOCKED', proposalSha256: bytesHash(proposalBytes) };
}

// Identity, scope and operation checks that need no bound records; split out so they fail before any file is read.
function assertManifestScope(root, config, manifest) {
  const identity = admissionIdentity(config);
  if (!manifest || manifest.manifestVersion !== identity.manifestVersion
    || manifest.admission !== 'APPROVED' || manifest.downloadsAllowed !== false
    || manifest.installationCommands?.length !== 0 || manifest.nodeExecutable !== config.node
    || manifest.repositoryId !== identity.repositoryId || manifest.mergeCanary !== false) fail('manifest not approved');
  if (fs.realpathSync(root) !== fs.realpathSync(manifest.hostRoot)) fail('wrong host root');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (base !== manifest.integrationBaseCommit) fail('integration base drift');
  if (manifest.allowedPackages?.length !== 1 || manifest.allowedPackages[0] !== config.packageRoot) fail('package scope');
  if (JSON.stringify(manifest.allowedPathPrefixes) !== JSON.stringify(allowedPaths(config))) fail('path scope');
  const ops = manifest.allowedOperations;
  const required = ['editIsolatedWorktree', 'runAllowlistedCommands', 'createDetachedWorktree'];
  const denied = ['createBranch', 'createLocalCommits', 'push', 'openPullRequest', 'merge', 'deploy'];
  if (!ops || required.some((key) => ops[key] !== true) || denied.some((key) => ops[key] !== false)) {
    fail('delivery operations forbidden');
  }
  return base;
}

export async function verifyAdmission(root, config, manifest, { allowRunArtifacts = false } = {}) {
  const base = assertManifestScope(root, config, manifest);
  verifyFile('/', { path: config.node.slice(1), sha256: manifest.bindings?.nodeExecutableSha256 });
  for (const name of ['integrationPreflightReceipt', 'implementationApprovalReceipt', 'liveApprovalReceipt']) {
    const receipt = readJson(verifyFile(root, manifest[name]));
    if (receipt.status !== 'passed' || receipt.baseCommitSha !== base) fail(`invalid receipt: ${name}`);
  }
  const contracts = await engineContracts();
  validateCanaryQualityPolicy(contracts.QualityPolicySchema.parse(manifest.qualityPolicy));
  const bindings = bindingRecords(root, manifest);
  const experiment = bindings.routePricesAndReservationInventory.experiment;
  validateExperimentConfiguration(experiment);
  // After a run has started, only that run's own spec artifacts may be untracked; nothing else may be dirty.
  if (allowRunArtifacts && !config.runsDir) fail('runsDir is required to tolerate run artifacts');
  const runPrefixes = allowRunArtifacts
    ? Object.values(experiment.scenarios).map(entry => `${config.runsDir}/${entry.runId}/`) : [];
  const dirty = unexpectedDirtyEntries(execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '-z'],
    { cwd: root, encoding: 'utf8' }), runPrefixes);
  if (dirty.length) fail('host worktree is dirty');
  validateExperimentRoleLimits(experiment, bindings.resolvedRoleDefinitions);
  const { verifyEvidenceRegistration } = await engineModule('host/evidence-files');
  for (const registration of bindings.adapterRegistrations.registrations ?? []) {
    contracts.AdapterRegistrationSchema.parse(registration);
    verifyEvidenceRegistration(root, registration);
  }
  if (bindings.adapterRegistrations.registrations?.length !== Object.keys(config.commands).length) {
    fail('every configured command needs a qualified adapter');
  }
  for (const name of ['offlineQualificationReceipt', 'pretestEquivalenceReceipt',
    'controllerAndContainmentReceipts']) {
    if (bindings[name].status !== 'passed' || bindings[name].failures?.length !== 0) {
      fail(`qualification incomplete: ${name}`);
    }
  }
  const authorizations = bindings.runAuthorizations.authorizations;
  if (!Array.isArray(authorizations) || !authorizations.length) fail('no run authorizations');
  for (const authorization of authorizations) {
    contracts.validateRunAuthorization(authorization);
    if (authorization.baseCommitSha !== base) fail('authorization base mismatch');
  }
  verifyScenarioBindings(manifest, bindings, authorizations);
  const control = bindings.controllerAndContainmentReceipts;
  if (!control || typeof control !== 'object'
    || control.qualifiedLauncher !== true || !/^[a-f0-9]{64}$/.test(control.qualificationHash ?? '')
    || !/^[a-f0-9]{64}$/.test(control.launcherSha256 ?? '')
    || control.experimentSha256 !== bytesHash(Buffer.from(JSON.stringify(experiment)))
    || control.qualityPolicySha256 !== bytesHash(Buffer.from(JSON.stringify(manifest.qualityPolicy)))
    || control.roleDefinitionsSha256 !== bytesHash(Buffer.from(JSON.stringify(bindings.resolvedRoleDefinitions)))
    || control.qualificationHash !== controlQualificationHash(control)) {
    fail('missing/stale qualified launcher receipt');
  }
  verifyFile('/', { path: LAUNCHER.slice(1), sha256: control.launcherSha256 });
  if (control.allRoleEnforced !== true
    || control.deadlineEnforced !== true
    || control.spendEnforced !== true
    || control.containmentEnforced !== true) fail('missing control proof');
  return bindings;
}
