import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { fail, verifyFile } from './primitives.mjs';

const MAX_REPORT_BYTES = 1048576;
const MAX_DIAGNOSTIC_BYTES = 65536;
const MAX_TIMEOUT_MS = 1800000;
const ADAPTER_ENV_KEYS = ['PATH', 'CI'];

function runAdapter({ argv, cwd, stdin, timeoutMs, env }) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, detached: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    let outBytes = 0, errBytes = 0, reason = null, done = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
    const timer = setTimeout(() => { reason = 'timeout'; kill(); }, timeoutMs);
    const finish = (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      kill();
      resolve({ code, signal, reason, stdout: Buffer.concat(out), stderr: Buffer.concat(err).subarray(0, MAX_DIAGNOSTIC_BYTES) });
    };
    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length;
      if (outBytes > MAX_REPORT_BYTES) { reason = 'report-byte-limit'; kill(); } else out.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (errBytes < MAX_DIAGNOSTIC_BYTES) err.push(chunk);
      errBytes += chunk.length;
    });
    child.stdin.on('error', () => {});
    child.once('error', () => { reason = 'process-error'; finish(null, null); });
    child.once('close', finish);
    child.stdin.end(stdin);
  });
}

// The engine runs inside the outer sandbox, where adapters cannot create their own namespaces, so the
// supervisor parent runs only the frozen, hash-verified adapters from the admitted registrations.
// stateDir is the repository-relative directory that holds per-run worktrees (the profile's stateDir).
export function evidenceHandler({ root, stateDir, registrations, runId, run = runAdapter }) {
  if (!stateDir) fail('stateDir is required');
  root = fs.realpathSync(root);
  return async ({ argv, cwd, stdin, timeoutMs, env }) => {
    if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string') || typeof cwd !== 'string'
      || typeof stdin !== 'string') fail('invalid evidence request');
    const registration = registrations.find((entry) => JSON.stringify(entry.argv) === JSON.stringify(argv));
    if (!registration) fail('command is not a frozen evidence adapter');
    const worktree = fs.realpathSync(cwd);
    if (!worktree.startsWith(`${path.join(root, stateDir, runId)}/`)) fail('evidence escaped authorized run');
    for (const file of registration.bundleFiles) verifyFile(worktree, file);
    const limit = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS;
    const safeEnv = Object.fromEntries(ADAPTER_ENV_KEYS.filter((key) => typeof env?.[key] === 'string')
      .map((key) => [key, env[key]]));
    const result = await run({ argv: registration.argv,
      cwd: worktree, stdin: Buffer.from(stdin, 'base64'), timeoutMs: limit, env: safeEnv });
    return { code: result.code, signal: result.signal, reason: result.reason,
      stdout: result.stdout.toString('base64'), stderr: result.stderr.toString('base64') };
  };
}

export function brokerEvidenceSpawn(ledger, runId, timeoutMs = MAX_TIMEOUT_MS) {
  return (command, args, options) => {
    const child = new EventEmitter();
    const stdout = new PassThrough(), stderr = new PassThrough(), chunks = [];
    Object.assign(child, { pid: undefined, exitCode: null, signalCode: null, stdout, stderr, kill: () => true });
    child.stdin = new Writable({
      write(chunk, _encoding, callback) { chunks.push(chunk); callback(); },
      final(callback) {
        callback();
        ledger.evidence({ runId, argv: [command, ...args], cwd: options.cwd, timeoutMs,
          stdin: Buffer.concat(chunks).toString('base64'), env: options.env }, timeoutMs).then((result) => {
          stdout.end(Buffer.from(result.stdout, 'base64'));
          stderr.end(Buffer.from(result.stderr, 'base64'));
          const code = result.reason ? null : result.code;
          child.exitCode = code;
          child.signalCode = result.signal;
          setImmediate(() => child.emit('close', code, result.signal ?? (result.reason ? 'SIGKILL' : null)));
        }, (error) => child.emit('error', error));
      },
    });
    return child;
  };
}
