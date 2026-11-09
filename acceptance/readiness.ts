import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { bytesHash, fail } from './primitives.ts';
import { readAs, type AdmissionConfig, type JsonRecord, type StatusRecord } from './admission-types.ts';
import { artifact } from './artifacts.ts';
import { BINDINGS } from './admission.ts';

const GATES = ['integrationPreflightReceipt', 'implementationApprovalReceipt', 'liveApprovalReceipt'];

// Candidate existing artifact per admission binding; null means no standing producer (it is built per run).
export function candidates(config: AdmissionConfig): Record<string, string | null> {
  if (!config.canary) fail('acceptanceEvidence.canary is not configured');
  return {
    engineBuildAndDependencies: null,
    hostProfile: '.agents/sdlc-host.json',
    runtimeInventory: artifact(config, 'runtimeInventory'),
    adapterRegistrations: artifact(config, 'adapterRegistrations'),
    pretestEquivalenceReceipt: artifact(config, 'pretestQualification'),
    canonicalPreflightClosure: artifact(config, 'preflightBootstrap'),
    candidatePreparationManifests: artifact(config, 'executionManifest'),
    corpusAndExpectedOutcomes: config.canary.corpus,
    offlineQualificationReceipt: artifact(config, 'offlineQualification'),
    semanticQualificationPackets: null,
    caseIdentityMap: config.caseManifest,
    approvedRunSpecsAndTaskPlans: null,
    resolvedGovernorPolicyAndRoutes: artifact(config, 'governorResolution'),
    resolvedRoleDefinitions: artifact(config, 'roleDefinitions'),
    promptFitMeasurements: null,
    routePricesAndReservationInventory: null,
    controllerAndContainmentReceipts: null,
    allowedCommandsAndEnvironment: null,
    artifactOwnershipAndRetention: null,
    runAuthorizations: null,
  };
}

export function readiness(root: string, config: AdmissionConfig): JsonRecord {
  const known = candidates(config);
  const rows = [...BINDINGS, ...GATES].map((name) => {
    const relative = known[name];
    if (!relative) return { name, state: 'no-producer' };
    const file = `${root}/${relative}`;
    if (!fs.existsSync(file)) return { name, state: 'missing', candidate: relative };
    if (fs.statSync(file).isDirectory()) return { name, state: 'directory-unbound', candidate: relative };
    const record = readAs<StatusRecord>(file);
    return { name, state: record.status && record.status !== 'passed' ? `status:${record.status}` : 'present',
      candidate: relative, schemaVersion: record.schemaVersion ?? null, sha256: bytesHash(fs.readFileSync(file)) };
  });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' }).trim() !== '';
  return { head, dirty, ready: rows.every((row) => row.state === 'present') && !dirty, rows };
}
