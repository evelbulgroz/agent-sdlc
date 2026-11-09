import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commandBindingHash, recordPins } from '../host/command-evidence.ts';
import { engineContracts } from './contracts.mjs';
import { validateRegistrations } from './registrations.mjs';

function tree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'registrations-')));
  fs.mkdirSync(path.join(root, 'pkg'));
  fs.writeFileSync(path.join(root, 'pkg/corpus.json'), '[]');
  const executable = { path: fs.realpathSync(process.execPath),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex') };
  const pins = recordPins(root, 'pkg', [{ file: 'corpus.json' }]);
  const argv = [executable.path, 'run.mjs'];
  const registration = { kind: 'command', adapterId: 'repo-unit', protocolVersion: '1.0.0', argv, cwd: 'pkg',
    reportFormat: 'junit', retries: 0, executable, pins, commandSha256: commandBindingHash(argv, executable.sha256, pins),
    profiles: [{ profileId: 'unit', layers: ['unit'], capabilities: [] }],
    limits: { timeoutMs: 1000, maxReportBytes: 1000, maxArtifactBytes: 1000, maxArtifacts: 1 } };
  return { root, registration };
}

test('a frozen command registration validates and reports its adapter id and binding hash', async (t) => {
  const { root, registration } = tree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contracts = await engineContracts();
  assert.deepEqual(await validateRegistrations(root, [registration]),
    [{ adapterId: 'repo-unit', bindingHash: contracts.sha256(registration) }]);
});

test('registrations fail closed on a changed pin or executable hash and on the removed executable shape', async (t) => {
  const { root, registration } = tree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'pkg/corpus.json'), '[1]');
  await assert.rejects(validateRegistrations(root, [registration]), /PINNED_FILE_MODIFIED/);
  fs.writeFileSync(path.join(root, 'pkg/corpus.json'), '[]');
  const wrongExecutable = { ...registration, executable: { ...registration.executable, sha256: 'a'.repeat(64) } };
  await assert.rejects(validateRegistrations(root, [wrongExecutable]), /frozen-adapter-file-changed/);
  const { kind, executable, pins, commandSha256, reportFormat, retries, cwd, ...rest } = registration;
  const legacy = { ...rest, bundleFiles: [{ path: 'tools/unit.mjs', sha256: 'a'.repeat(64) }], dependencyFiles: [],
    configurationFiles: [], qualificationArtifactHash: 'b'.repeat(64) };
  await assert.rejects(validateRegistrations(root, [legacy]));
});
