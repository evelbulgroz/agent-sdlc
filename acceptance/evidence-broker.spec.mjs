import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commandRegistrationFixture } from '../testing/command-registration-fixture.mjs';
import { brokerCommandRunner, brokerEvidenceSpawn, evidenceHandler } from './evidence-broker.mjs';

const RUN_ID = '2026-11-03-evidence-broker';
const NODE_BIN = process.execPath;
const STATE_DIR = 'state/runs';
const CONFIG = { canaryId: 'c1' };

function workspace(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-broker-')));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const worktree = path.join(root, STATE_DIR, RUN_ID, 'worktree');
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(path.join(root, 'outside'));
  const registrations = [commandRegistrationFixture({ argv: [NODE_BIN, 'run.mjs'], limits: { timeoutMs: 300, maxReportBytes: 1000, maxArtifactBytes: 1000, maxArtifacts: 1 } })];
  return { root, worktree, registrations };
}

const request = (worktree, extra = {}) => ({ argv: [NODE_BIN, 'run.mjs'], cwd: worktree,
  stdin: Buffer.from(JSON.stringify({ baseSha: 'b'.repeat(40) })).toString('base64'), timeoutMs: 5000, env: { PATH: '/usr/bin', SECRET: 'x' }, ...extra });

test('evidence handler runs only frozen command registrations inside the authorized run', async (t) => {
  const { root, worktree, registrations } = workspace(t);
  const calls = [];
  const runCommand = async (input) => {
    calls.push(input);
    return { code: 0, reportBytes: Buffer.from('<testsuites/>'), stderr: 'diag' };
  };
  const handler = evidenceHandler({ root, stateDir: STATE_DIR, registrations, runId: RUN_ID, config: CONFIG, runCommand });
  const result = await handler(request(worktree));
  assert.equal(Buffer.from(result.stdout, 'base64').toString(), '<testsuites/>');
  assert.equal(Buffer.from(result.stderr, 'base64').toString(), 'diag');
  assert.equal(result.code, 0);
  assert.deepEqual([calls[0].worktree, calls[0].baseSha, calls[0].registration, calls[0].config],
    [worktree, 'b'.repeat(40), registrations[0], CONFIG]);
  await assert.rejects(handler(request(worktree, { argv: [NODE_BIN, 'other.mjs'] })), /not a frozen evidence adapter/);
  await assert.rejects(handler(request(path.join(root, 'outside'))), /escaped authorized run/);
  assert.equal(calls.length, 1);
});

test('evidence handler clamps the run timeout to the frozen registration limit and needs the acceptance config', async (t) => {
  const { root, worktree, registrations } = workspace(t);
  let seen;
  const runCommand = async (input) => { seen = input.timeoutMs; return { code: 0, reportBytes: Buffer.alloc(0) }; };
  await evidenceHandler({ root, stateDir: STATE_DIR, registrations, runId: RUN_ID, config: CONFIG, runCommand })(request(worktree));
  assert.equal(seen, 300);
  await assert.rejects(evidenceHandler({ root, stateDir: STATE_DIR, registrations, runId: RUN_ID, runCommand })(request(worktree)),
    /requires the acceptance config/);
});

test('evidence handler refuses to start without a configured stateDir', (t) => {
  const { root, registrations } = workspace(t);
  assert.throws(() => evidenceHandler({ root, registrations, runId: RUN_ID }), /stateDir is required/);
});

test('brokered spawn presents the parent result as a child process', async () => {
  const seen = [];
  const ledger = { evidence: async (value) => {
    seen.push(value);
    return { code: 0, signal: null, reason: null, stdout: Buffer.from('{"ok":1}').toString('base64'), stderr: '' };
  } };
  const child = brokerEvidenceSpawn(ledger, RUN_ID, 1000)('/bin/node', ['a.mjs'], { cwd: '/w', env: { PATH: 'p' } });
  const out = [], closed = new Promise((resolve) => child.once('close', (code) => resolve(code)));
  child.stdout.on('data', (chunk) => out.push(chunk));
  child.stdin.end('input');
  assert.equal(await closed, 0);
  assert.equal(Buffer.concat(out).toString(), '{"ok":1}');
  assert.deepEqual([seen[0].runId, seen[0].argv, Buffer.from(seen[0].stdin, 'base64').toString()],
    [RUN_ID, ['/bin/node', 'a.mjs'], 'input']);
});

test('brokered command runner reports a supervisor failure reason without parsing a report', async () => {
  const ledger = { evidence: async () => ({ reason: 'timeout', code: null, stdout: '' }) };
  const result = await brokerCommandRunner(ledger, RUN_ID, 1000)(
    commandRegistrationFixture(), { binding: { baseCommitSha: 'b'.repeat(40) }, obligations: [] }, '/w');
  assert.deepEqual([result.exitCode, result.cases, result.failureReason], [null, [], 'timeout']);
});
