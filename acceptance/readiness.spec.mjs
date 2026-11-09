import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { acceptanceConfig } from './config.ts';
import { artifact } from './artifacts.ts';
import { candidates, readiness } from './readiness.ts';

const config = acceptanceConfig({ profileId: 'p', repositoryId: 'repo', stateDir: 'state',
  acceptanceEvidence: {
    canaryId: 'c1', slug: 'healthy', evidenceDir: 'ev', runtimeDir: 'rt', helpersDir: 'h', nodeExecutable: process.execPath,
    caseManifest: 'cm.json', runtimeSources: 'rs.json', package: { root: 'pkg' }, sandbox: { readOnlyBinds: [] },
    commands: { unit: { argv: [process.execPath, 'u'] } },
    canary: { spec: 's.md', tasks: 't.json', corpus: 'corpus.json', obligations: 'o.json', files: [{ path: 'pkg/a.spec.ts', kind: 'unit' }] } } }, '/repo');

test('candidates come from config and engine-owned artifact names', () => {
  const known = candidates(config);
  assert.equal(known.corpusAndExpectedOutcomes, 'corpus.json');
  assert.equal(known.caseIdentityMap, 'cm.json');
  assert.equal(known.runtimeInventory, artifact(config, 'runtimeInventory'));
  assert.equal(known.runAuthorizations, null);
  assert.throws(() => candidates({ ...config, canary: null }), /canary is not configured/);
});

test('readiness reports missing, unpassed and present candidates and a dirty tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), JSON.stringify(value));
  };
  write('corpus.json', { schemaVersion: '1.0.0' });
  write(artifact(config, 'pretestQualification'), { schemaVersion: '1.0.0', status: 'failed' });
  git('add', '.');
  git('-c', 'user.email=a@b', '-c', 'user.name=n', 'commit', '-qm', 'x');
  const clean = readiness(root, config);
  const state = (name) => clean.rows.find((row) => row.name === name).state;
  assert.equal(clean.dirty, false);
  assert.equal(clean.ready, false);
  assert.equal(state('corpusAndExpectedOutcomes'), 'present');
  assert.equal(state('pretestEquivalenceReceipt'), 'status:failed');
  assert.equal(state('caseIdentityMap'), 'missing');
  assert.equal(state('runAuthorizations'), 'no-producer');
  assert.equal(clean.rows.length, 23);
  fs.writeFileSync(path.join(root, 'stray'), 'x');
  assert.equal(readiness(root, config).dirty, true);
});
