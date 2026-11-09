import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acceptanceConfig } from './config.mjs';
import { artifact } from './artifacts.mjs';
import { scenarioRecords, shellInvocations, verifyScenarioBindings } from './live-records.mjs';

const config = acceptanceConfig({ profileId: 'p', repositoryId: 'r', stateDir: 'state', reviewDir: 'rev', runsDir: 'runs',
  acceptanceEvidence: {
    canaryId: 'c1', slug: 'healthy', evidenceDir: 'ev', runtimeDir: 'rt', helpersDir: 'h', nodeExecutable: '/usr/bin/node',
    caseManifest: 'cm.json', runtimeSources: 'rs.json', package: { root: 'pkg' }, sandbox: { readOnlyBinds: [] },
    commands: { unit: { argv: ['/usr/bin/node', 'u'] } },
    canary: { spec: 's.md', tasks: 't.json', corpus: 'c.json', obligations: 'o.json', providerCredentials: ['KEY_A'],
      files: [{ path: 'pkg/a.spec.ts', kind: 'unit' }] } } }, '/repo');

test('artifact names are engine-owned, unversioned and unknown names fail', () => {
  assert.equal(artifact(config, 'executionManifest'), 'ev/c1/execution.json');
  assert.equal(artifact(config, 'offlineQualification'), 'ev/c1/offline/offline-qualification.json');
  assert.throws(() => artifact(config, 'nope'), /unknown artifact/);
});

test('shell invocations are the exact guarded set, bound to the run, slug and response files', () => {
  const calls = shellInvocations(config, { runId: 'd-healthy', spec: 's.md', tasks: 't.json' });
  assert.equal(calls.length, 7);
  assert.deepEqual(calls[0].slice(0, 7), ['shell', 'start', '--goal-file', 's.md', '--task-plan-file', 't.json', '--slug']);
  assert.equal(calls[0][7], 'healthy');
  assert.ok(calls[5].includes('ev/c1/responses/envelope.json'));
  assert.ok(calls.slice(2, 5).every((call) => call.includes('d-healthy') || call[0] === 'shell'));
});

function runDir(runId, authorizationRunId = runId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-records-'));
  const dir = 'run';
  fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, dir, 'run-authorizations.json'), JSON.stringify({ authorizations: [{ runId: authorizationRunId, approvedSpecHash: 'h' }] }));
  fs.writeFileSync(path.join(root, dir, 'experiment.json'), JSON.stringify({ experiment: { scenarios: { healthy: { runId } } } }));
  return { root, dir };
}
const reference = (file) => ({ path: file, sha256: 'x' });

test('scenario records bind authorization, orchestrator scope and engine-owned artifacts', () => {
  const { root, dir } = runDir('d-healthy');
  const records = scenarioRecords(root, config, { runDir: dir, spec: 's.md', tasks: 't.json', reference, commands: { base: 1 } });
  assert.equal(records.scenario, 'healthy');
  assert.equal(records.approved.scenarios.healthy.approvedSpecHash, 'h');
  assert.equal(records.preparation.scenarios.healthy.runtimeInventory.path, 'ev/c1/runtime.inventory.json');
  assert.deepEqual(records.commands.orchestrator.providerCredentials, ['KEY_A']);
  assert.deepEqual(records.commands.orchestrator.writable, ['.git', 'state', 'tools/.model-usage', 'runs', 'rev', 'governorStateRoot']);
  assert.equal(records.commands.base, 1);
  const mismatched = runDir('d-healthy', 'other');
  assert.throws(() => scenarioRecords(mismatched.root, config, { runDir: mismatched.dir, spec: 's.md', tasks: 't.json', reference, commands: {} }),
    /does not match experiment/);
  const wrongSlug = runDir('d-other');
  assert.throws(() => scenarioRecords(wrongSlug.root, config, { runDir: wrongSlug.dir, spec: 's.md', tasks: 't.json', reference, commands: {} }),
    /does not match experiment/);
});

test('scenario bindings fail closed on mismatch, missing preparation, missing invocations and escaping state', () => {
  const experiment = { scenarios: { healthy: { runId: 'd-healthy' } } };
  const good = () => ({
    manifest: { shared: { governorStateRoot: 'g', reservationLedger: 'l.sqlite' } },
    bindings: { routePricesAndReservationInventory: { experiment },
      approvedRunSpecsAndTaskPlans: { scenarios: { healthy: { runId: 'd-healthy', approvedSpecHash: 'h' } } },
      candidatePreparationManifests: { scenarios: { healthy: { runtimeInventory: {}, commandRecipes: {}, dependencyManifests: [] } } },
      allowedCommandsAndEnvironment: { scenarios: { healthy: { invocations: [['x']] } } } },
    authorizations: [{ runId: 'd-healthy', approvedSpecHash: 'h' }],
  });
  const run = ({ manifest, bindings, authorizations }) => verifyScenarioBindings(manifest, bindings, authorizations);
  run(good());
  const mutations = [
    [(c) => { c.authorizations[0].approvedSpecHash = 'z'; }, /authorization mismatch/],
    [(c) => { c.authorizations = []; }, /authorization mismatch/],
    [(c) => { delete c.bindings.candidatePreparationManifests.scenarios.healthy.commandRecipes; }, /preparation missing/],
    [(c) => { c.bindings.allowedCommandsAndEnvironment.scenarios.healthy.invocations = []; }, /invocations missing/],
    [(c) => { c.manifest.shared.governorStateRoot = '../g'; }, /repository-relative/],
    [(c) => { c.manifest.shared.reservationLedger = '/abs'; }, /repository-relative/],
  ];
  for (const [mutate, pattern] of mutations) {
    const candidate = good();
    mutate(candidate);
    assert.throws(() => run(candidate), pattern);
  }
});
