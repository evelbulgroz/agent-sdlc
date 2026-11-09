import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fail } from './primitives.ts';

interface PreflightOptions {
  cwd?: string;
  encoding?: BufferEncoding;
  timeout?: number;
}

interface PreflightRun {
  root: string;
  stateDir: string;
  node: string;
  preflight: readonly string[] | null | undefined;
  runId: string;
  baseCommitSha: string;
  args: readonly string[];
  options?: PreflightOptions;
  exec?: (command: string, args: readonly string[], options: object) => string | Buffer;
}

const TOOL_PATHS = ['MODEL_USAGE_PATH', 'AGENT_SDLC_PATH'];
const PREFLIGHT_TIMEOUT_MS = 1_500_000;

// `preflight` is the host-declared argv prefix ending in the base flag (e.g. [cmd, ...args, '--base']); the engine's
// canonical preflight verifier invokes exactly that prefix followed by one 40-hex base commit.
export const isCanonicalPreflight = (command: unknown, args: unknown, preflight: readonly string[] | null | undefined): preflight is readonly string[] => Array.isArray(preflight) && preflight.length > 1
  && command === preflight[0] && Array.isArray(args) && args.length === preflight.length
  && args.slice(0, -1).join(' ') === preflight.slice(1).join(' ')
  && /^[a-f0-9]{40}$/.test(args.at(-1));

// Runs the host's own canonical preflight with a minimal environment: no provider credentials, only tool locations.
// `stateDir` is the profile's repository-relative state directory; `node` is its absolute node executable.
export function runCanonicalPreflight({ root, stateDir, node, preflight, runId, baseCommitSha, args, options = {}, exec = execFileSync }: PreflightRun): string | Buffer {
  if (!isCanonicalPreflight(preflight?.[0], args, preflight)) fail('not the canonical preflight command');
  if (args.at(-1) !== baseCommitSha) fail('preflight base differs from the authorized base commit');
  const worktree = fs.realpathSync(options.cwd as string);
  if (!worktree.startsWith(`${path.join(root, stateDir, runId)}/`)) fail('command escaped authorized run');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-home-'));
  try {
    return exec(preflight[0], args, {
      cwd: worktree,
      env: { PATH: `${path.dirname(node)}:/usr/local/bin:/usr/bin:/bin`, HOME: home, TMPDIR: home, LANG: 'C.UTF-8', CI: '1',
        ...Object.fromEntries(TOOL_PATHS.filter(key => process.env[key]).map(key => [key, process.env[key]])) },
      encoding: options.encoding ?? 'utf8',
      timeout: Math.min(PREFLIGHT_TIMEOUT_MS, options.timeout ?? PREFLIGHT_TIMEOUT_MS),
      killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
