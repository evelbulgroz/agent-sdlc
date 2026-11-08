import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { COMMANDS } from './cli.mjs';

const CLI = path.resolve(import.meta.dirname, 'cli.mjs');

function hostRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-acceptance-cli-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['.agents', 'ev/c1', 'rt/sysroot/usr/lib', 'rt/node_modules', 'helpers', 'pkg/src']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, '.agents/sdlc-host.json'), JSON.stringify({
    schemaVersion: '1.5.0', profileId: 'p', repositoryId: 'r', adapter: 'default',
    acceptanceEvidence: {
      canaryId: 'c1', slug: 's', evidenceDir: 'ev', runtimeDir: 'rt', helpersDir: 'helpers',
      nodeExecutable: process.execPath, caseManifest: 'cases.json', runtimeSources: 'sources.json',
      package: { root: 'pkg' }, sandbox: { readOnlyBinds: ['pkg/src'] },
      runners: { unit: { argv: [process.execPath, 'adapter.mjs'], bundleFiles: [] } },
    },
  }));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'pkg/package.json'), '{}');
  return root;
}

const cli = (cwd, ...argv) => {
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  return spawnSync(process.execPath, [CLI, ...argv], { cwd, encoding: 'utf8', env });
};

test('the dispatcher names every moved host command and refuses anything else', (t) => {
  assert.deepEqual([...COMMANDS].sort(), ['admission-approve', 'admission-assemble', 'admission-proposal', 'admission-records',
    'admission-regenerate', 'admission-verify', 'authorize', 'canary-execution', 'experiment-config', 'governor-resolution',
    'prompt-fit', 'readiness', 'registrations', 'role-definitions', 'runtime-dependencies',
    'runtime-inventory', 'runtime-materialize', 'workspace-bootstrap-verify']);
  const result = cli(hostRoot(t), 'bogus');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected one of: admission-assemble/);
});

test('commands read the runtime directory from the profile and fail closed on bad input', (t) => {
  const root = hostRoot(t);
  fs.writeFileSync(path.join(root, 'inventory.json'), JSON.stringify({ schemaVersion: '1.0.0', files: [] }));
  const result = cli(root, 'runtime-materialize', '--inventory', 'inventory.json');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid runtime materialization/);
  assert.equal(cli(root, 'admission-verify').status, 1);
});

test('canary-dependent commands fail closed when the profile has no canary block', (t) => {
  const root = hostRoot(t);
  for (const command of ['readiness', 'canary-execution']) {
    const args = command === 'canary-execution' ? [command, '--source', 'x.json'] : [command];
    const result = cli(root, ...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /acceptanceEvidence\.canary is not configured/);
  }
});

test('workspace-bootstrap-verify needs a root and a bound, unchanged bootstrap record', (t) => {
  const root = hostRoot(t);
  assert.match(cli(root, 'workspace-bootstrap-verify').stderr, /expected workspace bootstrap root/);
  const unbound = cli(root, 'workspace-bootstrap-verify', root);
  assert.equal(unbound.status, 1);
  assert.equal(unbound.stdout, '');
});
