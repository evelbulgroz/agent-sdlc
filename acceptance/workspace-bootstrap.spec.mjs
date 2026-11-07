import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { bytesHash } from './primitives.mjs';
import { frozenWorkspacePreparation, snapshotWorkspace, verifyWorkspaceBootstrap } from './workspace-bootstrap.mjs';
import { taskQualityFixture } from '../testing/task-quality-fixture.mjs';
import { sha256 } from '../policy/contracts.ts';
import { checkpointHydrationBinding } from '../workflow/checkpoint-hydration.ts';

const PREFIX = 'state/evidence/c1/bootstrap-fixture';
const CONFIG = Object.freeze({ output: 'state/evidence/c1' });

function write(root, relative, value) {
  const contents = Buffer.from(`${JSON.stringify(value)}\n`);
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return { path: relative, sha256: bytesHash(contents) };
}

function fixture(t, { qualification = false } = {}) {
  const f = taskQualityFixture(t);
  f.auth = { ...f.auth, expiresAt: new Date(Date.now() + 3600000).toISOString() };
  f.store.generations.saveAuthorization(f.auth);
  f.store.database.prepare('UPDATE runs SET state_json = ?, state_hash = ? WHERE run_id = ?')
    .run(JSON.stringify(f.snapshot), sha256(f.snapshot), f.runId);
  const root = qualification ? f.rootDir : f.worktreeDir;
  const inputs = [
    write(root, 'package.json', { name: 'bootstrap-fixture', private: true }),
    write(root, 'pnpm-workspace.yaml', { packages: [] }),
    write(root, 'pnpm-lock.yaml', { lockfileVersion: '9.0' }),
  ];
  fs.mkdirSync(path.join(root, 'node_modules/dep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/dep/index.js'), 'export default 1;\n');
  fs.symlinkSync('dep', path.join(root, 'node_modules/alias'));
  const layout = write(root, `${PREFIX}/layout.json`, snapshotWorkspace(root, ['node_modules']));
  const context = qualification
    ? { mode: 'offline-qualification', repositoryRoot: f.rootDir, baseCommitSha: f.base,
      spec: write(root, `${PREFIX}/spec.json`, { fixture: 'provider-free qualification' }) }
    : { mode: 'checkpoint', repositoryRoot: f.rootDir,
      binding: checkpointHydrationBinding(f.plan, f.snapshot, f.auth) };
  const configuration = { schemaVersion: '1.0.0', context, deadline: Date.now() + 60000, inputs, layout };
  const reference = () => write(root, `${PREFIX}/configuration.json`, configuration);
  return { ...f, root, inputs, configuration, reference };
}

const verify = (root, reference) => verifyWorkspaceBootstrap(root, CONFIG, reference);

test('checkpoint bootstrap reads the real frozen authorization without changing its database', async t => {
  const f = fixture(t);
  const events = f.store.listEvents(f.runId);
  const state = f.store.getRun(f.runId);
  const reference = f.reference();
  const result = await verify(f.root, reference);
  assert.equal(result.installation, 'not-invoked');
  assert.equal(result.mode, 'checkpoint');
  assert.equal(result.configurationHash, reference.sha256);
  assert.deepEqual(f.store.getRun(f.runId), state);
  assert.deepEqual(f.store.listEvents(f.runId), events);
});

test('references outside the configured output prefix are rejected', async t => {
  const f = fixture(t);
  const reference = f.reference();
  const moved = write(f.root, 'elsewhere/configuration.json', f.configuration);
  await assert.rejects(verify(f.root, moved), /unbound bootstrap reference/);
  await assert.rejects(verifyWorkspaceBootstrap(f.root, { output: 'other/prefix' }, reference),
    /unbound bootstrap reference/);
});

test('run, spec, base, plan, adapters and path scope cannot be rebound', async t => {
  const f = fixture(t), original = structuredClone(f.configuration.context.binding);
  for (const change of [
    { runId: '2026-11-02-other' }, { approvedSpecHash: 'b'.repeat(64) },
    { baseCommitSha: 'b'.repeat(40) }, { taskPlanHash: 'b'.repeat(64) },
    { adapterBindingsHash: 'b'.repeat(64) }, { allowedPackages: ['other'] },
    { allowedPathPrefixes: ['other'] },
  ]) {
    f.configuration.context.binding = { ...original, ...change };
    await assert.rejects(verify(f.root, f.reference()), /bootstrap escaped|frozen binding changed/);
  }
});

test('an unfrozen runtime cannot use a previously prepared bootstrap record', async t => {
  const f = fixture(t), state = { ...f.snapshot, taskPlanFrozen: false };
  f.store.database.prepare('UPDATE runs SET state_json = ?, state_hash = ? WHERE run_id = ?')
    .run(JSON.stringify(state), sha256(state), f.runId);
  await assert.rejects(verify(f.root, f.reference()), /frozen authorized plan/);
});

test('expired persisted authorization cannot use a previously prepared bootstrap record', async t => {
  const f = fixture(t);
  f.store.generations.saveAuthorization({ ...f.auth, expiresAt: new Date(Date.now() - 1).toISOString() });
  await assert.rejects(verify(f.root, f.reference()), /authorization expired/);
});

test('nil, empty, expired, unknown and changed bootstrap records fail closed', async t => {
  const f = fixture(t);
  for (const reference of [null, {}, { path: '../escape', sha256: 'a'.repeat(64) }]) {
    await assert.rejects(verify(f.root, reference));
  }
  const original = structuredClone(f.configuration);
  for (const change of [{ inputs: [] }, { deadline: Date.now() - 1 }, { unknown: true }, { context: null }]) {
    Object.assign(f.configuration, original, change);
    await assert.rejects(verify(f.root, f.reference()));
    delete f.configuration.unknown;
  }
  Object.assign(f.configuration, original);
  const reference = f.reference();
  fs.appendFileSync(path.join(f.root, reference.path), ' ');
  await assert.rejects(verify(f.root, reference), /reference changed/);
});

test('metadata omissions, dependency edits, additions and link substitutions are detected', async t => {
  const f = fixture(t);
  const first = f.configuration.inputs.shift();
  await assert.rejects(verify(f.root, f.reference()), /incomplete workspace metadata/);
  f.configuration.inputs.unshift(first);
  const reference = f.reference();
  fs.appendFileSync(path.join(f.root, 'package.json'), ' ');
  await assert.rejects(verify(f.root, reference), /file changed/);
  fs.writeFileSync(path.join(f.root, 'package.json'), `${JSON.stringify({ name: 'bootstrap-fixture', private: true })}\n`);
  fs.writeFileSync(path.join(f.root, 'node_modules/dep/index.js'), 'changed');
  await assert.rejects(verify(f.root, reference), /dependency layout changed/);
  fs.writeFileSync(path.join(f.root, 'node_modules/dep/index.js'), 'export default 1;\n');
  fs.writeFileSync(path.join(f.root, 'node_modules/extra'), 'unexpected');
  await assert.rejects(verify(f.root, reference), /dependency layout changed/);
  fs.unlinkSync(path.join(f.root, 'node_modules/extra'));
  fs.unlinkSync(path.join(f.root, 'node_modules/alias'));
  fs.symlinkSync('./dep', path.join(f.root, 'node_modules/alias'));
  await assert.rejects(verify(f.root, reference), /dependency layout changed/);
});

test('dependency snapshots reject escaping links and symlinked root parents', t => {
  const f = fixture(t);
  fs.symlinkSync('../../../outside', path.join(f.root, 'node_modules/escape'));
  assert.throws(() => snapshotWorkspace(f.root, ['node_modules']), /link escaped/);
  fs.unlinkSync(path.join(f.root, 'node_modules/escape'));
  fs.symlinkSync('node_modules', path.join(f.root, 'alias'));
  assert.throws(() => snapshotWorkspace(f.root, ['node_modules', 'alias/node_modules']),
    /non-regular workspace dependency root/);
  for (const value of [null, [], ['other'], ['node_modules', 'node_modules']]) {
    assert.throws(() => snapshotWorkspace(f.root, value), /dependency roots/);
  }
});

test('missing link targets remain frozen as absent, never admitted as readable dependencies', t => {
  const f = fixture(t);
  fs.symlinkSync('missing', path.join(f.root, 'node_modules/old-alias'));
  const first = snapshotWorkspace(f.root, ['node_modules']);
  assert.equal(first.entries.find(entry => entry.path === 'node_modules/old-alias').resolved, null);
  fs.mkdirSync(path.join(f.root, 'node_modules/missing'));
  assert.notDeepEqual(snapshotWorkspace(f.root, ['node_modules']), first);
});

test('offline qualification stays separate from a live checkpoint authorization', async t => {
  const f = fixture(t, { qualification: true });
  assert.equal((await verify(f.root, f.reference())).mode, 'offline-qualification');
  f.configuration.context.baseCommitSha = 'b'.repeat(40);
  await assert.rejects(verify(f.root, f.reference()), /qualification base changed/);
  const live = fixture(t);
  live.configuration.context = { mode: 'offline-qualification', repositoryRoot: live.root,
    baseCommitSha: live.base, spec: live.inputs[0] };
  await assert.rejects(verify(live.root, live.reference()), /qualification cannot substitute/);
});

test('canonical dependency preparation preserves link identities, absent targets, modes and partial-copy recovery', t => {
  const f = fixture(t, { qualification: true });
  fs.chmodSync(path.join(f.root, 'node_modules/dep'), 0o750);
  fs.chmodSync(path.join(f.root, 'node_modules/dep/index.js'), 0o755);
  fs.symlinkSync('missing', path.join(f.root, 'node_modules/absent'));
  const expected = snapshotWorkspace(f.root, ['node_modules']);
  const reference = write(f.root, `${PREFIX}/canonical-layout.json`, expected);
  const target = path.join(f.root, 'preparation');
  fs.mkdirSync(path.join(target, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(target, 'node_modules/dep'), { mode: 0o750 });
  const preparation = frozenWorkspacePreparation(f.root, CONFIG, reference);
  preparation.prepare(target);
  preparation.prepare(target);
  assert.deepEqual(snapshotWorkspace(target, ['node_modules']), expected);
  assert.equal(fs.readlinkSync(path.join(target, 'node_modules/alias')), 'dep');
  assert.equal(fs.existsSync(path.join(target, 'node_modules/absent')), false);
  assert.deepEqual(preparation.files.map(file => file.path), ['node_modules/dep/index.js']);
  fs.writeFileSync(path.join(target, 'node_modules/dep/index.js'), 'drift');
  assert.throws(() => preparation.prepare(target), /file changed/);
  assert.equal(fs.readFileSync(path.join(target, 'node_modules/dep/index.js'), 'utf8'), 'drift');
});

test('canonical preparation rejects source, manifest, directory and link drift without an installation fallback', t => {
  const f = fixture(t, { qualification: true });
  const reference = f.configuration.layout;
  for (const [invalid, error] of [[null, /unbound bootstrap reference/],
    [{}, /unsafe relative path: undefined/], [{ ...reference, sha256: '0'.repeat(64) }, /bootstrap reference changed/]]) {
    assert.throws(() => frozenWorkspacePreparation(f.root, CONFIG, invalid), error);
  }
  const preparation = frozenWorkspacePreparation(f.root, CONFIG, reference);
  assert.throws(() => preparation.prepare(f.root), /target escaped/);
  const target = path.join(f.root, 'preparation');
  fs.mkdirSync(target);
  fs.symlinkSync('../node_modules', path.join(target, 'node_modules'));
  assert.throws(() => preparation.prepare(target), /unsafe workspace preparation directory/);
  fs.unlinkSync(path.join(target, 'node_modules'));
  preparation.prepare(target);
  fs.unlinkSync(path.join(target, 'node_modules/alias'));
  fs.symlinkSync('./dep', path.join(target, 'node_modules/alias'));
  assert.throws(() => preparation.prepare(target), /workspace preparation link changed/);
  fs.appendFileSync(path.join(f.root, reference.path), ' ');
  assert.throws(() => preparation.prepare(target), /reference changed/);
  fs.writeFileSync(path.join(f.root, reference.path), `${JSON.stringify(snapshotWorkspace(f.root, ['node_modules']))}\n`);
  fs.writeFileSync(path.join(f.root, 'node_modules/dep/index.js'), 'source drift');
  assert.throws(() => preparation.prepare(target), /source changed/);
});
