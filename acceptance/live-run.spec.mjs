import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { providerEnvironment, sandboxLayout, childEnvironment } from './live-run.ts';
import { launchSupervised } from './supervisor.ts';

const NODE = process.execPath;
const config = (root, extra = {}) => ({ root, node: NODE, stateDir: 'state', runsDir: 'runs', reviewDir: 'review',
  providerCredentials: ['PROVIDER_A_KEY', 'PROVIDER_B_KEY'], ...extra });

test('provider credentials pass through by declared name only when present', () => {
  assert.deepEqual(providerEnvironment(config('/r'), { PROVIDER_A_KEY: 'x', HOME: '/h', OTHER_API_KEY: 'y', PROVIDER_B_KEY: '' }),
    { PROVIDER_A_KEY: 'x' });
  assert.deepEqual(providerEnvironment(config('/r', { providerCredentials: [] }), { PROVIDER_A_KEY: 'x' }), {});
});

test('the sandbox exposes git and the repository read-only with only runtime state writable', async (t) => {
  const parent = path.resolve('tools/.agent-sdlc/test-fixtures');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'live-spec-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'original');
  const engine = process.cwd(), modelUsage = path.join(root, 'usage-lib');
  fs.mkdirSync(modelUsage);
  const layout = sandboxLayout({ config: config(root), manifest: { shared: { governorStateRoot: 'governor' } }, engine, modelUsage });
  const real = fs.realpathSync(root);
  assert.deepEqual(layout.writable.map((mount) => path.relative(real, mount.source)).sort(),
    ['.git', 'governor', 'review', 'runs', 'state', 'tools/.model-usage']);
  assert.equal(childEnvironment({ engine, modelUsage }).AGENT_SDLC_PATH, fs.realpathSync(engine));
  const program = `
    const fs = require('node:fs'), cp = require('node:child_process');
    const out = { git: cp.execFileSync('/usr/bin/git', ['--version'], { encoding: 'utf8' }).startsWith('git version') };
    try { fs.writeFileSync(${JSON.stringify(`${real}/tracked.txt`)}, 'changed'); out.rootWritable = true; } catch { out.rootWritable = false; }
    fs.writeFileSync(${JSON.stringify(`${real}/state/ok`)}, 'ok');
    out.resolver = fs.existsSync('/etc/resolv.conf');
    console.log(JSON.stringify(out));`;
  const result = await launchSupervised({ argv: [NODE, '-e', program], cwd: real, deadline: Date.now() + 60000, ...layout });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { git: true, rootWritable: false, resolver: true });
  assert.equal(fs.readFileSync(path.join(real, 'tracked.txt'), 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(real, 'state/ok'), 'utf8'), 'ok');
});

test('launcher symlinks must be absolute, unique and outside the scratch mounts', async () => {
  const base = { argv: [NODE, '-e', ''], cwd: '/', deadline: Date.now() + 5000,
    readOnly: [{ source: '/usr', destination: '/usr' }] };
  for (const symlinks of [[{ target: 'usr/bin', destination: 'bin' }], [{ target: 'x', destination: '/tmp/x' }],
    [{ target: 'x', destination: '/usr' }, { target: 'x', destination: '/usr' }]]) {
    await assert.rejects(launchSupervised({ ...base, symlinks }), /unsafe launcher/);
  }
});
