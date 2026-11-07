import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acceptanceConfig } from './config.mjs';
import { buildRegistrations } from './registrations.mjs';

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const config = acceptanceConfig({ profileId: 'p', repositoryId: 'repo', acceptanceEvidence: {
  canaryId: 'c1', slug: 's', evidenceDir: 'ev', runtimeDir: 'rt', helpersDir: 'h', nodeExecutable: process.execPath,
  caseManifest: 'cm.json', runtimeSources: 'rs.json', package: { root: 'pkg' }, sandbox: { readOnlyBinds: [] },
  runners: {
    unit: { argv: [process.execPath, 'tools/unit.mjs'], bundleFiles: ['tools/unit.mjs', 'tools/shared.mjs'], config: 'unit.config.ts' },
    browser: { argv: [process.execPath, 'tools/browser.mjs'], bundleFiles: ['tools/browser.mjs'], config: 'b.config.ts',
      capabilities: ['native-browser'], timeoutMs: 300000 },
  } } }, '/repo');

function tree(receipt = { status: 'passed', liveQualified: false, providerOperations: 0 }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'registrations-'));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
    return { path: file, sha256: sha(text) };
  };
  for (const file of ['tools/unit.mjs', 'tools/shared.mjs', 'tools/browser.mjs', 'pkg/unit.config.ts', 'pkg/b.config.ts', 'ev/c1/execution.json']) write(file, file);
  const qualification = write('ev/c1/q.json', JSON.stringify(receipt));
  const execution = { adapters: ['unit', 'browser'].map((kind) => ({ kind, qualification })) };
  return { root, execution, dependencyManifest: write('ev/c1/deps.json', '{}') };
}

test('one registration per runner, taken from runner config', () => {
  const { root, execution, dependencyManifest } = tree();
  const [unit, browser] = buildRegistrations(root, config, { execution, dependencyManifest });
  assert.equal(unit.adapterId, 'repo-unit');
  assert.deepEqual(unit.bundleFiles.map((file) => file.path), ['tools/unit.mjs', 'tools/shared.mjs']);
  assert.deepEqual(unit.configurationFiles.map((file) => file.path), ['pkg/unit.config.ts', 'ev/c1/execution.json']);
  assert.deepEqual(unit.profiles, [{ profileId: 'unit', layers: ['unit'], capabilities: [] }]);
  assert.equal(unit.limits.timeoutMs, 120000);
  assert.deepEqual(browser.profiles[0].capabilities, ['native-browser']);
  assert.equal(browser.limits.timeoutMs, 300000);
  assert.deepEqual(browser.argv, [process.execPath, 'tools/browser.mjs']);
});

test('registration fails closed on a missing, unpassed or live-qualified receipt or a runner without config', () => {
  const good = tree();
  assert.throws(() => buildRegistrations(good.root, config, { execution: { adapters: [] }, dependencyManifest: good.dependencyManifest }),
    /missing adapter qualification: unit/);
  for (const receipt of [{ status: 'failed', liveQualified: false, providerOperations: 0 },
    { status: 'passed', liveQualified: true, providerOperations: 0 },
    { status: 'passed', liveQualified: false, providerOperations: 1 }]) {
    const bad = tree(receipt);
    assert.throws(() => buildRegistrations(bad.root, config, bad), /adapter qualification not passed: unit/);
  }
  const noConfig = { ...config, runners: { unit: { ...config.runners.unit, config: undefined } } };
  assert.throws(() => buildRegistrations(good.root, noConfig, good), /runner has no config: unit/);
});
