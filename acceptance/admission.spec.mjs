import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { acceptanceConfig } from './config.mjs';
import { assembleManifest, bindingRecords, unexpectedDirtyEntries, verifyAdmission } from './admission.mjs';

const config = (root) => acceptanceConfig({ profileId: 'p', repositoryId: 'repo', stateDir: 'state', reviewDir: 'rev', runsDir: 'runs',
  acceptanceEvidence: {
    canaryId: 'c1', slug: 'healthy', evidenceDir: 'ev', runtimeDir: 'rt', helpersDir: 'h', nodeExecutable: process.execPath,
    caseManifest: 'cm.json', runtimeSources: 'rs.json', package: { root: 'pkg' }, sandbox: { readOnlyBinds: [] },
    commands: { unit: { argv: [process.execPath, 'u'] } },
    canary: { spec: 's.md', tasks: 't.json', corpus: 'c.json', obligations: 'o.json', files: [{ path: 'pkg/a.spec.ts', kind: 'unit' }] } } }, root);

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(root, 'seed'), 'x');
  git('add', '.');
  git('-c', 'user.email=a@b', '-c', 'user.name=n', 'commit', '-qm', 'x');
  return { root: fs.realpathSync(root), head: git('rev-parse', 'HEAD') };
}

const approved = (root, head) => ({
  manifestVersion: 'repo-c1-admission', admission: 'APPROVED', downloadsAllowed: false, installationCommands: [],
  nodeExecutable: process.execPath, repositoryId: 'repo', mergeCanary: false, hostRoot: root, integrationBaseCommit: head,
  allowedPackages: ['pkg'], allowedPathPrefixes: ['pkg/a.spec.ts'],
  allowedOperations: { editIsolatedWorktree: true, runAllowlistedCommands: true, createDetachedWorktree: true,
    createBranch: false, createLocalCommits: false, push: false, openPullRequest: false, merge: false, deploy: false },
});

test('null, empty, blocked and misidentified manifests cannot authorize execution', async () => {
  const { root, head } = repository();
  for (const value of [null, {}, { ...approved(root, head), admission: 'BLOCKED' }]) {
    await assert.rejects(verifyAdmission(root, config(root), value), /not approved/);
  }
  const mutations = [
    [(m) => { m.manifestVersion = 'other-admission'; }, /not approved/],
    [(m) => { m.repositoryId = 'other'; }, /not approved/],
    [(m) => { m.nodeExecutable = '/usr/bin/other'; }, /not approved/],
    [(m) => { m.mergeCanary = true; }, /not approved/],
    [(m) => { m.downloadsAllowed = true; }, /not approved/],
    [(m) => { m.installationCommands = ['pm install']; }, /not approved/],
    [(m) => { m.hostRoot = os.tmpdir(); }, /wrong host root/],
    [(m) => { m.integrationBaseCommit = 'f'.repeat(40); }, /integration base drift/],
    [(m) => { m.allowedPackages = ['pkg', 'other']; }, /package scope/],
    [(m) => { m.allowedPackages = ['other']; }, /package scope/],
    [(m) => { m.allowedPathPrefixes = ['pkg/a.spec.ts', 'pkg/extra.ts']; }, /path scope/],
    [(m) => { m.allowedPathPrefixes = []; }, /path scope/],
    [(m) => { m.allowedOperations.push = true; }, /delivery operations forbidden/],
    [(m) => { m.allowedOperations.editIsolatedWorktree = false; }, /delivery operations forbidden/],
    [(m) => { delete m.allowedOperations; }, /delivery operations forbidden/],
  ];
  for (const [mutate, pattern] of mutations) {
    const manifest = approved(root, head);
    mutate(manifest);
    await assert.rejects(verifyAdmission(root, config(root), manifest), pattern);
  }
});

test('a manifest within scope proceeds to bound-record verification', async () => {
  const { root, head } = repository();
  await assert.rejects(verifyAdmission(root, config(root), approved(root, head)), (error) => !/scope|not approved|forbidden|drift|host root/.test(error.message));
});

test('only the started run\'s own untracked spec artifacts are tolerated as dirty', () => {
  const prefix = ['runs/2026-11-03-canary/'];
  const entries = (...paths) => `${paths.join('\0')}\0`;
  assert.deepEqual(unexpectedDirtyEntries(entries('?? runs/2026-11-03-canary/intent.md'), prefix), []);
  assert.equal(unexpectedDirtyEntries(entries('?? runs/2026-11-03-canary/intent.md'), []).length, 1);
  for (const dirty of ['?? runs/other-run/intent.md', ' M tools/x.mjs', 'A  runs/2026-11-03-canary/intent.md',
    '?? runs/2026-11-03-canary/../x', '?? apps/new.ts']) {
    assert.equal(unexpectedDirtyEntries(entries(dirty), prefix).length, 1, dirty);
  }
});

test('assembly is always BLOCKED and bound to the proposal bytes; bindings must match their schema version', () => {
  const bytes = Buffer.from('{"admission":"APPROVED"}');
  const assembled = assembleManifest(JSON.parse(bytes), bytes);
  assert.equal(assembled.admission, 'BLOCKED');
  assert.match(assembled.proposalSha256, /^[a-f0-9]{64}$/);
  assert.throws(() => bindingRecords('/', { bindings: {} }), /EvidenceAdmissionError/);
});
