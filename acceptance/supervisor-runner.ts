import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bytesHash, fail, readJson, relativePath, verifyFile } from './primitives.ts';
import { dependencyManifest } from './runtime-inventory.ts';
import { writeBinShims } from './bin-shims.ts';
import { copyFrozenFiles } from './prepare-files.ts';
import { frozenWorkspacePreparation } from './workspace-bootstrap.ts';
import { commandBridge } from './supervisor-recipes.ts';
import type { BridgeBinding, BridgeExec, CommandBridge } from './supervisor-recipes.ts';
import type { CopyEntry, FileReference, JsonRecord } from './admission-types.ts';
import type { AcceptanceConfig } from './types.ts';

export interface FrozenFile extends FileReference { mode: number }
export interface RuntimeInventory { schemaVersion?: string; files?: FrozenFile[] }
export interface RunBinding extends BridgeBinding { allowedPackages: string[] }

const RUN_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/;

export function noInstallRunner({
  root, config, inventory, binding, dependencyManifests = [], readOnlyFiles = [], workspaceLayout, execCli = execFileSync,
}: {
  root: string; config: AcceptanceConfig; inventory: RuntimeInventory | null | undefined; binding: RunBinding;
  dependencyManifests?: readonly FileReference[]; readOnlyFiles?: readonly FileReference[];
  workspaceLayout?: FileReference | null | undefined; execCli?: CommandBridge;
}) {
  root = fs.realpathSync(root);
  if (inventory?.schemaVersion !== '1.0.0' || !inventory.files?.length || !RUN_ID.test(binding?.runId)
    || JSON.stringify(binding.allowedPackages) !== JSON.stringify([config.packageRoot])) fail('invalid no-install preparation');
  const runtime = path.join(root, config.runtime);
  const workspace = workspaceLayout ? frozenWorkspacePreparation(root, config, workspaceLayout) : null;
  const frozen: FrozenFile[] = structuredClone(inventory.files);
  const copies = frozen.flatMap((file): CopyEntry[] => {
    relativePath(file.path);
    if (!Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777) fail('invalid frozen file mode');
    const destinations: string[] = [`${config.runtime}/${file.path}`];
    if (!workspace && file.path.startsWith('node_modules/')) destinations.push(file.path, `${config.packageRoot}/${file.path}`);
    return destinations.map((destination) => ({ ...file, source: file.path, sourceRoot: runtime, destination }));
  });
  for (const reference of dependencyManifests) {
    const source = verifyFile(root, reference);
    if (JSON.stringify(readJson(source)) !== JSON.stringify(dependencyManifest(inventory, config.runtime))) {
      fail('dependency manifest does not cover frozen runtime');
    }
  }
  for (const reference of [...dependencyManifests, ...readOnlyFiles, ...(workspace ? [workspace.reference] : [])]) {
    const source = verifyFile(root, reference);
    copies.push({ ...reference, source: reference.path, sourceRoot: root, destination: reference.path,
      mode: fs.statSync(source).mode & 0o777 });
  }
  if (new Set(copies.map((file) => file.destination)).size !== copies.length) fail('duplicate preparation file');
  const preparation = {
    configuration: { strategy: 'checkpoint-offline-v1', downloadsAllowed: false,
      inventoryHash: bytesHash(Buffer.from(JSON.stringify(inventory))),
      ...(workspace ? { workspaceLayout: workspace.reference } : {}) },
    files: [...copies.map((file) => ({ path: file.destination, sha256: file.sha256 })),
      ...(workspace?.files ?? [])],
  };
  const prepare = async ({ worktreeDir, packages }: { worktreeDir: string; packages: readonly string[] }) => {
    const target = fs.realpathSync(worktreeDir);
    const runRoot = path.join(root, config.stateDir, binding.runId);
    if (!target.startsWith(`${runRoot}/`) || !packages.length
      || packages.some((pkg) => pkg !== config.packageRoot)) fail('offline preparation escaped authorized run');
    await copyFrozenFiles(target, copies);
    if (workspace) workspace.prepare(target); else writeBinShims(target, config.packageRoot, config.node);
  };
  const runner: CommandBridge = (command, args, options) => {
    workspace?.verifyTarget(options?.cwd as string);
    return execCli(command, args, options);
  };
  return Object.assign(runner, {
    checkpointHydration: { binding: structuredClone(binding), preparation, prepare },
  });
}

export function boundRunner({
  root, config, inventory, expectedBinding, dependencyManifests, readOnlyFiles, workspaceLayout, commandRecipes,
  readFrozenBinding, execCli = execFileSync,
}: {
  root: string; config: AcceptanceConfig; inventory: RuntimeInventory; expectedBinding: Record<string, unknown>;
  dependencyManifests?: readonly FileReference[]; readOnlyFiles?: readonly FileReference[];
  workspaceLayout?: FileReference | null | undefined; commandRecipes: FileReference;
  readFrozenBinding: () => (RunBinding & JsonRecord) | null | undefined; execCli?: BridgeExec;
}) {
  let cached: ReturnType<typeof noInstallRunner> | undefined, previous: string | undefined;
  const resolve = () => {
    const binding = readFrozenBinding();
    if (!binding || Object.entries(expectedBinding).some(([key, value]) =>
      JSON.stringify(binding[key]) !== JSON.stringify(value))) fail('frozen run preparation binding mismatch');
    const serialized = JSON.stringify(binding);
    if (previous && serialized !== previous) fail('frozen run preparation rebound');
    if (!cached) {
      const bridge = commandBridge({ root, config, binding, reference: commandRecipes, execCli });
      cached = noInstallRunner({ root, config, inventory, binding, dependencyManifests, readOnlyFiles,
        workspaceLayout, execCli: bridge });
      previous = serialized;
    }
    return cached;
  };
  const runner: CommandBridge = (command, args, options) => resolve()(command, args, options);
  return Object.defineProperty(runner, 'checkpointHydration', {
    get: () => resolve().checkpointHydration,
  });
}
