import fs from 'node:fs';
import path from 'node:path';
import { artifact } from './artifacts.mjs';
import { buildCommandRegistrations, runCommandInSandbox } from './command-evidence.mjs';
import { commandQualificationReceipt } from './command-qualification.mjs';
import { parseReport } from './report-formats.mjs';
import { writeJson } from './primitives.mjs';

const SENTINEL_LAYER = 'sentinel';

/** Sentinel registration: the declared command run as a layer of its own, never part of the live registrations. */
export async function sentinelRegistration(root, config) {
  const { planted, ...command } = config.sentinel;
  const [registration] = await buildCommandRegistrations(root, { ...config, commands: { [SENTINEL_LAYER]: command } });
  return { registration, planted };
}

/**
 * Offline, provider-free admission receipt for a command-only host. Runs the declared sentinel once in the same
 * sandbox as live evidence, then writes the receipt admission requires. Returns null when the host still uses runners.
 */
export async function qualifyCommands(root, config, { run = runCommandInSandbox } = {}) {
  if (Object.keys(config.runners).length || !Object.keys(config.commands).length) return null;
  const registrations = await buildCommandRegistrations(root, config);
  let sentinel;
  if (config.sentinel) {
    const { registration, planted } = await sentinelRegistration(root, config);
    const reportDirectory = path.join(root, config.output, 'offline', 'sentinel-report');
    fs.rmSync(reportDirectory, { recursive: true, force: true });
    fs.mkdirSync(reportDirectory, { recursive: true });
    const result = await run({ worktree: root, config, registration, baseSha: 'sentinel', reportDirectory: fs.realpathSync(reportDirectory),
      timeoutMs: registration.limits.timeoutMs });
    sentinel = { rows: parseReport(registration.reportFormat, result.reportBytes.toString('utf8')), exitCode: result.code, planted };
  }
  const receipt = commandQualificationReceipt({ registrations, sentinelDeclared: Boolean(config.sentinel), sentinel });
  writeJson(path.join(root, artifact(config, 'offlineQualification')), receipt);
  return receipt;
}
