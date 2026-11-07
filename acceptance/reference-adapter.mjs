import { engineContracts, readRequest, report } from './contracts.mjs';
import { isMain, main } from './primitives.mjs';

// Reference evidence adapter: speaks the wire contract and reports every selected case as passed.
// It has no runner knowledge, so it defines the smallest conforming adapter, not a real test runner.
export async function referenceReport(loadContracts, request) {
  const selected = new Map();
  for (const obligation of request.obligations) {
    for (const { file, caseKey } of obligation.testCases) {
      const key = `${file}\0${caseKey}`;
      const entry = selected.get(key) ?? { file, caseKey, obligationIds: [], capabilities: new Set() };
      entry.obligationIds.push(obligation.obligationId);
      for (const capability of obligation.requiredCapabilities) entry.capabilities.add(capability);
      selected.set(key, entry);
    }
  }
  const cases = [...selected.values()].map((entry) => ({
    file: entry.file, caseKey: entry.caseKey, obligationIds: [...new Set(entry.obligationIds)],
    exercisedCapabilities: [...entry.capabilities], outcome: 'passed',
    attempts: [{ index: 0, outcome: 'passed', durationMs: 0, artifactPaths: [] }],
  }));
  return report(loadContracts, request, cases);
}

if (isMain(import.meta.url)) await main(async () => {
  const request = await readRequest(engineContracts);
  process.stdout.write(`${JSON.stringify(await referenceReport(engineContracts, request))}\n`);
});
