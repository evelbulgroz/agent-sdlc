import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCanaryExecution, buildCaseMap } from './canary-execution.ts';

const config = { packageRoot: 'pkg', commands: { unit: { argv: ['node'] }, browser: { argv: ['node'] } } };
const rows = [
  { layer: 'unit', file: 'pkg/a.spec.ts', caseKey: 'a', caseId: 'AC-01.1', capabilities: ['x'] },
  { layer: 'browser', file: 'pkg/b.spec.ts', caseKey: 'b', caseId: 'AC-02.1', capabilities: [] },
];
const sha = 'a'.repeat(64);

test('case map freezes file and caseKey and matches the runner title through the @case tag', () => {
  const map = buildCaseMap(config, rows);
  assert.deepEqual(map[0], { kind: 'unit', file: 'pkg/a.spec.ts', caseKey: 'a', runnerTitle: '@case AC-01.1', capabilities: ['x'] });
  assert.deepEqual(map[1], { kind: 'browser', file: 'pkg/b.spec.ts', caseKey: 'b', runnerTitle: '@case AC-02.1', capabilities: [] });
});

test('execution manifest binds the qualified runtime manifest to the case map and keeps the rest of the source', () => {
  const source = { files: [{ path: 'keep', sha256: 'keep' }], commands: [{ id: 'other', argv: ['/n'] }] };
  const caseMap = { path: 'cases.json', sha256: sha };
  const result = buildCanaryExecution(source, caseMap);
  assert.equal(result.caseMap, caseMap);
  assert.deepEqual(result.files, source.files);
  assert.deepEqual(result.commands, source.commands);
  assert.match(result.purpose, /canary case map/);
});
