import fs from 'node:fs';
import path from 'node:path';
import { artifact } from './artifacts.ts';
import { buildCommandRegistrations, runCommandInSandbox } from './command-evidence.ts';
import { commandQualificationReceipt } from './command-qualification.ts';
import { parseReport } from './report-formats.ts';
import { writeJson } from './primitives.ts';
import type { CommandRegistration } from '../policy/contracts/quality-evidence-schema.ts';
import type { SentinelRun } from './command-qualification.ts';
import type { AcceptanceConfig } from './types.ts';

const SENTINEL_LAYER = 'sentinel';

/** Sentinel registration: the declared command run as a layer of its own, never part of the live registrations. */
export async function sentinelRegistration(root: string, config: AcceptanceConfig): Promise<{ registration: CommandRegistration; planted: string }> {
  if (!config.sentinel) throw new Error('EvidenceAdmissionError: sentinel is not configured');
  const { planted, ...command } = config.sentinel;
  const [registration] = await buildCommandRegistrations(root, { ...config, commands: { [SENTINEL_LAYER]: command } });
  if (!registration) throw new Error('EvidenceAdmissionError: sentinel registration missing');
  return { registration, planted };
}

/**
 * Offline, provider-free admission receipt for a command-only host. Runs the declared sentinel once in the same
 * sandbox as live evidence, then writes the receipt admission requires. Returns null when no commands are configured.
 */
export async function qualifyCommands(root: string, config: AcceptanceConfig, { run = runCommandInSandbox }: { run?: typeof runCommandInSandbox } = {}) {
  if (!Object.keys(config.commands).length) return null;
  const registrations = await buildCommandRegistrations(root, config);
  let sentinel: SentinelRun | undefined;
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
  // writeJson refuses to replace a file, and a stale receipt from an earlier admission must not survive.
  const target = path.join(root, artifact(config, 'offlineQualification'));
  fs.rmSync(target, { force: true });
  writeJson(target, receipt);
  return receipt;
}
