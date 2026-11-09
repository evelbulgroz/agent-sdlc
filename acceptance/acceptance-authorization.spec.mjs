import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acceptanceConfig } from './config.ts';
import { allowedPaths, buildQualityPlan, loadObligations } from './run-authorization.ts';

const CANARY = { spec: 'spec.md', tasks: 'tasks.json', corpus: 'corpus.json', obligations: 'obligations.json',
  files: [{ path: 'pkg/a.spec.ts', kind: 'unit' }, { path: 'pkg/b.spec.ts', kind: 'browser' }] };
const config = acceptanceConfig({ profileId: 'p', repositoryId: 'r', acceptanceEvidence: {
  canaryId: 'c1', slug: 's', evidenceDir: 'ev', runtimeDir: 'rt', helpersDir: 'h', nodeExecutable: '/usr/bin/node',
  caseManifest: 'cm.json', runtimeSources: 'rs.json', package: { root: 'pkg' }, sandbox: { readOnlyBinds: [] },
  commands: { unit: { argv: ['/usr/bin/node', 'u'] }, browser: { argv: ['/usr/bin/node', 'b'] } },
  canary: CANARY } }, '/repo');

const row = (overrides = {}) => ({ criterionId: 'AC-01', caseId: 'AC-01.1', caseKey: 'case-one', taskId: 't1', layer: 'unit',
  profileId: 'unit', capabilities: [], file: 'pkg/a.spec.ts', observableOutcome: 'o', setupAction: 's', expectedResult: 'e', ...overrides });

function withObligations(rows, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obligations-'));
  fs.writeFileSync(path.join(root, 'obligations.json'), JSON.stringify(rows));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('allowed paths are exactly the configured canary files', () => {
  assert.deepEqual(allowedPaths(config), ['pkg/a.spec.ts', 'pkg/b.spec.ts']);
  assert.throws(() => allowedPaths({ ...config, canary: null }), /canary is not configured/);
});

test('obligations load only when closed, unique and bound to configured files and commands', () => {
  withObligations([row(), row({ caseKey: 'case-two', file: 'pkg/b.spec.ts', profileId: 'browser', layer: 'browser' })],
    (root) => assert.equal(loadObligations(root, config).length, 2));
  for (const [rows, pattern] of [
    [[], /non-empty/],
    [[{ ...row(), extra: 1 }], /invalid obligation keys/],
    [[row({ expectedResult: '' })], /invalid obligation$/],
    [[row({ file: 'pkg/other.ts' })], /not a configured canary file/],
    [[row({ profileId: 'missing' })], /not a configured command/],
    [[row(), row()], /duplicate obligation/],
  ]) withObligations(rows, (root) => assert.throws(() => loadObligations(root, config), pattern));
});

test('quality plan binds each obligation to its command registration hash', () => {
  const registrations = [{ profiles: [{ profileId: 'unit' }], id: 1 }];
  const contracts = { sha256: (entry) => `hash-${entry.id}` };
  const plan = buildQualityPlan(contracts, { policy: { p: 1 }, registrations, obligations: [row()] });
  assert.deepEqual(plan.evidenceObligations[0].testCases, [{ file: 'pkg/a.spec.ts', caseKey: 'case-one' }]);
  assert.equal(plan.evidenceObligations[0].adapterBindingHash, 'hash-1');
  assert.equal(plan.evidenceObligations[0].owner.id, 't1');
});
