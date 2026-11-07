import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bytesHash, fail, readJson, writeJson } from './primitives.mjs';
import { admissionIdentity, artifact } from './artifacts.mjs';
import { allowedPaths } from './run-authorization.mjs';
import { scenarioRecords } from './live-records.mjs';

// Proposal only: assembly keeps the manifest BLOCKED, and the approval receipts stay operator-authored.
export function buildProposal(root, config, { runDir, engine, roles }) {
  if (!config.canary) fail('acceptanceEvidence.canary is not configured');
  if (!config.preflightResult) fail('acceptanceEvidence.preflightResult is not configured');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const head = git('rev-parse', 'HEAD');
  const dir = path.dirname(runDir);
  const records = `${runDir}/records`;
  const relative = (file) => path.relative(root, path.resolve(root, file));
  const hash = (file) => bytesHash(fs.readFileSync(path.resolve(root, file)));
  const reference = (file) => ({
    path: relative(file), sha256: hash(file),
    ...(file.endsWith('.json') ? { schemaVersion: readJson(path.resolve(root, file)).schemaVersion } : {}),
  });
  const created = (name, value) => {
    const file = `${records}/${name}.json`;
    writeJson(path.resolve(root, file), value);
    return reference(file);
  };
  const { spec, tasks, corpus } = config.canary;
  const preflight = readJson(path.join(root, config.preflightResult));
  if (preflight.gitHeadSha !== head) fail('preflight result is not for HEAD');
  const gate = created('integrationPreflightReceipt', {
    schemaVersion: '1.0.0', baseCommitSha: head,
    status: preflight.status === 'OK' && preflight.canonical === true && preflight.exitCode === 0
      && !preflight.skippedGates?.length ? 'passed' : 'failed',
    source: reference(config.preflightResult),
  });
  const pretestFile = artifact(config, 'pretestQualification');
  const pretest = readJson(path.resolve(root, pretestFile));
  const pretestFailures = pretest.status === 'passed' && pretest.liveQualified === false ? [] : ['pretest not passed'];
  const live = scenarioRecords(root, config, { runDir, spec, tasks, reference,
    commands: readJson(path.resolve(root, `${records}/allowedCommandsAndEnvironment.json`)) });
  const quality = readJson(path.resolve(root, `${runDir}/quality-policy.json`));
  const experiment = readJson(path.resolve(root, `${runDir}/experiment.json`)).experiment;
  const identity = admissionIdentity(config);
  return {
    manifestVersion: identity.manifestVersion, admission: 'BLOCKED',
    experimentId: identity.experimentId, hostRoot: fs.realpathSync(root), repositoryId: identity.repositoryId,
    engineCommit: git('-C', engine, 'rev-parse', 'HEAD'), integrationBaseCommit: head,
    integrationPreflightReceipt: gate, implementationApprovalReceipt: null, liveApprovalReceipt: null,
    installationCommands: [], downloadsAllowed: false, runtimePackaging: 'vendored-repository-relative-regular-files',
    nodeExecutable: config.node,
    bindings: {
      nodeExecutableSha256: bytesHash(fs.readFileSync(config.node)),
      engineBuildAndDependencies: reference(`${records}/engineBuildAndDependencies.json`),
      hostProfile: reference('.agents/sdlc-host.json'),
      runtimeInventory: reference(artifact(config, 'runtimeInventory')),
      adapterRegistrations: reference(`${dir}/adapter-registrations.json`),
      pretestEquivalenceReceipt: created('pretestEquivalenceReceipt', {
        schemaVersion: '1.0.0', status: pretest.status, failures: pretestFailures, source: reference(pretestFile),
      }),
      canonicalPreflightClosure: created('canonicalPreflightClosure', {
        schemaVersion: '1.0.0', bootstrap: reference(artifact(config, 'preflightBootstrap')),
      }),
      candidatePreparationManifests: created('candidatePreparationManifests', {
        schemaVersion: '1.0.0', ...live.preparation }),
      corpusAndExpectedOutcomes: reference(corpus),
      offlineQualificationReceipt: reference(artifact(config, 'offlineQualification')),
      semanticQualificationPackets: reference(`${records}/semanticQualificationPackets.json`),
      caseIdentityMap: reference(config.caseManifest),
      approvedRunSpecsAndTaskPlans: created('approvedRunSpecsAndTaskPlans', {
        schemaVersion: '1.0.0', spec: reference(spec), tasks: reference(tasks), ...live.approved,
      }),
      resolvedGovernorPolicyAndRoutes: reference(`${dir}/governor-resolution.json`),
      resolvedRoleDefinitions: reference(roles),
      promptFitMeasurements: reference(`${runDir}/prompt-fit.json`),
      routePricesAndReservationInventory: reference(`${records}/routePricesAndReservationInventory.json`),
      controllerAndContainmentReceipts: reference(`${records}/controllerAndContainmentReceipts.json`),
      allowedCommandsAndEnvironment: created('allowedCommandsAndEnvironment.live', live.commands),
      artifactOwnershipAndRetention: reference(`${records}/artifactOwnershipAndRetention.json`),
      runAuthorizations: reference(`${runDir}/run-authorizations.json`),
    },
    shared: {
      maxPhysicalCalls: experiment.physicalCalls, maxInputTokens: experiment.inputTokens,
      maxOutputTokens: experiment.outputTokens, maxCostMicrousd: experiment.costMicrousd,
      maxElapsedMs: experiment.maxElapsedMs, startsAt: null, deadline: null,
      governorStateRoot: `${dir}/governor`, reservationLedger: `${dir}/experiment.sqlite`,
      unknownUsage: 'charge-full-reservation', concurrency: 1,
    },
    qualityPolicy: quality, allowedPackages: [config.packageRoot], allowedPathPrefixes: allowedPaths(config),
    allowedOperations: {
      editIsolatedWorktree: true, runAllowlistedCommands: true, createDetachedWorktree: true,
      createBranch: false, createLocalCommits: false, push: false, openPullRequest: false, merge: false, deploy: false,
    },
    targetBranch: null, maxSemanticRepairs: 2, correctionPreauthorized: false,
    internalSnapshotObjectsAllowed: true, mergeCanary: false,
  };
}
