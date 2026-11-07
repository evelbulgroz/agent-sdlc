import path from 'node:path';
import { fail, readJson } from './primitives.mjs';
import { artifact, MODEL_USAGE_DIR } from './artifacts.mjs';

export const responseFiles = (config) => ({
  start: `${artifact(config, 'responses')}/start.json`, reply: `${artifact(config, 'responses')}/reply.json`,
  envelope: `${artifact(config, 'responses')}/envelope.json`,
});

// Exact argv set the operator may run through the guarded shell; response files are written between steps.
export function shellInvocations(config, { runId, spec, tasks }) {
  const files = responseFiles(config);
  // The engine's hosted-canary gate is waived for the canary by operator decision.
  const start = ['shell', 'start', '--goal-file', spec, '--task-plan-file', tasks, '--slug', config.slug, '--skip-canary', '--json'];
  return [
    start,
    [...start, '--response-file', files.start],
    ['shell', 'watch', '--run', runId, '--json'],
    ['shell', 'status', '--run', runId, '--json'],
    ['shell', 'reply', '--run', runId, '--response-file', files.reply, '--json'],
    // The shell's own authorize card carries no envelope, so the frozen one (with its quality plan) is submitted directly.
    ['authorize', '--run', runId, '--envelope-file', files.envelope, '--json'],
    // Quality-review blockers are answered with the strict quality answer record; resume fills in the pending interrupt id.
    ['resume', '--run', runId, '--response-file', files.reply, '--json'],
  ];
}

export function scenarioRecords(root, config, { runDir, spec, tasks, reference, commands }) {
  const authorization = readJson(path.resolve(root, `${runDir}/run-authorizations.json`)).authorizations[0];
  const experiment = readJson(path.resolve(root, `${runDir}/experiment.json`)).experiment;
  const scenario = Object.keys(experiment.scenarios)[0];
  const runId = experiment.scenarios[scenario].runId;
  if (authorization.runId !== runId || !runId.endsWith(`-${config.slug}`)) fail('authorization run does not match experiment');
  const ref = (name) => reference(artifact(config, name));
  const recipes = ref('taskLintRecipe'), execution = ref('executionManifest');
  const qualification = ref('isolatedQualification'), caseMap = ref('caseMap');
  const writable = ['.git', config.stateDir, MODEL_USAGE_DIR, config.runsDir, config.reviewDir, 'governorStateRoot']
    .filter(Boolean);
  return {
    scenario,
    approved: { scenarios: { [scenario]: { runId, approvedSpecHash: authorization.approvedSpecHash,
      spec: reference(spec), tasks: reference(tasks) } } },
    preparation: { execution, scenarios: { [scenario]: {
      runtimeInventory: ref('runtimeInventory'),
      dependencyManifests: [ref('runtimeDependencies')],
      // Adapter registration verification reads the execution manifest, case map and qualification artifact from the candidate worktree.
      readOnlyFiles: [recipes, execution, qualification, caseMap], commandRecipes: recipes } } },
    commands: { ...commands,
      orchestrator: { network: true, providerCredentials: [...config.providerCredentials], writable },
      scenarios: { [scenario]: { skipCanary: true, invocations: shellInvocations(config, { runId, spec, tasks }) } } },
  };
}

const contained = (value) => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value)
  && !path.normalize(value).split(path.sep).includes('..');

// Every scenario the supervisor may start must be bound to its authorization, preparation and exact shell argv.
export function verifyScenarioBindings(manifest, bindings, authorizations) {
  const experiment = bindings.routePricesAndReservationInventory.experiment;
  if (!contained(manifest.shared?.governorStateRoot) || !contained(manifest.shared?.reservationLedger)) {
    fail('governor state and ledger must be repository-relative');
  }
  for (const [name, allocation] of Object.entries(experiment.scenarios)) {
    const approved = bindings.approvedRunSpecsAndTaskPlans.scenarios?.[name];
    const preparation = bindings.candidatePreparationManifests.scenarios?.[name];
    const commands = bindings.allowedCommandsAndEnvironment.scenarios?.[name];
    const authorization = authorizations.find((entry) => entry.runId === allocation.runId);
    if (!authorization || approved?.runId !== allocation.runId
      || approved.approvedSpecHash !== authorization.approvedSpecHash) fail(`scenario authorization mismatch: ${name}`);
    if (!preparation?.runtimeInventory || !preparation.commandRecipes
      || !Array.isArray(preparation.dependencyManifests)) fail(`scenario preparation missing: ${name}`);
    if (!Array.isArray(commands?.invocations) || !commands.invocations.length) fail(`scenario invocations missing: ${name}`);
  }
}
