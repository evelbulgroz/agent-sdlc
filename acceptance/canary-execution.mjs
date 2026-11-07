import fs from 'node:fs';
import { bytesHash, fail, regularFile } from './primitives.mjs';

const reference = (root, relative) => ({
  path: relative, sha256: bytesHash(fs.readFileSync(regularFile(root, relative))),
});

// Adapter bundle files are the union of every configured runner's bundleFiles.
const pinnedFiles = (config) => new Set(Object.values(config.runners).flatMap((runner) => runner.bundleFiles));

// The case map freezes file + caseKey; the runner title is matched through its '@case <caseId>' tag.
export function buildCaseMap(config, obligations) {
  return obligations.map((row) => ({
    kind: row.layer, file: row.file, caseKey: row.caseKey, runnerTitle: `@case ${row.caseId}`,
    capabilities: row.capabilities,
    ...(config.runners[row.layer]?.project ? { project: config.runners[row.layer].project } : {}),
  }));
}

// Re-pins a qualified runtime manifest to the current adapter bundle, the runner configs and the canary case map.
export function buildCanaryExecution(root, config, source, caseMapReference) {
  const pinned = pinnedFiles(config);
  const files = source.files.filter((file) => !pinned.has(file.path));
  for (const file of pinned) files.push(reference(root, file));
  const commands = source.commands.map((command) => {
    const runnerConfig = config.runners[command.id]?.config;
    if (!runnerConfig) return command;
    const argv = [...command.argv];
    const index = argv.indexOf('--config');
    if (index < 1) fail(`missing runner config: ${command.id}`);
    argv[index + 1] = runnerConfig;
    return { ...command, argv };
  });
  const adapters = source.adapters.map((adapter) => config.runners[adapter.kind]?.config
    ? { ...adapter, config: reference(root, `${config.packageRoot}/${config.runners[adapter.kind].config}`) } : adapter);
  return {
    ...source, purpose: 'canary adapter execution manifest bound to the canary case map and runner configs',
    files, commands, adapters, caseMap: caseMapReference,
  };
}

// Fails when the staged manifest pins an adapter bundle file or runner config that differs from the working tree.
export function assertCanaryExecutionCurrent(root, config, manifest) {
  const pinned = pinnedFiles(config);
  const records = [...manifest.files.filter((file) => pinned.has(file.path)),
    ...manifest.adapters.map((adapter) => adapter.config).filter(Boolean)];
  for (const file of pinned) if (!records.some((record) => record.path === file)) fail(`execution manifest lacks ${file}`);
  for (const record of records) {
    const current = bytesHash(fs.readFileSync(regularFile(root, record.path)));
    if (current !== record.sha256) fail(`stale execution manifest: ${record.path}; rerun the canary execution build`);
  }
}
