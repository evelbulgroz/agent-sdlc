import fs from 'node:fs';
import type { AcceptanceConfig } from './types.ts';
import { bytesHash, regularFile } from './primitives.ts';

type ObligationRow = {
  layer: string; file: string; caseKey: string; caseId: string; capabilities: unknown;
};

const reference = (root: string, relative: string) => ({
  path: relative, sha256: bytesHash(fs.readFileSync(regularFile(root, relative))),
});

// The case map freezes file + caseKey; the runner title is matched through its '@case <caseId>' tag.
export function buildCaseMap(config: AcceptanceConfig, obligations: ObligationRow[]) {
  return obligations.map((row) => ({
    kind: row.layer, file: row.file, caseKey: row.caseKey, runnerTitle: `@case ${row.caseId}`,
    capabilities: row.capabilities,
  }));
}

// Binds a qualified runtime manifest to the canary case map.
export function buildCanaryExecution(source: object, caseMapReference: { path: string; sha256: string }) {
  return {
    ...source, purpose: 'canary execution manifest bound to the canary case map', caseMap: caseMapReference,
  };
}
