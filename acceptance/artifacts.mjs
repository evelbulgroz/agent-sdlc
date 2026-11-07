import { fail } from './primitives.mjs';

// Engine-owned artifact names under evidenceDir/<canaryId>/. Unversioned and not configurable, so a
// host cannot drift from the names admission and the supervisor bind.
export const ARTIFACTS = Object.freeze({
  executionManifest: 'execution.json',
  caseMap: 'canary-cases.json',
  taskLintRecipe: 'task-lint-recipe.json',
  isolatedQualification: 'isolated-runtime-qualification.json',
  runtimeInventory: 'runtime.inventory.json',
  runtimeDependencies: 'runtime.dependencies.json',
  pretestQualification: 'pretest-qualification.json',
  offlineQualification: 'offline/offline-qualification.json',
  preflightBootstrap: 'canonical-preflight/bootstrap.json',
  responses: 'responses',
});

// Where the engine's model-usage ledger keeps per-run state; the orchestrator must be able to write it.
export const MODEL_USAGE_DIR = 'tools/.model-usage';

export function artifact(config, name) {
  if (!Object.hasOwn(ARTIFACTS, name)) fail(`unknown artifact: ${name}`);
  return `${config.output}/${ARTIFACTS[name]}`;
}
