import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fail, readJson, relativePath, verifyFile } from './primitives.ts';
import { executeOwned } from './process.ts';
import { namespaceArgv } from './sandbox.ts';
import { isCanonicalPreflight, runCanonicalPreflight } from './preflight-bridge.ts';
import { validateRecipe, verifyRecipeInputs } from './recipes.ts';
import type { FileReference, Recipe } from './admission-types.ts';
import type { RecipeBrokerRequest, RecipeBrokerResult } from './experiment-types.ts';
import type { AcceptanceConfig, OwnedResult } from './types.ts';

export type FrozenRecipe = Recipe & { env?: Readonly<Record<string, string>> };

interface RecipeFile { schemaVersion?: string; recipes: FrozenRecipe[] }

export type BridgeExec = (file: string, args: readonly string[], options: object) => string | Buffer;

export type CommandBridge = (command: string, args: readonly string[], options?: BridgeOptions) => string | Buffer;

export interface BridgeBinding { runId: string; baseCommitSha: string }
export interface BridgeOptions { cwd?: string; timeout?: number; encoding?: BufferEncoding }

export const RECIPE_CHILD = fileURLToPath(new URL('./recipe-child.ts', import.meta.url));
const BROKER_KEYS = ['AGENT_SDLC_CANARY_BROKER_SOCKET', 'AGENT_SDLC_CANARY_SCENARIO', 'AGENT_SDLC_CANARY_BROKER_TOKEN'];
const brokerEnvironment = (): Record<string, string | undefined> => Object.fromEntries(BROKER_KEYS.filter(key => process.env[key]).map(key => [key, process.env[key]]));
const RUN_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/;

export async function executeFrozenRecipe(root: string, config: AcceptanceConfig, recipe: FrozenRecipe, timeoutMs = recipe?.timeoutMs): Promise<OwnedResult> {
  validateRecipe(recipe, config);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > recipe.timeoutMs) fail('invalid bridge timeout');
  root = fs.realpathSync(root);
  verifyRecipeInputs(root, recipe, config);
  const argv = recipe.argv.map(arg => arg.startsWith('@worktree/')
    ? path.join(root, relativePath(arg.slice('@worktree/'.length))) : arg);
  if (!argv[1]?.startsWith(`${root}/`) || !recipe.files.some(file => argv[1] === path.join(root, file.path))) {
    fail('unfrozen bridge entry point');
  }
  const readOnly = [...new Set(recipe.files.map(file => path.posix.dirname(file.path))
    .filter(directory => directory.startsWith(`${config.output}/`)))];
  const result = await executeOwned(namespaceArgv({ ...config, root }, argv, { env: recipe.env ?? {}, readOnly }), {
    cwd: root, timeoutMs, maxBytes: 1048576,
  });
  verifyRecipeInputs(root, recipe, config);
  return result;
}

// The sandboxed child cannot nest namespaces; the parent runs frozen recipes.
export function recipeHandler({ root, config, reference, runId, run = executeFrozenRecipe }: {
  root: string; config: AcceptanceConfig; reference: FileReference; runId: string; run?: typeof executeFrozenRecipe;
}) {
  root = fs.realpathSync(root);
  return async ({ argv, worktree, timeoutMs }: Pick<RecipeBrokerRequest, 'argv' | 'worktree' | 'timeoutMs'>): Promise<RecipeBrokerResult> => {
    if (!Array.isArray(argv) || argv.some(arg => typeof arg !== 'string') || typeof worktree !== 'string') {
      fail('invalid recipe request');
    }
    const recipe = (readJson(verifyFile(root, reference)) as RecipeFile).recipes
      .find(entry => JSON.stringify(entry.inputArgv) === JSON.stringify(argv));
    if (!recipe) fail('command is not a frozen canary recipe');
    const resolved = fs.realpathSync(worktree);
    if (!resolved.startsWith(`${path.join(root, config.stateDir, runId)}/`)) fail('command escaped authorized run');
    const limit = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, recipe.timeoutMs) : recipe.timeoutMs;
    const result = await run(resolved, config, recipe, limit);
    return { code: result.code ?? 1, stdout: String(result.stdout ?? '').slice(-16384),
      stderr: String(result.stderr ?? '').slice(-16384) };
  };
}

export function commandBridge({ root, config, binding, reference, execCli = execFileSync }: {
  root: string; config: AcceptanceConfig; binding: BridgeBinding; reference: FileReference; execCli?: BridgeExec;
}): CommandBridge {
  root = fs.realpathSync(root);
  const source = verifyFile(root, reference);
  const configuration = readJson(source) as RecipeFile;
  if (configuration.schemaVersion !== '1.0.0' || !Array.isArray(configuration.recipes)
    || !configuration.recipes.length) fail('missing command recipes');
  const recipes = structuredClone(configuration.recipes);
  recipes.forEach(recipe => validateRecipe(recipe, config));
  if (new Set(recipes.map(recipe => JSON.stringify(recipe.inputArgv))).size !== recipes.length) {
    fail('ambiguous command recipes');
  }
  if (!RUN_ID.test(binding?.runId)) fail('unbound bridge run');
  return (command, args, options = {}) => {
    if (!Array.isArray(args)) fail('invalid bridge command');
    if (isCanonicalPreflight(command, args, config.preflightCommand)) {
      return runCanonicalPreflight({ root, stateDir: config.stateDir, node: config.node,
        preflight: config.preflightCommand, runId: binding.runId, baseCommitSha: binding.baseCommitSha,
        args, options, exec: execCli });
    }
    const recipe = recipes.find(entry => JSON.stringify(entry.inputArgv) === JSON.stringify([command, ...args]));
    if (!recipe) fail('command is not a frozen canary recipe');
    const worktree = fs.realpathSync(options.cwd as string);
    const runRoot = path.join(root, config.stateDir, binding.runId);
    if (!worktree.startsWith(`${runRoot}/`)) fail('command escaped authorized run');
    verifyFile(root, reference);
    verifyFile(worktree, reference);
    verifyRecipeInputs(worktree, recipe, config);
    const timeoutMs = Math.min(recipe.timeoutMs, options.timeout ?? recipe.timeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail('invalid bridge timeout');
    return execCli(config.node, [RECIPE_CHILD, '_recipe'], {
      cwd: root,
      input: JSON.stringify({ root: worktree, config, recipe, timeoutMs, runId: binding.runId, argv: [command, ...args] }),
      env: { PATH: '/nonexistent', HOME: '/tmp', TMPDIR: '/tmp', ...brokerEnvironment() },
      encoding: options.encoding ?? 'utf8', timeout: timeoutMs,
      killSignal: 'SIGKILL', maxBuffer: 1048576,
    });
  };
}
