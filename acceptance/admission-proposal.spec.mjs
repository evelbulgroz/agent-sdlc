import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { acceptanceConfig } from './config.mjs';
import { artifact } from './artifacts.mjs';
import { buildProposal } from './admission-proposal.mjs';

const profile = (extra = {}) => ({ profileId: 'p', repositoryId: 'repo', stateDir: 'state', reviewDir: 'rev', runsDir: 'runs',
  acceptanceEvidence: {
    canaryId: 'c1', slug: 'healthy', evidenceDir: 'ev', runtimeDir: 'rt', helpersDir: 'h', nodeExecutable: process.execPath,
    caseManifest: 'cm.json', runtimeSources: 'rs.json', package: { root: 'pkg' }, sandbox: { readOnlyBinds: [] },
    commands: { unit: { argv: [process.execPath, 'u'] } }, preflightResult: 'pf.json',
    canary: { spec: 's.md', tasks: 't.json', corpus: 'c.json', obligations: 'o.json', files: [{ path: 'pkg/a.spec.ts', kind: 'unit' }] },
    ...extra } });

function fixture(preflight = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  git('init', '-q');
  write('seed', 'x');
  git('add', '.');
  git('-c', 'user.email=a@b', '-c', 'user.name=n', 'commit', '-qm', 'x');
  const head = git('rev-parse', 'HEAD');
  const config = acceptanceConfig(profile(), root);
  write('pf.json', { gitHeadSha: head, status: 'OK', canonical: true, exitCode: 0, ...preflight });
  for (const file of ['s.md', 't.json', 'c.json', 'cm.json', 'roles.json']) write(file, file.endsWith('.json') ? { schemaVersion: '1.0.0' } : 'spec');
  write('.agents/sdlc-host.json', { schemaVersion: '1.5.0' });
  for (const name of ['runtimeInventory', 'runtimeDependencies', 'executionManifest', 'caseMap', 'taskLintRecipe', 'isolatedQualification',
    'offlineQualification', 'preflightBootstrap']) write(artifact(config, name), { schemaVersion: '1.0.0' });
  write(artifact(config, 'pretestQualification'), { schemaVersion: '1.0.0', status: 'passed', liveQualified: false });
  write('out/adapter-registrations.json', { schemaVersion: '1.0.0' });
  write('out/governor-resolution.json', { schemaVersion: '1.0.0' });
  const run = 'out/run';
  write(`${run}/run-authorizations.json`, { authorizations: [{ runId: 'd-healthy', approvedSpecHash: 'h' }] });
  write(`${run}/experiment.json`, { experiment: { scenarios: { healthy: { runId: 'd-healthy' } },
    physicalCalls: 1, inputTokens: 2, outputTokens: 3, costMicrousd: 4, maxElapsedMs: 5 } });
  write(`${run}/quality-policy.json`, { schemaVersion: '1.0.0' });
  write(`${run}/prompt-fit.json`, { schemaVersion: '1.0.0' });
  for (const name of ['engineBuildAndDependencies', 'semanticQualificationPackets', 'routePricesAndReservationInventory',
    'controllerAndContainmentReceipts', 'artifactOwnershipAndRetention']) write(`${run}/records/${name}.json`, { schemaVersion: '1.0.0' });
  write(`${run}/records/allowedCommandsAndEnvironment.json`, { schemaVersion: '1.0.0' });
  return { root, config, head, input: { runDir: run, engine: root, roles: 'roles.json' } };
}

test('proposal is BLOCKED, identity is derived from config, and approvals stay unset', () => {
  const { root, config, head, input } = fixture();
  const proposal = buildProposal(root, config, input);
  assert.equal(proposal.admission, 'BLOCKED');
  assert.equal(proposal.manifestVersion, 'repo-c1-admission');
  assert.equal(proposal.experimentId, 'repo-c1-experiment');
  assert.equal(proposal.integrationBaseCommit, head);
  assert.equal(proposal.implementationApprovalReceipt, null);
  assert.equal(proposal.liveApprovalReceipt, null);
  assert.deepEqual(proposal.allowedPackages, ['pkg']);
  assert.deepEqual(proposal.allowedPathPrefixes, ['pkg/a.spec.ts']);
  assert.equal(proposal.bindings.runtimeInventory.path, 'ev/c1/runtime.inventory.json');
  assert.equal(proposal.bindings.caseIdentityMap.path, 'cm.json');
  assert.equal(proposal.integrationPreflightReceipt.path.endsWith('integrationPreflightReceipt.json'), true);
  assert.ok(Object.values(proposal.allowedOperations).filter((value) => value === true).length === 3);
  assert.equal(proposal.mergeCanary, false);
});

test('preflight receipt reflects the preflight outcome and must be for HEAD', () => {
  const failed = fixture({ skippedGates: ['lint'] });
  buildProposal(failed.root, failed.config, failed.input);
  const receipt = JSON.parse(fs.readFileSync(path.join(failed.root, 'out/run/records/integrationPreflightReceipt.json'), 'utf8'));
  assert.equal(receipt.status, 'failed');
  const stale = fixture({ gitHeadSha: 'deadbeef' });
  assert.throws(() => buildProposal(stale.root, stale.config, stale.input), /preflight result is not for HEAD/);
});

test('proposal requires the canary block and a configured preflight result', () => {
  const { root, input } = fixture();
  const bare = acceptanceConfig(profile({ preflightResult: undefined }), root);
  assert.throws(() => buildProposal(root, bare, input), /preflightResult is not configured/);
  const noCanary = acceptanceConfig(profile({ canary: undefined }), root);
  assert.throws(() => buildProposal(root, noCanary, input), /canary is not configured/);
});
