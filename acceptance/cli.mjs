import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsFor, bytesHash, engineModule, fail, isMain, main, readJson, regularFile, writeJson } from './primitives.mjs';
import { acceptanceConfig } from './config.mjs';
import { artifact } from './artifacts.mjs';
import { assembleManifest, verifyAdmission } from './admission.mjs';
import { buildProposal } from './admission-proposal.mjs';
import { buildAdmissionRecords } from './admission-records.mjs';
import { assertCanaryExecutionCurrent, buildCanaryExecution, buildCaseMap } from './canary-execution.mjs';
import { readiness } from './readiness.mjs';
import { buildRegistrations, validateRegistrations } from './registrations.mjs';
import { buildAuthorization, loadObligations } from './run-authorization.mjs';
import { dependencyManifest, expandedInventory, materialize } from './runtime-inventory.mjs';

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
    writeJson(path.join(root, output), buildCanaryExecution(root, config, source, reference(root, caseMap)));
    process.stdout.write(`canary execution: ${output}\n`);
  },
  readiness: ({ root, config }) => {
    const report = readiness(root, config);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ready) process.exitCode = 1;
  },
  registrations: async ({ root, config, argv }) => {
    const args = argumentsFor(argv, ['--dependency-manifest', '--output']);
    const execution = readJson(regularFile(root, artifact(config, 'executionManifest')));
    assertCanaryExecutionCurrent(root, config, execution);
    const registrations = buildRegistrations(root, config, { execution, dependencyManifest: reference(root, args['--dependency-manifest']) });
    const bindings = await validateRegistrations(root, registrations);
    writeJson(args['--output'], { schemaVersion: '1.0.0', registrations });
    process.stdout.write(`${JSON.stringify(bindings, null, 2)}\n`);
  },
  authorize: async ({ root, config, argv }) => {
    const args = argumentsFor(argv, ['--spec', '--tasks', '--registrations', '--quality-policy', '--output']);
    const authorization = await buildAuthorization(root, config, {
      spec: args['--spec'], tasks: args['--tasks'], registrations: readJson(args['--registrations']).registrations,
      policy: readJson(args['--quality-policy']), obligations: loadObligations(root, config), now: new Date(),
    });
    writeJson(args['--output'], { schemaVersion: '1.0.0', authorizations: [authorization],
      specSha256: bytesHash(fs.readFileSync(args['--spec'])), tasksSha256: bytesHash(fs.readFileSync(args['--tasks'])) });
    process.stdout.write(`authorization ok base=${authorization.baseCommitSha}\n`);
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
