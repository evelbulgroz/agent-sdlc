import fs from 'node:fs';
import path from 'node:path';
import { fail, relativePath, verifyFile } from './primitives.ts';
import { readAs, type AdmissionConfig, type FileReference, type Recipe } from './admission-types.ts';

// `config` supplies { node, packageRoot, packageManager }: the frozen recipe must run the configured node
// from the configured package root, and its input command must be the host's declared package manager.
export function validateRecipe(recipe: Recipe | null | undefined, config: Pick<AdmissionConfig, 'node' | 'packageRoot' | 'packageManager'>): void {
  if (!recipe || !/^[a-zA-Z0-9._-]+$/.test(recipe.id) || recipe.inputArgv?.[0] !== config.packageManager
    || !Array.isArray(recipe.inputArgv) || recipe.inputArgv.some((arg: unknown) => typeof arg !== 'string')
    || recipe.argv?.[0] !== config.node || !Array.isArray(recipe.argv)
    || recipe.argv.some((arg: unknown) => typeof arg !== 'string' || arg.includes('\0'))
    || !/^[a-f0-9]{64}$/.test(recipe.executableSha256)
    || !recipe.dependencyManifest
    || !Number.isSafeInteger(recipe.timeoutMs) || recipe.timeoutMs <= 0 || recipe.timeoutMs > 120000
    || recipe.cwd !== config.packageRoot || !Array.isArray(recipe.files) || !recipe.files.length) fail('invalid frozen command recipe');
}

export function verifyRecipeInputs(root: string, recipe: Recipe, config: Pick<AdmissionConfig, 'node'>): void {
  verifyFile('/', { path: config.node.slice(1), sha256: recipe.executableSha256 });
  for (const file of recipe.files as FileReference[]) verifyFile(root, file);
  const reference = recipe.dependencyManifest;
  if (fs.statSync(path.join(root, relativePath(reference.path))).size > 20 * 1024 * 1024) fail('dependency manifest too large');
  const dependencies = readAs<{ schemaVersion?: string; files?: (FileReference | null)[] }>(verifyFile(root, reference));
  if (dependencies.schemaVersion !== '1.0.0' || !Array.isArray(dependencies.files)
    || !dependencies.files.length || dependencies.files.length > 100000
    || Object.keys(dependencies).sort().join() !== 'files,schemaVersion'
    || new Set(dependencies.files.map((file) => file?.path)).size !== dependencies.files.length) fail('invalid command dependencies');
  for (const file of dependencies.files as FileReference[]) {
    if (!file || Object.keys(file).sort().join() !== 'path,sha256') fail('invalid dependency record');
    verifyFile(root, file);
  }
}
