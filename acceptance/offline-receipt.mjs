import { bytesHash } from './primitives.mjs';

// Each runtime blocking requirement must be answered by a passed provider-free component.
const REQUIREMENT_EVIDENCE = [
  [/native loader/i, ['native']],
  [/dependency closure/i, ['isolatedRuntime']],
  [/helper\/pretest\/config\/build/i, ['pretest', 'unit']],
  [/no-install detached worktree/i, ['isolatedRuntime']],
  [/process escape/i, ['writeLimits', 'native']],
];

export function composeReceipt({ inventory, components, corpusSha256, inventorySha256, baseCommitSha }) {
  const failures = [];
  for (const [name, component] of Object.entries(components)) {
    if (component?.status !== 'passed') failures.push(`component not passed: ${name}`);
  }
  for (const requirement of inventory.blockingRequirements ?? []) {
    const rule = REQUIREMENT_EVIDENCE.find(([pattern]) => pattern.test(requirement));
    if (!rule) failures.push(`unmapped blocking requirement: ${requirement}`);
    else if (rule[1].some((name) => components[name]?.status !== 'passed')) {
      failures.push(`unsatisfied blocking requirement: ${requirement}`);
    }
  }
  return {
    schemaVersion: '1.0.0', status: failures.length ? 'blocked' : 'passed', failures,
    liveQualified: false, providerOperations: 0, baseCommitSha, corpusSha256, inventorySha256,
    components: Object.fromEntries(Object.entries(components).map(([name, value]) => [name,
      { status: value?.status, sha256: bytesHash(Buffer.from(JSON.stringify(value))) }])),
    satisfiedRequirements: inventory.blockingRequirements ?? [],
  };
}
