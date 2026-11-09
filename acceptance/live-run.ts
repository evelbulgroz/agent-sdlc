import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAdmission } from './admission.ts';
import { acceptanceConfig } from './config.ts';
import { ExperimentLedger } from './experiment-ledger.ts';
import { RemoteExperimentLedger } from './experiment-broker.ts';
import { guardedCli, assertShellInvocation, superviseExperiment } from './supervisor.ts';
import { engineModule, fail, isMain, main } from './primitives.ts';
import { readAs, type AdmissionManifest } from './admission-types.ts';
import type { AcceptanceConfig, SandboxMount, SandboxSymlink } from './types.ts';

const SYSTEM_LINKS: [string, string][] = [['usr/bin', '/bin'], ['usr/lib', '/lib'], ['usr/lib64', '/lib64'], ['usr/sbin', '/sbin']];
// The engine's governor adapter keeps its run ledgers here, so the sandbox must leave it writable.
const MODEL_USAGE_DIR = 'tools/.model-usage';

const real = (file: string) => fs.realpathSync(file);

// Read-only closure for the child; only runtime state, run spec and review artifacts, git metadata and the governor state are writable.
export function sandboxLayout({ config, manifest, engine, modelUsage, machinePolicy, resolver = '/run/systemd/resolve/stub-resolv.conf' }: {
  config: AcceptanceConfig; manifest: Pick<AdmissionManifest, 'shared'>; engine: string; modelUsage: string;
  machinePolicy?: string | null | undefined; resolver?: string;
}): { readOnly: SandboxMount[]; writable: SandboxMount[]; symlinks: SandboxSymlink[] } {
  const root = real(config.root);
  const writableDirectories = [path.join(root, '.git'), path.join(root, config.stateDir), path.join(root, MODEL_USAGE_DIR),
    ...[config.runsDir, config.reviewDir].flatMap((directory) => directory ? [path.join(root, directory)] : []),
    path.resolve(root, manifest.shared.governorStateRoot)];
  for (const directory of writableDirectories) fs.mkdirSync(directory, { recursive: true });
  const same = (source: string, destination = source): SandboxMount => ({ source, destination });
  const readOnly = [same('/usr'), same('/etc/ssl'), same('/etc/ca-certificates'), same('/etc/hosts'),
    same('/etc/nsswitch.conf'), same(real(resolver), '/etc/resolv.conf'), same(real(engine)), same(real(modelUsage)),
    same(path.dirname(path.dirname(config.node))), same(root)];
  if (machinePolicy && fs.existsSync(machinePolicy)) readOnly.push(same(real(machinePolicy)));
  return {
    readOnly, writable: writableDirectories.map((directory) => same(real(directory))),
    symlinks: SYSTEM_LINKS.map(([target, destination]) => ({ target, destination })),
  };
}

export function childEnvironment({ engine, modelUsage, machinePolicy }: {
  engine: string; modelUsage: string; machinePolicy?: string | null | undefined;
}): Record<string, string> {
  return {
    PATH: '/usr/bin', AGENT_SDLC_PATH: real(engine), MODEL_USAGE_PATH: real(modelUsage),
    ...(machinePolicy ? { MODEL_USAGE_MACHINE_LOCAL_POLICY_PATH: machinePolicy } : {}),
  };
}

// Credentials pass through by name only when present; the host profile declares which names.
export function providerEnvironment(config: Pick<AcceptanceConfig, 'providerCredentials'>, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(config.providerCredentials.flatMap((key) => {
    const value = source[key];
    return value ? [[key, value]] : [];
  }));
}

export async function runLive({ config, manifestPath, scenario, argv, supervise = superviseExperiment, source = process.env }: {
  config: AcceptanceConfig; manifestPath: string; scenario: string; argv: string[];
  supervise?: typeof superviseExperiment; source?: NodeJS.ProcessEnv;
}) {
  const root = real(config.root);
  const manifest = readAs<AdmissionManifest>(manifestPath);
  const bindings = await verifyAdmission(root, config, manifest, { allowRunArtifacts: argv[1] !== 'start' });
  const configuration = bindings.routePricesAndReservationInventory.experiment;
  assertShellInvocation(argv, { runId: configuration.scenarios[scenario]?.runId,
    invocations: bindings.allowedCommandsAndEnvironment.scenarios?.[scenario]?.invocations,
    skipCanary: bindings.allowedCommandsAndEnvironment.scenarios?.[scenario]?.skipCanary });
  const engine = source.AGENT_SDLC_PATH, modelUsage = source.MODEL_USAGE_PATH;
  if (!engine || !modelUsage) fail('AGENT_SDLC_PATH and MODEL_USAGE_PATH are required');
  const machinePolicy = path.join(source.XDG_CONFIG_HOME || path.join(source.HOME ?? '', '.config'),
    'model-usage', 'local-policy.json');
  const keys = providerEnvironment(config, source);
  if (!Object.keys(keys).length) fail('no provider credentials available');
  const ledger = new ExperimentLedger(path.resolve(root, manifest.shared.reservationLedger), configuration);
  try {
    return await supervise({
      ledger, scenario, cwd: root,
      recipes: { root, config, reference: bindings.candidatePreparationManifests.scenarios[scenario].commandRecipes,
        registrations: bindings.adapterRegistrations.registrations },
      argv: [config.node, fileURLToPath(import.meta.url), '_child', path.resolve(manifestPath), scenario, ...argv],
      ...sandboxLayout({ config, manifest, engine, modelUsage, machinePolicy }),
      env: childEnvironment({ engine, modelUsage, machinePolicy: fs.existsSync(machinePolicy) ? machinePolicy : null }),
      privateEnv: keys,
    });
  } finally { ledger.close(); }
}

if (isMain(import.meta.url)) await main(async () => {
  const [command, manifestPath, scenario, ...argv] = process.argv.slice(2);
  const root = process.cwd();
  const { loadHostProfile } = await engineModule('host/host-profile');
  const config = acceptanceConfig(loadHostProfile(root), root);
  if (command === '_child') {
    const ledger = new RemoteExperimentLedger({ socketName: process.env.AGENT_SDLC_CANARY_BROKER_SOCKET,
      token: process.env.AGENT_SDLC_CANARY_BROKER_TOKEN, scenario });
    if (scenario !== process.env.AGENT_SDLC_CANARY_SCENARIO) fail('child scenario mismatch');
    const outcome = await guardedCli({ root, config, manifest: readAs<AdmissionManifest>(manifestPath), scenario, argv, ledger });
    // Mirror the engine CLI's own output contract, since runCli returns the outcome instead of printing it.
    process.stdout.write(`${argv.includes('--json') ? JSON.stringify(outcome.result) : outcome.human}\n`);
    if (!outcome.result?.ok) process.stderr.write(`${outcome.human}\n`);
    process.exitCode = outcome.exitCode ?? 1;
  } else if (command === 'run') {
    const result = await runLive({ config, manifestPath, scenario, argv });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.code ?? 1;
  } else fail('expected run');
});
