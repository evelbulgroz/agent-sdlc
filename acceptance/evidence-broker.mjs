import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import os from 'node:os';
import { fail } from './primitives.mjs';
import { casesFromReport, runCommandInSandbox } from './command-evidence.mjs';

const MAX_TIMEOUT_MS = 1800000;

// The engine runs inside the outer sandbox, where adapters cannot create their own namespaces, so the
// supervisor parent runs only the frozen, hash-verified adapters from the admitted registrations.
// stateDir is the repository-relative directory that holds per-run worktrees (the profile's stateDir).
export function evidenceHandler({ root, stateDir, registrations, runId, config, runCommand = runCommandInSandbox }) {
  if (!stateDir) fail('stateDir is required');
  root = fs.realpathSync(root);
  return async ({ argv, cwd, stdin, timeoutMs, env }) => {
    if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string') || typeof cwd !== 'string'
      || typeof stdin !== 'string') fail('invalid evidence request');
    const registration = registrations.find((entry) => JSON.stringify(entry.argv) === JSON.stringify(argv));
    if (!registration) fail('command is not a frozen evidence adapter');
    const worktree = fs.realpathSync(cwd);
    if (!worktree.startsWith(`${path.join(root, stateDir, runId)}/`)) fail('evidence escaped authorized run');
    const limit = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS;
    if (!config) fail('command evidence requires the acceptance config');
    const reportDirectory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sdlc-report-'));
    try {
      const { baseSha } = JSON.parse(Buffer.from(stdin, 'base64').toString('utf8'));
      const result = await runCommand({ worktree, config, registration, baseSha, reportDirectory,
        timeoutMs: Math.min(limit, registration.limits.timeoutMs) });
      return { code: result.code, signal: null, reason: null, stdout: result.reportBytes.toString('base64'),
        stderr: Buffer.from(result.stderr ?? '').toString('base64') };
    } finally { fs.rmSync(reportDirectory, { recursive: true, force: true }); }
  };
}

export function brokerEvidenceSpawn(ledger, runId, timeoutMs = MAX_TIMEOUT_MS) {
  const spawnEvidence = (command, args, options) => {
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
  spawnEvidence.runCommand = brokerCommandRunner(ledger, runId, timeoutMs);
  return spawnEvidence;
}

// Engine-child side of command evidence: asks the supervisor for report bytes, then parses them here.
export function brokerCommandRunner(ledger, runId, timeoutMs = MAX_TIMEOUT_MS) {
  return async (registration, request, worktreeDir) => {
    const result = await ledger.evidence({ runId, argv: registration.argv, cwd: worktreeDir, timeoutMs, env: {},
      stdin: Buffer.from(JSON.stringify({ baseSha: request.binding.baseCommitSha })).toString('base64') }, timeoutMs);
    if (result.reason) return { exitCode: null, cases: [], reportBytes: Buffer.alloc(0), failureReason: result.reason };
    const reportBytes = Buffer.from(result.stdout, 'base64');
    const selected = [...new Set(request.obligations.map((obligation) => obligation.caseId))];
    return { exitCode: result.code, reportBytes,
      cases: casesFromReport({ registration, selected, code: result.code, reportBytes }) };
  };
}
