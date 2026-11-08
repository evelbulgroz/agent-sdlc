import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fail, readJson, verifyFile, engineModule } from './primitives.mjs';
import { launchSupervised } from './process.mjs';
import { verifyAdmission } from './admission.mjs';
import { createLedgerBroker, RemoteExperimentLedger } from './experiment-broker.mjs';
import { ExperimentLedger } from './experiment-ledger.mjs';
import { ExperimentGovernor } from './experiment-governor.mjs';
import { brokerEvidenceSpawn, evidenceHandler } from './evidence-broker.mjs';
import { boundRunner } from './supervisor-runner.mjs';
import { recipeHandler } from './supervisor-recipes.mjs';

export { launchSupervised };

const BROKER_KEYS = ['AGENT_SDLC_CANARY_BROKER_SOCKET', 'AGENT_SDLC_CANARY_SCENARIO', 'AGENT_SDLC_CANARY_BROKER_TOKEN'];

// `recipes` is { root, config, reference, registrations }; the parent brokers frozen recipes and evidence adapters.
export async function superviseExperiment(options = {}) {
  const { ledger, scenario, recipes, ...execution } = options ?? {};
  if (!(ledger instanceof ExperimentLedger) || !ledger.configuration.scenarios[scenario]
    || !Array.isArray(execution.argv) || !execution.argv.length
    || !Array.isArray(execution.readOnly) || !execution.readOnly.length
    || [execution.env, execution.privateEnv].some(value => value !== undefined
      && (!value || typeof value !== 'object' || Array.isArray(value)))
    || BROKER_KEYS.some(key => Object.hasOwn(execution.env ?? {}, key)
      || Object.hasOwn(execution.privateEnv ?? {}, key))) fail('invalid supervised experiment');
  const clock = ledger.begin();
  ledger.recover();
  const runId = ledger.configuration.scenarios[scenario].runId;
  const broker = await createLedgerBroker(ledger, scenario, recipes ? {
    recipe: recipeHandler({ root: recipes.root, config: recipes.config, reference: recipes.reference, runId }),
    evidence: evidenceHandler({ root: recipes.root, stateDir: recipes.config.stateDir,
      registrations: recipes.registrations, runId, config: recipes.config }) } : {});
  try {
    return await launchSupervised({ ...execution, deadline: clock.deadline, now: Date.now,
      env: { ...execution.env, AGENT_SDLC_CANARY_BROKER_SOCKET: broker.socketName,
        AGENT_SDLC_CANARY_SCENARIO: scenario },
      privateEnv: { ...execution.privateEnv, AGENT_SDLC_CANARY_BROKER_TOKEN: broker.token } });
  } finally { await broker.close(); ledger.accrue(); }
}

export function assertShellInvocation(argv, binding, now = Date.now) {
  const invocations = binding?.invocations, runId = binding?.runId;
  const valid = value => Array.isArray(value) && value.length > 0 && value.length <= 32
    && value.every(arg => typeof arg === 'string' && arg.length > 0 && !arg.includes('\0'));
  const authorize = ['authorize', 'resume'].includes(argv?.[0]) && argv.length === 6 && argv[1] === '--run'
    && argv[3] === (argv[0] === 'resume' ? '--response-file' : '--envelope-file') && argv[5] === '--json';
  if (!valid(argv) || !(authorize || (argv[0] === 'shell' && ['start', 'watch', 'status', 'reply'].includes(argv[1])))
    || (argv.includes('--skip-canary') && !(binding.skipCanary === true && argv[1] === 'start'
      && argv.filter(arg => arg === '--skip-canary').length === 1))
    || !/^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/.test(runId ?? '')
    || !Array.isArray(invocations) || !invocations.length || !invocations.every(valid)
    || invocations.filter(value => JSON.stringify(value) === JSON.stringify(argv)).length !== 1) {
    fail('unapproved shell invocation');
  }
  const value = flag => argv.filter(arg => arg === flag).length === 1 ? argv[argv.indexOf(flag) + 1] : null;
  if (argv[1] === 'start') {
    if (!value('--goal-file') || !value('--task-plan-file') || !value('--slug')
      || `${new Date(now()).toISOString().slice(0, 10)}-${value('--slug')}` !== runId) {
      fail('shell start escaped its frozen spec/plan/run binding');
    }
  } else if (value('--run') !== runId) fail('shell invocation escaped its frozen run');
}

export async function guardedCli({ root, config, manifest, scenario, argv, ledger, execCli = execFileSync }) {
  const bindings = await verifyAdmission(root, config, manifest, { allowRunArtifacts: argv?.[1] !== 'start' });
  const control = bindings.controllerAndContainmentReceipts;
  if (!control.qualifiedLauncher || !control.qualificationHash
    || !(ledger instanceof RemoteExperimentLedger)) fail('no qualified external supervisor');
  const configuration = bindings.routePricesAndReservationInventory.experiment;
  if (!configuration || !configuration.scenarios?.[scenario]) fail('unbound scenario');
  assertShellInvocation(argv, { runId: configuration.scenarios[scenario].runId,
    invocations: bindings.allowedCommandsAndEnvironment.scenarios?.[scenario]?.invocations,
    skipCanary: bindings.allowedCommandsAndEnvironment.scenarios?.[scenario]?.skipCanary });
  if (argv[0] === 'authorize') {
    const frozen = bindings.runAuthorizations.authorizations.find(entry => entry.runId === configuration.scenarios[scenario].runId);
    const submitted = readJson(path.resolve(root, argv[4]));
    if (!frozen || JSON.stringify(submitted) !== JSON.stringify(frozen)) fail('authorize envelope differs from the frozen authorization');
  }
  await ledger.clock();
  const [{ runCli }, { RepositoryModelGovernor }, { RuntimeStore }, { resolveRunPaths },
    { checkpointHydrationBinding }] = await Promise.all([
    engineModule('cli/cli'), engineModule('adapters/model-governor'), engineModule('persistence/runtime-store'),
    engineModule('persistence/run-paths'), engineModule('workflow/checkpoint-hydration'),
  ]);
  const approved = bindings.approvedRunSpecsAndTaskPlans.scenarios[scenario];
  const preparation = bindings.candidatePreparationManifests.scenarios[scenario];
  const expectedBinding = { runId: configuration.scenarios[scenario].runId,
    approvedSpecHash: approved.approvedSpecHash, baseCommitSha: manifest.integrationBaseCommit,
    allowedPackages: manifest.allowedPackages, allowedPathPrefixes: manifest.allowedPathPrefixes };
  const runner = boundRunner({
    root, config, inventory: readJson(verifyFile(root, preparation.runtimeInventory)), expectedBinding,
    dependencyManifests: preparation.dependencyManifests, readOnlyFiles: preparation.readOnlyFiles,
    workspaceLayout: preparation.workspaceLayout,
    commandRecipes: preparation.commandRecipes, execCli,
    readFrozenBinding: () => {
      const paths = resolveRunPaths(expectedBinding.runId, root);
      if (!fs.existsSync(paths.databasePath)) fail('run preparation requested before runtime initialization');
      const store = new RuntimeStore(paths.databasePath);
      try {
        return checkpointHydrationBinding(store.getTaskPlan(expectedBinding.runId),
          store.getRun(expectedBinding.runId), store.getAuthorization(expectedBinding.runId));
      } finally { store.close(); }
    },
  });
  ledger.bind(configuration);
  const governor = new ExperimentGovernor({
    governor: new RepositoryModelGovernor({
      rootDir: root,
      executeOptions: {
        // Routes resolve inside the governor; the host adds none.
        ...(bindings.resolvedGovernorPolicyAndRoutes.policyPath
          ? { policyPath: bindings.resolvedGovernorPolicyAndRoutes.policyPath } : {}),
        stateRoot: path.resolve(root, manifest.shared.governorStateRoot),
      },
    }),
    ledger, scenario, maxAttemptCostMicrousd: configuration.maxAttemptCostMicrousd,
    maxRunCostMicrousd: configuration.costMicrousd,
  });
  const execute = (args, options = {}) => runCli(args, {
    ...options, rootDir: root, governor, execCli: runner, runCliFn: execute,
    evidenceSpawn: brokerEvidenceSpawn(ledger, configuration.scenarios[scenario].runId),
  });
  return execute(argv);
}
