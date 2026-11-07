import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertCanaryExecutionCurrent, buildCanaryExecution, buildCaseMap } from './canary-execution.mjs';

const config = {
  packageRoot: 'pkg',
  runners: {
    unit: { argv: ['/n'], bundleFiles: ['tools/adapter.mjs'], config: 'unit.config.ts' },
    browser: { argv: ['/n'], bundleFiles: ['tools/adapter.mjs', 'tools/browser.mjs'], config: 'browser.config.ts', project: 'main' },
  },
};
const rows = [
  { layer: 'unit', file: 'pkg/a.spec.ts', caseKey: 'a', caseId: 'AC-01.1', capabilities: ['x'] },
  { layer: 'browser', file: 'pkg/b.spec.ts', caseKey: 'b', caseId: 'AC-02.1', capabilities: [] },
];
const sha = 'a'.repeat(64);

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-exec-'));
  for (const file of ['tools/adapter.mjs', 'tools/browser.mjs', 'pkg/unit.config.ts', 'pkg/browser.config.ts']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), file);
  }
  return root;
}

test('case map carries the runner project only where configured', () => {
  const map = buildCaseMap(config, rows);
  assert.deepEqual(map[0], { kind: 'unit', file: 'pkg/a.spec.ts', caseKey: 'a', runnerTitle: '@case AC-01.1', capabilities: ['x'] });
  assert.equal(map[1].project, 'main');
});

test('execution manifest re-pins bundle files and runner configs without touching other commands', () => {
  const root = tree();
  const source = {
    files: [{ path: 'tools/adapter.mjs', sha256: 'stale' }, { path: 'keep', sha256: 'keep' }],
    commands: [{ id: 'unit', argv: ['/n', 'v', '--config', 'old'] }, { id: 'other', argv: ['/n'] }],
    adapters: [{ kind: 'unit', config: { path: 'old', sha256: 'old' } }, { kind: 'other' }],
  };
  const caseMap = { path: 'cases.json', sha256: sha };
  const result = buildCanaryExecution(root, config, source, caseMap);
  assert.equal(result.files.find((file) => file.path === 'tools/adapter.mjs').sha256.length, 64);
  assert.ok(result.files.some((file) => file.sha256 === 'keep'));
  assert.deepEqual(result.commands[0].argv.slice(-2), ['--config', 'unit.config.ts']);
  assert.deepEqual(result.commands[1], source.commands[1]);
  assert.equal(result.adapters[0].config.path, 'pkg/unit.config.ts');
  assert.deepEqual(result.adapters[1], { kind: 'other' });
  assert.equal(result.caseMap, caseMap);
  assert.throws(() => buildCanaryExecution(root, config, { ...source, commands: [{ id: 'unit', argv: ['/n'] }] }, caseMap),
    /missing runner config: unit/);
});

test('a staged manifest with stale or missing pins is rejected', () => {
  const root = tree();
  const current = buildCanaryExecution(root, config, { files: [], commands: [], adapters: [{ kind: 'unit' }] }, { path: 'p', sha256: sha });
  assertCanaryExecutionCurrent(root, config, current);
  const stale = { ...current, files: current.files.map((file) => file.path === 'tools/adapter.mjs' ? { ...file, sha256: 'b'.repeat(64) } : file) };
  assert.throws(() => assertCanaryExecutionCurrent(root, config, stale), /stale execution manifest: tools\/adapter\.mjs/);
  assert.throws(() => assertCanaryExecutionCurrent(root, config, { ...current, files: [] }), /lacks/);
  fs.writeFileSync(path.join(root, 'pkg/unit.config.ts'), 'changed');
  assert.throws(() => assertCanaryExecutionCurrent(root, config, current), /stale execution manifest: pkg\/unit\.config\.ts/);
});
