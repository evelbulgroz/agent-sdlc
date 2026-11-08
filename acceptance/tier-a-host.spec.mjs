import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadHostProfile } from '../host/host-profile.ts';
import { qualifyCommands, sentinelRegistration } from './command-admission.mjs';
import { assertPinsOutsideWriteScope, buildCommandRegistrations, casesFromReport, runCommandInSandbox } from './command-evidence.mjs';
import { commandQualificationReceipt } from './command-qualification.mjs';
import { acceptanceConfig } from './config.mjs';
import { parseReport } from './report-formats.mjs';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../testing/fixture-host-tier-a');

// A Tier A host is one profile plus data files and a plain `node --test` script; nothing here is engine-authored.
function hostRepo(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tier-a-host-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(FIXTURE, root, { recursive: true });
  // The sandbox needs a runtime directory with a sysroot; the host's own /usr and /lib64 stand in for a materialized one.
  fs.mkdirSync(path.join(root, 'runtime/sysroot'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runtime/node_modules'));
  fs.mkdirSync(path.join(root, 'pkg/node_modules'));
  fs.mkdirSync(path.join(root, 'evidence/canary-v1'), { recursive: true });
  for (const name of ['usr', 'lib64']) fs.symlinkSync(`/${name}`, path.join(root, 'runtime/sysroot', name));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '-f', '.');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', 'init');
  return root;
}

async function run(root, selected) {
  const config = acceptanceConfig(loadHostProfile(root), root);
  const [registration] = await buildCommandRegistrations(root, config);
  const reportDirectory = fs.realpathSync(path.join(root, config.output));
  const result = await runCommandInSandbox({ worktree: root, config, registration, baseSha: 'abc', reportDirectory, timeoutMs: 60000 });
  return { config, registration, result, cases: casesFromReport({ registration, selected, code: result.code, reportBytes: result.reportBytes }) };
}

test('@ac AC-01 @case AC-01.1 a profile, data files and a node:test script yield per-case evidence in the sandbox', async (t) => {
  const root = hostRepo(t);
  const { registration, result, cases } = await run(root, ['AC-01.1', 'AC-02.1']);
  assert.equal(registration.kind, 'command');
  assert.equal(registration.reportFormat, 'junit');
  assert.equal(result.code, 1);
  assert.deepEqual(cases.map(({ identity, outcome }) => [identity, outcome]), [['AC-01.1', 'passed'], ['AC-02.1', 'passed']]);
});

test('@ac AC-01 @case AC-01.2 a planted failing case is reported failed, so an always-green reporter is distinguishable', async (t) => {
  const root = hostRepo(t);
  const { cases } = await run(root, ['AC-01.2']);
  assert.equal(cases[0].outcome, 'failed');
});

test('@ac AC-06 @case AC-06.2 a case script inside the write scope fails admission', async (t) => {
  const root = hostRepo(t);
  const config = acceptanceConfig(loadHostProfile(root), root);
  const registrations = await buildCommandRegistrations(root, config);
  assert.doesNotThrow(() => assertPinsOutsideWriteScope(registrations, ['src']));
  assert.throws(() => assertPinsOutsideWriteScope(registrations, ['pkg']), /pinned file inside write scope/);
});

test('@ac AC-08 @case AC-08.2 the sentinel check accepts the planted failing case and rejects any other outcome in the receipt', async (t) => {
  const root = hostRepo(t);
  const { registration, result } = await run(root, ['AC-01.2']);
  const rows = parseReport(registration.reportFormat, result.reportBytes.toString('utf8'));
  const receipt = (planted, exitCode = result.code) => commandQualificationReceipt({
    registrations: [registration], sentinelDeclared: true, sentinel: { rows, exitCode, planted },
  });
  assert.equal(receipt('AC-01.2').status, 'passed');
  assert.equal(receipt('AC-01.1').status, 'blocked');
  assert.equal(receipt('AC-01.2', 0).status, 'blocked');
});

const configFor = (root, edit = (profile) => profile) => {
  const profile = structuredClone(loadHostProfile(root));
  return acceptanceConfig(edit(profile), root);
};
const receiptOf = (root, config) => JSON.parse(fs.readFileSync(path.join(root, config.output, 'offline/offline-qualification.json'), 'utf8'));

test('@ac AC-08 @case AC-08.3 admission runs the declared sentinel once and writes a passed receipt', async (t) => {
  const root = hostRepo(t);
  const config = configFor(root);
  const receipt = await qualifyCommands(root, config);
  assert.equal(receipt.status, 'passed');
  assert.deepEqual(receipt.sentinel, { planted: 'AC-99.1' });
  assert.equal(receiptOf(root, config).status, 'passed');
  assert.equal((await qualifyCommands(root, config)).status, 'passed');
});

test('@ac AC-08 @case AC-08.4 a sentinel that fails a different case than the planted one writes a blocked receipt', async (t) => {
  const root = hostRepo(t);
  const config = configFor(root, (profile) => {
    profile.acceptanceEvidence.sentinel.planted = 'AC-99.2';
    return profile;
  });
  const receipt = await qualifyCommands(root, config);
  assert.equal(receipt.status, 'blocked');
  assert.match(receipt.failures.join('\n'), /failed AC-99\.1/);
  assert.equal(receiptOf(root, config).status, 'blocked');
});

test('@ac AC-08 @case AC-08.5 a sentinel that exits zero writes a blocked receipt', async (t) => {
  const root = hostRepo(t);
  const config = configFor(root);
  const receipt = await qualifyCommands(root, config, { run: async (input) => ({ ...(await runCommandInSandbox(input)), code: 0 }) });
  assert.equal(receipt.status, 'blocked');
});

test('@ac AC-06 @case AC-06.4 a sentinel file inside the write scope fails admission', async (t) => {
  const root = hostRepo(t);
  const { registration } = await sentinelRegistration(root, configFor(root));
  assert.throws(() => assertPinsOutsideWriteScope([registration], ['pkg']), /pinned file inside write scope/);
});
