import fs from 'node:fs';
import { bytesHash, regularFile } from './primitives.mjs';

const reference = (root, relative) => ({
  path: relative, sha256: bytesHash(fs.readFileSync(regularFile(root, relative))),
});

// The case map freezes file + caseKey; the runner title is matched through its '@case <caseId>' tag.
export function buildCaseMap(config, obligations) {
  return obligations.map((row) => ({
    kind: row.layer, file: row.file, caseKey: row.caseKey, runnerTitle: `@case ${row.caseId}`,
    capabilities: row.capabilities,
  }));
}

// Binds a qualified runtime manifest to the canary case map.
export function buildCanaryExecution(source, caseMapReference) {
  return {
    ...source, purpose: 'canary execution manifest bound to the canary case map', caseMap: caseMapReference,
  };
}
