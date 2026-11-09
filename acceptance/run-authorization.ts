import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { engineModule, fail, readJson } from './primitives.ts';
import { engineContracts } from './contracts.ts';
import type { EvidenceContracts } from './contracts.ts';
import type { CommandRegistration } from '../policy/contracts/quality-evidence-schema.ts';
import type { AcceptanceConfig } from './types.ts';

export interface ObligationRow {
  caseId: string;
  caseKey: string;
  capabilities: string[];
  criterionId: string;
  expectedResult: string;
  file: string;
  layer: string;
  observableOutcome: string;
  profileId: string;
  setupAction: string;
  taskId: string;
}

const OBLIGATION_KEYS = ['caseId', 'caseKey', 'capabilities', 'criterionId', 'expectedResult', 'file', 'layer',
  'observableOutcome', 'profileId', 'setupAction', 'taskId'].sort();
const text = (value: unknown): boolean => typeof value === 'string' && value.length > 0;

// Repository-relative files the run may change: exactly the configured canary files.
export function allowedPaths(config: Pick<AcceptanceConfig, 'canary'>): string[] {
  if (!config.canary) fail('acceptanceEvidence.canary is not configured');
  return config.canary.files.map((file) => file.path);
}

// One evidence obligation per acceptance case, read from the host data file named by canary.obligations.
export function loadObligations(root: string, config: Pick<AcceptanceConfig, 'canary' | 'commands'>): ObligationRow[] {
  if (!config.canary) fail('acceptanceEvidence.canary is not configured');
  const rows = readJson(`${root}/${config.canary.obligations}`) as ObligationRow[];
  const files = new Set(allowedPaths(config));
  if (!Array.isArray(rows) || !rows.length) fail('obligations must be a non-empty array');
  const seen = new Set();
  for (const row of rows) {
    if (!row || Object.keys(row).sort().join() !== OBLIGATION_KEYS.join()) fail('invalid obligation keys');
    if (!(['criterionId', 'caseId', 'caseKey', 'taskId', 'layer', 'profileId', 'file', 'observableOutcome',
      'setupAction', 'expectedResult'] as (keyof ObligationRow)[]).every((key) => text(row[key]))
      || !Array.isArray(row.capabilities) || row.capabilities.some((entry) => !text(entry))) fail('invalid obligation');
    if (!files.has(row.file)) fail(`obligation file is not a configured canary file: ${row.file}`);
    if (!Object.hasOwn(config.commands, row.profileId)) fail(`obligation profile is not a configured command: ${row.profileId}`);
    if (seen.has(row.caseKey)) fail(`duplicate obligation: ${row.caseKey}`);
    seen.add(row.caseKey);
  }
  return rows;
}

export function buildQualityPlan(contracts: Pick<EvidenceContracts, 'sha256'>, { policy, registrations, obligations }: {
  policy: unknown;
  registrations: readonly CommandRegistration[];
  obligations: readonly ObligationRow[];
}) {
  const hashes = new Map(registrations.map((entry) => [(entry.profiles[0] as CommandRegistration['profiles'][number]).profileId, contracts.sha256(entry)]));
  const evidenceObligations = obligations.map((row) => ({
    obligationId: row.caseKey, criterionId: row.criterionId, caseId: row.caseId,
    owner: { kind: 'task', id: row.taskId }, observableOutcome: row.observableOutcome,
    setupAction: row.setupAction, expectedResult: row.expectedResult, layer: row.layer,
    requiredCapabilities: row.capabilities, implementationPaths: [row.file],
    testCases: [{ file: row.file, caseKey: row.caseKey }],
    adapterBindingHash: hashes.get(row.profileId), profileId: row.profileId,
  }));
  return { qualityPolicy: policy, adapterBindings: registrations, evidenceObligations };
}

export async function buildAuthorization(root: string, config: AcceptanceConfig, { spec, tasks, registrations, policy, obligations, runId, now }: {
  spec: string;
  tasks: string;
  registrations: readonly CommandRegistration[];
  policy: unknown;
  obligations: readonly ObligationRow[];
  runId: string;
  now: unknown;
}) {
  const contracts = await engineContracts();
  const { parseSpecification, parseTaskManifest, taskManifestHash, approvedInputHash } =
    await engineModule('workflow/specification');
  const { createDefaultAuthorizationEnvelope } = await engineModule('policy/authorization');
  const { attachApprovedQualityPlan } = await engineModule('policy/quality-planning');
  const draft = parseSpecification(fs.readFileSync(spec, 'utf8'));
  const manifest = parseTaskManifest(fs.readFileSync(tasks, 'utf8'));
  const manifestHash = taskManifestHash(manifest);
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const qualityPlan = buildQualityPlan(contracts, { policy, registrations, obligations });
  const authorization = createDefaultAuthorizationEnvelope({
    runId, approvedSpecHash: approvedInputHash(draft, manifestHash), taskManifestHash: manifestHash,
    rootDir: root, repositoryId: config.repositoryId, baseCommitSha: base, allowedPackages: [config.packageRoot],
    allowedPathPrefixes: allowedPaths(config), maxSemanticRepairs: 2, qualityPlan, now,
  });
  // Dry-run the engine's planner attach to prove obligations match the frozen criteria and tasks.
  attachApprovedQualityPlan({ schemaVersion: '1.0.0', runId, planPolicyHash: authorization.approvedPlanPolicyHash,
    baseCommitSha: base, slices: manifest.slices, tasks: manifest.tasks.map((task: { taskId: string }, index: number) => ({
      ...task, title: task.taskId, status: 'pending', integrationOrder: index,
      worktreeSubdir: `worktrees/${task.taskId}`, baseCommitSha: base, parentTreeSha: null,
      targetTreeSha: null, parentCommitSha: null, patchHash: null, failurePacketArtifact: null, repairCount: 0 })),
    integrationOrder: manifest.tasks.map((task: { taskId: string }) => task.taskId), isParallel: false,
    createdAt: authorization.approvedAt },
  authorization.qualityPlan, draft.acceptanceCriteria);
  return authorization;
}
