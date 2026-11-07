import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { brokerEvidenceSpawn, evidenceHandler } from './evidence-broker.mjs';

const RUN_ID = '2026-11-03-evidence-broker';
const NODE_BIN = process.execPath;
const STATE_DIR = 'state/runs';

function workspace(t, script) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-broker-')));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const worktree = path.join(root, STATE_DIR, RUN_ID, 'worktree');
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(path.join(root, 'outside'));
  fs.writeFileSync(path.join(worktree, 'adapter.mjs'), script);
  const sha256 = crypto.createHash('sha256').update(script).digest('hex');
  const registrations = [{ argv: [NODE_BIN, 'adapter.mjs'], bundleFiles: [{ path: 'adapter.mjs', sha256 }] }];
  return { root, worktree, registrations };
}

const request = (worktree, extra = {}) => ({ argv: [NODE_BIN, 'adapter.mjs'], cwd: worktree,
  stdin: Buffer.from('ping').toString('base64'), timeoutMs: 5000, env: { PATH: '/usr/bin', SECRET: 'x' }, ...extra });

test('evidence handler runs only frozen adapters inside the authorized run with a clean environment', async (t) => {
  const { root, worktree, registrations } = workspace(t,
    "process.stdin.on('data', d => process.stdout.write(d + ':' + Object.keys(process.env).sort()));");
  const handler = evidenceHandler({ root, stateDir: STATE_DIR, registrations, runId: RUN_ID });
  const result = await handler(request(worktree));
  assert.equal(Buffer.from(result.stdout, 'base64').toString(), 'ping:PATH');
  assert.equal(result.code, 0);
  await assert.rejects(handler(request(worktree, { argv: [NODE_BIN, 'other.mjs'] })), /not a frozen evidence adapter/);
  await assert.rejects(handler(request(path.join(root, 'outside'))), /escaped authorized run/);
  fs.appendFileSync(path.join(worktree, 'adapter.mjs'), '//');
  await assert.rejects(handler(request(worktree)), /file changed/);
});

test('evidence handler kills an adapter that exceeds its timeout', async (t) => {
  const { root, worktree, registrations } = workspace(t, 'setInterval(() => {}, 1000);');
  const result = await evidenceHandler({ root, stateDir: STATE_DIR, registrations, runId: RUN_ID })(request(worktree, { timeoutMs: 200 }));
  assert.equal(result.reason, 'timeout');
});

test('evidence handler refuses to start without a configured stateDir', (t) => {
  const { root, registrations } = workspace(t, '');
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
