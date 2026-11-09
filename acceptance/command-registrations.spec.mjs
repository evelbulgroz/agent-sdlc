import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCommandRegistrations } from './command-evidence.ts';

function fixture(t, commands) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-reg-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'pkg'));
  for (const file of ['pkg/a.mjs', 'pkg/b.mjs', 'pkg/pre.mjs', 'cases.json']) fs.writeFileSync(path.join(root, file), file);
  const pre = (id) => ({ id, argv: ['node', 'pre.mjs', id], pins: [{ file: 'pre.mjs' }] });
  const config = { repositoryId: 'repo', packageRoot: 'pkg', caseManifest: 'cases.json', pretest: [pre('one'), pre('two')], commands };
  return { root, config };
}
const searchPath = path.dirname(fs.realpathSync(process.execPath));

test('@ac AC-09 @case AC-09.2 a command runs every pretest step unless it names a subset, and unknown ids are rejected', async (t) => {
  const { root, config } = fixture(t, {
    unit: { argv: ['node', 'a.mjs'] },
    browser: { argv: ['node', 'b.mjs'], pretest: ['two'] },
    static: { argv: ['node', 'a.mjs'], pretest: [] },
  });
  const byLayer = Object.fromEntries((await buildCommandRegistrations(root, config, { searchPath })).map((r) => [r.adapterId, r]));
  assert.deepEqual(byLayer['repo-unit'].pretest.map((s) => s.id), ['one', 'two']);
  assert.deepEqual(byLayer['repo-browser'].pretest.map((s) => s.id), ['two']);
  assert.equal(byLayer['repo-static'].pretest, undefined);
  assert.notEqual(byLayer['repo-unit'].commandSha256, byLayer['repo-static'].commandSha256);
  const bad = fixture(t, { unit: { argv: ['node', 'a.mjs'], pretest: ['nope'] } });
  await assert.rejects(buildCommandRegistrations(bad.root, bad.config, { searchPath }), /unknown pretest step: nope/);
});
