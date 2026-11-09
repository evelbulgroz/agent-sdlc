import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsFor, bytesHash, engineModule, fail, isMain, main, readJson, regularFile, writeJson } from './primitives.ts';
import type { CommandRegistration } from '../policy/contracts/quality-evidence-schema.ts';
import { readAs, type AdmissionManifest, type Corpus, type GovernorResolution, type JsonRecord } from './admission-types.ts';
import type { ExperimentConfiguration } from './experiment-types.ts';
import type { AcceptanceConfig } from './types.ts';
import { acceptanceConfig } from './config.ts';
import { artifact } from './artifacts.ts';
import { assembleManifest, verifyAdmission } from './admission.ts';
import { buildProposal } from './admission-proposal.ts';
import { buildAdmissionRecords } from './admission-records.ts';
import { buildCanaryExecution, buildCaseMap } from './canary-execution.ts';
import { readiness } from './readiness.ts';
import { qualifyCommands, sentinelRegistration } from './command-admission.ts';
import { assertPinsOutsideWriteScope, buildCommandRegistrations } from './command-evidence.ts';
import { validateRegistrations } from './registrations.ts';
import { allowedPaths, buildAuthorization, loadObligations } from './run-authorization.ts';
import { dependencyManifest, expandedInventory, materialize, type InventoryDocument, type SourcesDocument } from './runtime-inventory.ts';
import { writeExperimentFiles } from './experiment-config.ts';
import { resolveGovernorRecord } from './governor-resolution.ts';
import { measurePromptFit } from './prompt-fit.ts';
import { resolveRoleRecord } from './role-definitions.ts';
import { approveAdmission, regenerateAdmission } from './regenerate.ts';
import { verifyWorkspaceBootstrap } from './workspace-bootstrap.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The control record reruns these engine specs against the host, so the engine, not the host, owns them.
const CONTROL_SPECS = ['experiment', 'experiment-budget', 'admission'].map((name) => path.join(HERE, `${name}.spec.mjs`));

type Handler = (context: { root: string; config: AcceptanceConfig; argv: string[] }) => unknown;
type CommandName = 'admission-assemble' | 'admission-verify' | 'admission-proposal' | 'admission-records'
  | 'canary-execution' | 'readiness' | 'command-qualify' | 'registrations' | 'authorize' | 'governor-resolution'
  | 'role-definitions' | 'experiment-config' | 'prompt-fit' | 'admission-regenerate' | 'admission-approve'
  | 'workspace-bootstrap-verify' | 'runtime-inventory' | 'runtime-materialize' | 'runtime-dependencies';
type CriticRole = { roleId: string; requestedLimits: { maxPromptTokens: number } };

const readRecord = (file: string): JsonRecord => readJson(file) as JsonRecord;

const reference = (root: string, relative: string) => ({ path: relative, sha256: bytesHash(fs.readFileSync(regularFile(root, relative))) });

// Each handler receives the realpath'd host root, the acceptance config and the already-split argv.
const commands: Record<CommandName, Handler> = {
  'admission-assemble': ({ argv }) => {
    const args = argumentsFor(argv, ['--proposal', '--output']);
    const bytes = fs.readFileSync(args['--proposal']);
    writeJson(args['--output'], assembleManifest(JSON.parse(bytes.toString('utf8')), bytes));
  },
  'admission-verify': async ({ root, config, argv }) => {
    const args = argumentsFor(argv, ['--manifest']);
    await verifyAdmission(root, config, readAs<AdmissionManifest>(args['--manifest']));
    process.stdout.write('admission: verified\n');
  },
  'admission-proposal': ({ root, config, argv }) => {
    const args = argumentsFor(argv, ['--engine', '--run-dir', '--roles', '--output']);
    writeJson(args['--output'], buildProposal(root, config, { runDir: args['--run-dir'], engine: args['--engine'], roles: args['--roles'] }));
  },
  'admission-records': ({ root, config, argv }) => {
    const args = argumentsFor(argv, ['--engine', '--run-dir', '--output-dir', '--roles']);
    const runDir = args['--run-dir'];
    const { experiment } = readAs<{ experiment: ExperimentConfiguration }>(path.join(runDir, 'experiment.json'));
    const records = buildAdmissionRecords(config, root, {
      engineRoot: args['--engine'], experiment,
      governor: readAs<GovernorResolution>(path.join(path.dirname(runDir), 'governor-resolution.json')),
      policy: readRecord(path.join(runDir, 'quality-policy.json')),
      roles: readRecord(args['--roles']), corpus: readAs<Corpus>(path.join(root, config.caseManifest)),
      runtimeVerify: readRecord(path.join(root, '.agents/sdlc-host.json')).verify, specPaths: CONTROL_SPECS,
    });
    for (const [name, record] of Object.entries(records)) writeJson(path.join(args['--output-dir'], `${name}.json`), record);
    process.stdout.write(`${Object.keys(records).join('\n')}\n`);
  },
  'canary-execution': ({ root, config, argv }) => {
    const args = argumentsFor(argv, ['--source']);
    const caseMap = artifact(config, 'caseMap'), output = artifact(config, 'executionManifest');
    writeJson(path.join(root, caseMap), buildCaseMap(config, loadObligations(root, config)));
    const source = readRecord(regularFile(root, args['--source']));
    writeJson(path.join(root, output), buildCanaryExecution(source, reference(root, caseMap)));
    process.stdout.write(`canary execution: ${output}\n`);
  },
  readiness: ({ root, config }) => {
    const report = readiness(root, config);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ready) process.exitCode = 1;
  },
  'command-qualify': async ({ root, config }) => {
    const receipt = await qualifyCommands(root, config);
    if (!receipt) return process.stdout.write('command qualification: not applicable (no commands configured)\n');
    process.stdout.write(`command qualification: ${receipt.status}${receipt.failures.length ? `\n${receipt.failures.join('\n')}` : ''}\n`);
    if (receipt.status !== 'passed') process.exitCode = 1;
  },
  registrations: async ({ root, config, argv }) => {
    const args = argumentsFor(argv, ['--output']);
    const commandRegistrations = await buildCommandRegistrations(root, config);
    assertPinsOutsideWriteScope([...commandRegistrations, ...(config.sentinel ? [(await sentinelRegistration(root, config)).registration] : [])], allowedPaths(config));
    const registrations = commandRegistrations;
    const bindings = await validateRegistrations(root, registrations);
    writeJson(args['--output'], { schemaVersion: '1.0.0', registrations });
    process.stdout.write(`${JSON.stringify(bindings, null, 2)}\n`);
  },
  authorize: async ({ root, config, argv }) => {
    const args = argumentsFor(argv, ['--spec', '--tasks', '--registrations', '--quality-policy', '--run-id', '--output']);
    const authorization = await buildAuthorization(root, config, {
      runId: args['--run-id'], spec: args['--spec'], tasks: args['--tasks'], registrations: readRecord(args['--registrations']).registrations as CommandRegistration[],
      policy: readRecord(args['--quality-policy']), obligations: loadObligations(root, config), now: new Date(),
    });
    writeJson(args['--output'], { schemaVersion: '1.0.0', authorizations: [authorization],
      specSha256: bytesHash(fs.readFileSync(args['--spec'])), tasksSha256: bytesHash(fs.readFileSync(args['--tasks'])) });
    process.stdout.write(`authorization ok base=${authorization.baseCommitSha}\n`);
  },
  'governor-resolution': async ({ argv }) => {
    const args = argumentsFor(argv, ['--output']);
    const record = await resolveGovernorRecord();
    writeJson(args['--output'], record);
    process.stdout.write(`governor: ${record.status}\n`);
    if (record.status !== 'passed') fail(`governor resolution blocked: ${record.failures.join('; ')}`);
  },
  'role-definitions': async ({ root, argv }) => {
    const args = argumentsFor(argv, ['--output']);
    const record = await resolveRoleRecord(root);
    writeJson(args['--output'], record);
    process.stdout.write(`roles: ${record.status}\n`);
    if (record.status !== 'passed') fail(`role definitions blocked: ${record.failures.join('; ')}`);
  },
  'experiment-config': ({ argv }) => {
    const args = argumentsFor(argv, ['--role-definitions', '--output-dir', '--run-id']);
    writeExperimentFiles({ rolesFile: args['--role-definitions'], outputDir: args['--output-dir'], runId: args['--run-id'] });
  },
  'prompt-fit': async ({ root, argv }) => {
    const args = argumentsFor(argv, ['--spec', '--tasks', '--role-definitions', '--output']);
    const critic: CriticRole | undefined = (readRecord(args['--role-definitions']).roles as CriticRole[]).find((role) => role.roleId === 'critic-reviewer');
    if (!critic) fail('critic-reviewer role is not defined');
    const record = await measurePromptFit(root, { spec: args['--spec'], tasks: args['--tasks'],
      criticPromptCeiling: critic.requestedLimits.maxPromptTokens });
    writeJson(args['--output'], record);
    process.stdout.write(`prompt fit: ${record.status}\n`);
    if (record.status !== 'passed') fail('critic prompts do not fit their ceiling');
  },
  'admission-regenerate': async ({ root, config, argv }) => {
    if (argv.length) fail('admission-regenerate takes no flags');
    const { head, dir, runId } = await regenerateAdmission({ root, config, engine: process.env.AGENT_SDLC_PATH, now: new Date(),
      run: async (name: string, args: string[]) => commands[name as CommandName]({ root, config, argv: args }) });
    process.stdout.write(`admission regenerated for ${head.slice(0, 8)} in ${dir} (run ${runId}); approve with admission-approve\n`);
  },
  'admission-approve': async ({ root, config, argv }) => {
    const args = argumentsFor(argv, ['--approved-by', '--approval', '--implementation-scope', '--live-scope']);
    const done = await approveAdmission({ root, config, now: new Date(),
      approval: { approvedBy: args['--approved-by'] ?? fail('missing --approved-by'),
        text: args['--approval'] ?? fail('missing --approval'),
        implementationScope: args['--implementation-scope'], liveScope: args['--live-scope'] },
      verify: async (manifest: string) => commands['admission-verify']({ root, config, argv: ['--manifest', manifest] }) });
    process.stdout.write(`approved manifest: ${done.manifest} (run ${done.runId})\n`);
  },
  // Verifies the frozen workspace bootstrap named by AGENT_SDLC_CANARY_BOOTSTRAP[_SHA256] without installing anything.
  'workspace-bootstrap-verify': async ({ config, argv }) => {
    if (argv.length !== 1) fail('expected workspace bootstrap root');
    const { AGENT_SDLC_CANARY_BOOTSTRAP: bootstrapPath, AGENT_SDLC_CANARY_BOOTSTRAP_SHA256: bootstrapSha256 } = process.env;
    if (bootstrapPath === undefined) fail('unsafe relative path: undefined');
    if (bootstrapSha256 === undefined) fail('unbound bootstrap reference');
    const result = await verifyWorkspaceBootstrap(argv[0] as string, config, { path: bootstrapPath, sha256: bootstrapSha256 });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  },
  'runtime-inventory': ({ root, argv }) => {
    const args = argumentsFor(argv, ['--sources', '--output']);
    writeJson(args['--output'], expandedInventory(readAs<SourcesDocument>(args['--sources']), root));
  },
  'runtime-materialize': ({ root, config, argv }) => {
    const args = argumentsFor(argv, ['--inventory']);
    materialize(root, readAs<InventoryDocument>(args['--inventory']), config.runtime);
  },
  'runtime-dependencies': ({ config, argv }) => {
    const args = argumentsFor(argv, ['--inventory', '--output']);
    writeJson(args['--output'], dependencyManifest(readAs<InventoryDocument>(args['--inventory']), config.runtime));
  },
};

export const COMMANDS: readonly CommandName[] = Object.freeze(Object.keys(commands) as CommandName[]);

const isCommand = (name: string | undefined): name is CommandName => name !== undefined && Object.hasOwn(commands, name);

export async function run(root: string, argv: string[]) {
  const [name, ...rest] = argv;
  if (!isCommand(name)) return fail(`expected one of: ${COMMANDS.join(', ')}`);
  const { loadHostProfile } = await engineModule('host/host-profile');
  const resolved = fs.realpathSync(root);
  const config = acceptanceConfig(loadHostProfile(resolved), resolved);
  await commands[name]({ root: resolved, config, argv: rest });
}

if (isMain(import.meta.url)) await main(() => run(process.cwd(), process.argv.slice(2)));
