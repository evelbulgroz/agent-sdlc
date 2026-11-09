import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { acceptanceConfig } from './config.mjs';
import { LAUNCHER } from './primitives.mjs';
import { controlQualificationHash } from './experiment-budget.mjs';
import { commandsRecord, controlRecord, engineRecord, ownershipRecord, priceRecord, semanticPackets } from './admission-records.mjs';

const block = (extra = {}) => ({ profileId: 'p', repositoryId: 'r', stateDir: 'state', acceptanceEvidence: {
  canaryId: 'c1', slug: 's', evidenceDir: 'ev', runtimeDir: 'rt', helpersDir: 'h', nodeExecutable: process.execPath,
  caseManifest: 'cm.json', runtimeSources: 'rs.json', package: { root: 'pkg' }, sandbox: { readOnlyBinds: [] },
  commands: { unit: { argv: [process.execPath, 'u'] } },
  taskVerificationCommand: ['pm', 'run', 'lint'],
  canary: { spec: 's.md', tasks: 't.json', corpus: 'c.json', obligations: 'o.json', files: [{ path: 'pkg/a.spec.ts', kind: 'unit' }] },
  ...extra } });
const config = acceptanceConfig(block(), '/repo');

test('commands and ownership records come from config, and verification is required', () => {
  const record = commandsRecord(config, { x: 1 });
  assert.deepEqual(record.packages, ['pkg']);
  assert.deepEqual(record.allowedPathPrefixes, ['pkg/a.spec.ts']);
  assert.deepEqual(record.taskVerification, ['pm', 'run', 'lint']);
  assert.equal(record.launcher, LAUNCHER);
  assert.deepEqual(ownershipRecord(config), { ...ownershipRecord(config), evidenceRoot: 'ev/c1', runtimeRoot: 'state' });
  const bare = acceptanceConfig(block({ taskVerificationCommand: undefined }), '/repo');
  assert.throws(() => commandsRecord(bare, {}), /taskVerificationCommand is not configured/);
});

test('route prices fail closed on unpriced or absent live routes', () => {
  const route = (pricingStatus, enabled = true) => ({ routeId: 'a', provider: 'p', model: 'm', canonicalVendor: 'v', pricingStatus, enabled });
  const experiment = { dispatchInventory: [{ logicalCalls: 2, maxPhysicalAttempts: 3 }] };
  const governor = (routes) => ({ pricingVersion: '1', profiles: { 'critic-review': { routes } } });
  assert.equal(priceRecord(governor([route('known'), route('unknown', false)]), experiment).worstCaseAttempts, 6);
  assert.throws(() => priceRecord(governor([route('unknown')]), experiment), /unpriced live route/);
  assert.throws(() => priceRecord(governor([]), experiment), /unpriced live route/);
});

test('semantic packets freeze only expected outcomes of semantic cases', () => {
  const packets = semanticPackets({ cases: [{ id: 'a', kind: 'semantic', expected: 'x', secret: 1 }, { id: 'b', kind: 'other', expected: 'y' }] });
  assert.deepEqual(packets.cases, [{ id: 'a', expected: 'x' }]);
  assert.equal(packets.status, 'pending-live-qualification');
});

test('engine record pins the commit and refuses uncommitted tracked changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-record-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run('init', '-q');
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lock');
  run('add', '.');
  run('-c', 'user.email=a@b', '-c', 'user.name=n', 'commit', '-qm', 'x');
  const record = engineRecord(config, dir);
  assert.match(record.engineCommit, /^[0-9a-f]{40}$/);
  assert.equal(record.node, process.execPath);
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'changed');
  assert.throws(() => engineRecord(config, dir), /uncommitted tracked changes/);
});

test('control record runs the given specs and fails when one fails', { skip: !fs.existsSync(LAUNCHER) }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-record-'));
  fs.writeFileSync(path.join(dir, 'ok.spec.mjs'), "import test from 'node:test'; test('ok', () => {});");
  fs.writeFileSync(path.join(dir, 'bad.spec.mjs'), "import test from 'node:test'; test('bad', () => { throw new Error('x'); });");
  const input = { config, root: dir, experiment: { a: 1 }, policy: { b: 2 }, roles: { c: 3 } };
  const record = controlRecord({ ...input, specPaths: ['ok.spec.mjs'] });
  assert.equal(record.status, 'passed');
  assert.equal(record.qualificationHash, controlQualificationHash(record));
  assert.throws(() => controlRecord({ ...input, specPaths: ['bad.spec.mjs'] }));
});
