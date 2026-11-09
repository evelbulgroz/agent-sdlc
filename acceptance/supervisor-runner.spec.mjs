import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bytesHash } from './primitives.ts';
import { dependencyManifest } from './runtime-inventory.ts';
import { boundRunner, noInstallRunner } from './supervisor-runner.ts';

const PACKAGE = 'pkg';
const RUNTIME = 'state/runtime';
const config = (root) => ({ root, node: process.execPath, packageRoot: PACKAGE, runtime: RUNTIME, stateDir: 'state',
  output: 'state/evidence/c1', packageManager: 'pm', preflightCommand: null });

function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-runner-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, RUNTIME, 'node_modules/probe'), { recursive: true });
  fs.writeFileSync(path.join(root, RUNTIME, 'node_modules/probe/index.js'), 'frozen');
  return root;
}

const frozenFile = { path: 'node_modules/probe/index.js', sha256: bytesHash(Buffer.from('frozen')), mode: 0o644 };
const inventory = { schemaVersion: '1.0.0', files: [frozenFile] };

function referenceTo(root, relative, value) {
  fs.writeFileSync(path.join(root, relative), JSON.stringify(value));
  return { path: relative, sha256: bytesHash(fs.readFileSync(path.join(root, relative))) };
}

test('no-install runner hydrates frozen files without running a command and rejects drift or escape', async (t) => {
  const root = temporary(t), cfg = config(root);
  const binding = { runId: '2026-11-02-no-install', allowedPackages: [PACKAGE] };
  const reference = referenceTo(root, 'dependencies.json', dependencyManifest(inventory, RUNTIME));
  let commands = 0;
  const runner = noInstallRunner({ root, config: cfg, inventory, binding, dependencyManifests: [reference],
    execCli: () => { commands++; } });
  const worktreeDir = path.join(root, 'state', binding.runId, 'worktrees/task');
  fs.mkdirSync(worktreeDir, { recursive: true });
  const prepare = runner.checkpointHydration.prepare;
  await prepare({ worktreeDir, packages: [PACKAGE] });
  await prepare({ worktreeDir, packages: [PACKAGE] });
  assert.equal(commands, 0);
  assert.equal(runner.checkpointHydration.preparation.files.length, 4);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(worktreeDir, 'dependencies.json'), 'utf8')),
    dependencyManifest(inventory, RUNTIME));
  assert.equal(fs.readFileSync(path.join(worktreeDir, PACKAGE, 'node_modules/probe/index.js'), 'utf8'), 'frozen');
  fs.writeFileSync(path.join(worktreeDir, 'node_modules/probe/index.js'), 'drift');
  await assert.rejects(prepare({ worktreeDir, packages: [PACKAGE] }), /file changed/);
  await assert.rejects(prepare({ worktreeDir: root, packages: [PACKAGE] }), /escaped authorized run/);
  await assert.rejects(prepare({ worktreeDir, packages: ['other'] }), /escaped authorized run/);
  assert.equal(commands, 0);
});

test('no-install runner refuses a binding that is not scoped to the configured package', (t) => {
  const root = temporary(t), cfg = config(root);
  for (const binding of [{ runId: 'bad', allowedPackages: [PACKAGE] },
    { runId: '2026-11-02-x', allowedPackages: ['other'] }, null]) {
    assert.throws(() => noInstallRunner({ root, config: cfg, inventory, binding }), /invalid no-install preparation/);
  }
});

test('bridge preserves exact frozen commands, copied read inputs and narrowed deadlines without invoking the package manager', async (t) => {
  const root = temporary(t), cfg = config(root), NODE = cfg.node;
  const binding = { runId: '2026-11-02-bridge', allowedPackages: [PACKAGE] };
  const dependencies = referenceTo(root, 'dependencies.json', dependencyManifest(inventory, RUNTIME));
  const recipe = { id: 'check', inputArgv: ['pm', '--filter', PACKAGE, 'lint:check'],
    argv: [NODE, `@worktree/${RUNTIME}/${frozenFile.path}`], cwd: PACKAGE, timeoutMs: 120000,
    executableSha256: bytesHash(fs.readFileSync(NODE)), dependencyManifest: dependencies,
    files: [{ path: `${RUNTIME}/${frozenFile.path}`, sha256: frozenFile.sha256 }] };
  const recipes = referenceTo(root, 'recipes.json', { schemaVersion: '1.0.0', recipes: [recipe] });
  const calls = [];
  let frozen = null;
  const runner = boundRunner({ root, config: cfg, inventory, expectedBinding: binding, dependencyManifests: [dependencies],
    readOnlyFiles: [recipes], commandRecipes: recipes, readFrozenBinding: () => frozen,
    execCli: (...args) => { calls.push(args); return 'checked'; } });
  assert.throws(() => runner.checkpointHydration, /binding mismatch/);
  frozen = { ...binding, taskPlanHash: 'a'.repeat(64) };
  const worktreeDir = path.join(root, 'state', binding.runId, 'worktrees/task');
  fs.mkdirSync(worktreeDir, { recursive: true });
  await runner.checkpointHydration.prepare({ worktreeDir, packages: [PACKAGE] });
  assert.equal(runner('pm', recipe.inputArgv.slice(1), { cwd: worktreeDir, timeout: 5000,
    env: { PASSWORD: 'must-not-inherit' } }), 'checked');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], NODE);
  assert.equal(calls[0][2].timeout, 5000);
  assert.equal(calls[0][2].env.PASSWORD, undefined);
  assert.deepEqual(JSON.parse(calls[0][2].input).recipe, recipe);
  for (const [command, args, cwd] of [
    ['pm', [...recipe.inputArgv.slice(1), '--fix'], worktreeDir],
    ['pm', ['install'], worktreeDir], [NODE, ['-e', ''], worktreeDir],
    ['pm', recipe.inputArgv.slice(1), root],
  ]) assert.throws(() => runner(command, args, { cwd }), /EvidenceAdmissionError/);
  fs.writeFileSync(path.join(worktreeDir, RUNTIME, frozenFile.path), 'changed');
  assert.throws(() => runner('pm', recipe.inputArgv.slice(1), { cwd: worktreeDir }), /file changed/);
  assert.equal(calls.length, 1);
  frozen = { ...frozen, taskPlanHash: 'b'.repeat(64) };
  assert.throws(() => runner.checkpointHydration, /rebound/);
});
