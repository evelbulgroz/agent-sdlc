import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsFor, bytesHash, engineModule, fail, isMain, main, readJson, regularFile, writeJson } from './primitives.mjs';
import { acceptanceConfig } from './config.mjs';
import { artifact } from './artifacts.mjs';
import { assembleManifest, verifyAdmission } from './admission.mjs';
import { buildProposal } from './admission-proposal.mjs';
import { buildAdmissionRecords } from './admission-records.mjs';
import { buildCanaryExecution, buildCaseMap } from './canary-execution.mjs';
import { readiness } from './readiness.mjs';
import { qualifyCommands, sentinelRegistration } from './command-admission.mjs';
import { assertPinsOutsideWriteScope, buildCommandRegistrations } from './command-evidence.mjs';
import { validateRegistrations } from './registrations.mjs';
import { allowedPaths, buildAuthorization, loadObligations } from './run-authorization.mjs';
import { dependencyManifest, expandedInventory, materialize } from './runtime-inventory.mjs';
import { writeExperimentFiles } from './experiment-config.mjs';
import { resolveGovernorRecord } from './governor-resolution.mjs';
import { measurePromptFit } from './prompt-fit.mjs';
import { resolveRoleRecord } from './role-definitions.mjs';
import { approveAdmission, regenerateAdmission } from './regenerate.mjs';
import { verifyWorkspaceBootstrap } from './workspace-bootstrap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The control record reruns these engine specs against the host, so the engine, not the host, owns them.
const CONTROL_SPECS = ['experiment', 'experiment-budget', 'admission'].map((name) => path.join(HERE, `${name}.spec.mjs`));

const reference = (root, relative) => ({ path: relative, sha256: bytesHash(fs.readFileSync(regularFile(root, relative))) });

// Each handler receives the realpath'd host root, the acceptance config and the already-split argv.
const commands = {
  'admission-assemble': ({ argv }) => {
    const args = argumentsFor(argv, ['--proposal', '--output']);
    const bytes = fs.readFileSync(args['--proposal']);
    writeJson(args['--output'], assembleManifest(JSON.parse(bytes.toString('utf8')), bytes));
  },
  'admission-verify': async ({ root, config, argv }) => {
    const args = argumentsFor(argv, ['--manifest']);
    await verifyAdmission(root, config, readJson(args['--manifest']));
    process.stdout.write('admission: verified\n');
  },
  'admission-proposal': ({ root, config, argv }) => {
    const args = argumentsFor(argv, ['--engine', '--run-dir', '--roles', '--output']);
    writeJson(args['--output'], buildProposal(root, config, { runDir: args['--run-dir'], engine: args['--engine'], roles: args['--roles'] }));
  },
  'admission-records': ({ root, config, argv }) => {
    const args = argumentsFor(argv, ['--engine', '--run-dir', '--output-dir', '--roles']);
    const runDir = args['--run-dir'];
    const { experiment } = readJson(path.join(runDir, 'experiment.json'));
    const records = buildAdmissionRecords(config, root, {
      engineRoot: args['--engine'], experiment,
      governor: readJson(path.join(path.dirname(runDir), 'governor-resolution.json')),
      policy: readJson(path.join(runDir, 'quality-policy.json')),
      roles: readJson(args['--roles']), corpus: readJson(path.join(root, config.caseManifest)),
      runtimeVerify: readJson(path.join(root, '.agents/sdlc-host.json')).verify, specPaths: CONTROL_SPECS,
    });
    for (const [name, record] of Object.entries(records)) writeJson(path.join(args['--output-dir'], `${name}.json`), record);
    process.stdout.write(`${Object.keys(records).join('\n')}\n`);
  },
  'canary-execution': ({ root, config, argv }) => {
    const args = argumentsFor(argv, ['--source']);
    const caseMap = artifact(config, 'caseMap'), output = artifact(config, 'executionManifest');
    writeJson(path.join(root, caseMap), buildCaseMap(config, loadObligations(root, config)));
    const source = readJson(regularFile(root, args['--source']));
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
      runId: args['--run-id'], spec: args['--spec'], tasks: args['--tasks'], registrations: readJson(args['--registrations']).registrations,
      policy: readJson(args['--quality-policy']), obligations: loadObligations(root, config), now: new Date(),
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
    const critic = readJson(args['--role-definitions']).roles.find((role) => role.roleId === 'critic-reviewer');
    const record = await measurePromptFit(root, { spec: args['--spec'], tasks: args['--tasks'],
      criticPromptCeiling: critic.requestedLimits.maxPromptTokens });
    writeJson(args['--output'], record);
    process.stdout.write(`prompt fit: ${record.status}\n`);
    if (record.status !== 'passed') fail('critic prompts do not fit their ceiling');
  },
  'admission-regenerate': async ({ root, config, argv }) => {
    if (argv.length) fail('admission-regenerate takes no flags');
    const { head, dir, runId } = await regenerateAdmission({ root, config, engine: process.env.AGENT_SDLC_PATH, now: new Date(),
      run: (name, args) => commands[name]({ root, config, argv: args }) });
    process.stdout.write(`admission regenerated for ${head.slice(0, 8)} in ${dir} (run ${runId}); approve with admission-approve\n`);
  },
  'admission-approve': async ({ root, config, argv }) => {
    const args = argumentsFor(argv, ['--approved-by', '--approval', '--implementation-scope', '--live-scope']);
    const done = await approveAdmission({ root, config, now: new Date(),
      approval: { approvedBy: args['--approved-by'], text: args['--approval'],
        implementationScope: args['--implementation-scope'], liveScope: args['--live-scope'] },
      verify: (manifest) => commands['admission-verify']({ root, config, argv: ['--manifest', manifest] }) });
    process.stdout.write(`approved manifest: ${done.manifest} (run ${done.runId})\n`);
  },
  // Verifies the frozen workspace bootstrap named by AGENT_SDLC_CANARY_BOOTSTRAP[_SHA256] without installing anything.
  'workspace-bootstrap-verify': async ({ config, argv }) => {
    if (argv.length !== 1) fail('expected workspace bootstrap root');
    const result = await verifyWorkspaceBootstrap(argv[0], config, {
      path: process.env.AGENT_SDLC_CANARY_BOOTSTRAP, sha256: process.env.AGENT_SDLC_CANARY_BOOTSTRAP_SHA256 });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  },
  'runtime-inventory': ({ root, argv }) => {
    const args = argumentsFor(argv, ['--sources', '--output']);
    writeJson(args['--output'], expandedInventory(readJson(args['--sources']), root));
  },
  'runtime-materialize': ({ root, config, argv }) => {
    const args = argumentsFor(argv, ['--inventory']);
    materialize(root, readJson(args['--inventory']), config.runtime);
  },
  'runtime-dependencies': ({ config, argv }) => {
    const args = argumentsFor(argv, ['--inventory', '--output']);
    writeJson(args['--output'], dependencyManifest(readJson(args['--inventory']), config.runtime));
  },
};

export const COMMANDS = Object.freeze(Object.keys(commands));

export async function run(root, argv) {
  const [name, ...rest] = argv;
  if (!Object.hasOwn(commands, name)) fail(`expected one of: ${COMMANDS.join(', ')}`);
  const { loadHostProfile } = await engineModule('host/host-profile');
  const resolved = fs.realpathSync(root);
  const config = acceptanceConfig(loadHostProfile(resolved), resolved);
  await commands[name]({ root: resolved, config, argv: rest });
}

if (isMain(import.meta.url)) await main(() => run(process.cwd(), process.argv.slice(2)));
