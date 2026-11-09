import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { writeBinShims } from './bin-shims.ts';
import { isCanonicalPreflight, runCanonicalPreflight } from './preflight-bridge.ts';
import { validateRecipe } from './recipes.ts';

const SHA = 'c9bd300a3ff5bd72ca089f843afa3c230dc8d2c2';
const PREFLIGHT = ['pm', 'run', 'verify', '--', '--base'];
const argv = [...PREFLIGHT.slice(1), SHA];
const STATE_DIR = 'state/runs';
const RUN_ID = '2026-11-04-example';

function shimFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bin-shims-'));
  const modules = path.join(root, 'pkg/node_modules');
  const add = (name, manifest, files) => {
    fs.mkdirSync(path.join(modules, name, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(modules, name, 'package.json'), JSON.stringify(manifest));
    for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(modules, name, file), body);
  };
  add('tool', { bin: { tool: 'bin/cli.js' } }, { 'bin/cli.js': 'console.log("ran", process.argv[2]);' });
  add('@scope/single', { bin: 'bin/run' }, { 'bin/run': '#!/usr/bin/env node\nconsole.log("scoped");' });
  add('native', { bin: { native: 'bin/native' } }, { 'bin/native': '\x7fELF' });
  add('escape', { bin: { escape: '../../tool/bin/cli.js' } }, {});
  return { root, modules };
}

test('shims resolve package CLIs from the copied node_modules using the supplied node', () => {
  const { root, modules } = shimFixture();
  try {
    writeBinShims(root, 'pkg', process.execPath);
    assert.equal(execFileSync(path.join(modules, '.bin/tool'), ['x'], { encoding: 'utf8' }).trim(), 'ran x');
    assert.equal(execFileSync(path.join(modules, '.bin/single'), { encoding: 'utf8' }).trim(), 'scoped');
    assert.deepEqual(fs.readdirSync(path.join(modules, '.bin')).sort(), ['single', 'tool']);
    writeBinShims(root, 'pkg', process.execPath);
    assert.throws(() => writeBinShims(root, 'pkg', 'node'), /absolute node executable/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('only the exact configured preflight argv is recognized', () => {
  assert.equal(isCanonicalPreflight('pm', argv, PREFLIGHT), true);
  assert.equal(isCanonicalPreflight('pm', [...argv, '--skip'], PREFLIGHT), false);
  assert.equal(isCanonicalPreflight('pm', [...argv.slice(0, -1), 'main'], PREFLIGHT), false);
  assert.equal(isCanonicalPreflight('other', argv, PREFLIGHT), false);
  assert.equal(isCanonicalPreflight('pm', [...argv.slice(0, -1), SHA.toUpperCase()], PREFLIGHT), false);
  assert.equal(isCanonicalPreflight('pm', argv, undefined), false);
});

function preflightRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-bridge-')));
}
const base = { stateDir: STATE_DIR, node: '/opt/node/bin/node', preflight: PREFLIGHT, runId: RUN_ID, baseCommitSha: SHA, args: argv };

test('preflight runs in the run worktree with a credential-free environment', () => {
  const root = preflightRoot();
  const worktree = path.join(root, STATE_DIR, RUN_ID, 'worktrees/integration');
  fs.mkdirSync(worktree, { recursive: true });
  process.env.OPENAI_API_KEY = 'secret';
  let seen;
  const exec = (command, args, options) => { seen = { command, args, options, home: fs.existsSync(options.env.HOME) }; return 'ok'; };
  const result = runCanonicalPreflight({ ...base, root, options: { cwd: worktree, timeout: 5000 }, exec });
  delete process.env.OPENAI_API_KEY;
  assert.equal(result, 'ok');
  assert.equal(seen.command, 'pm');
  assert.deepEqual(seen.args, argv);
  assert.equal(seen.options.env.PATH.split(':')[0], '/opt/node/bin');
  assert.equal(seen.options.env.OPENAI_API_KEY, undefined);
  assert.equal(seen.home, true);
  assert.equal(fs.existsSync(seen.options.env.HOME), false);
});

test('preflight refuses a worktree outside the authorized run', () => {
  const root = preflightRoot();
  fs.mkdirSync(path.join(root, 'elsewhere'));
  assert.throws(() => runCanonicalPreflight({ ...base, root, options: { cwd: path.join(root, 'elsewhere') }, exec: () => 'no' }),
    /escaped authorized run/);
});

test('preflight refuses another base commit and a non-canonical command', () => {
  const root = preflightRoot();
  assert.throws(() => runCanonicalPreflight({ ...base, root, baseCommitSha: 'd'.repeat(40), options: { cwd: root }, exec: () => 'no' }),
    /authorized base commit/);
  assert.throws(() => runCanonicalPreflight({ ...base, root, args: [...argv, '--skip'], options: { cwd: root }, exec: () => 'no' }),
    /not the canonical preflight/);
});

test('recipes are bound to the configured node, package root and package manager', () => {
  const config = { node: '/opt/node/bin/node', packageRoot: 'pkg', packageManager: 'pm' };
  const recipe = { id: 'lint', inputArgv: ['pm', 'run', 'lint'], argv: ['/opt/node/bin/node', 'x.js'],
    executableSha256: 'a'.repeat(64), dependencyManifest: { path: 'deps.json', sha256: 'b'.repeat(64) },
    timeoutMs: 1000, cwd: 'pkg', files: [{ path: 'x.js', sha256: 'c'.repeat(64) }] };
  assert.doesNotThrow(() => validateRecipe(recipe, config));
  for (const bad of [{ ...recipe, cwd: 'other' }, { ...recipe, argv: ['/usr/bin/node'] },
    { ...recipe, inputArgv: ['npm', 'run'] }, { ...recipe, timeoutMs: 120001 }, { ...recipe, files: [] }]) {
    assert.throws(() => validateRecipe(bad, config), /invalid frozen command recipe/);
  }
});
