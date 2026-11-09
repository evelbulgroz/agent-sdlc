import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copyFrozenFiles } from './prepare-files.ts';
import { bytesHash } from './primitives.ts';

function fixture(t, count) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-files-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'source');
  const target = path.join(base, 'target');
  fs.mkdirSync(path.join(source, 'dir'), { recursive: true });
  fs.mkdirSync(target);
  const copies = [];
  for (let index = 0; index < count; index++) {
    const content = `frozen-${index}`;
    fs.writeFileSync(path.join(source, 'dir', `f${index}`), content);
    for (const destination of [`a/f${index}`, `b/nested/f${index}`]) {
      copies.push({ sourceRoot: source, source: `dir/f${index}`, destination,
        sha256: bytesHash(Buffer.from(content)), mode: 0o644 });
    }
  }
  return { source, target, copies };
}

const pooled = { inlineBelow: 0, workers: 3 };

test('worker pool copies every frozen file to each destination with verified bytes and modes', async (t) => {
  const { target, copies } = fixture(t, 40);
  await copyFrozenFiles(target, copies, pooled);
  for (const file of copies) {
    const destination = path.join(target, file.destination);
    assert.equal(bytesHash(fs.readFileSync(destination)), file.sha256);
    assert.equal(fs.statSync(destination).mode & 0o777, file.mode);
  }
  await copyFrozenFiles(target, copies, pooled);
});

test('worker pool fails closed on drifted source, drifted destination, wrong mode and symlinked directory', async (t) => {
  const drifted = fixture(t, 10);
  fs.writeFileSync(path.join(drifted.source, 'dir/f3'), 'drift');
  await assert.rejects(copyFrozenFiles(drifted.target, drifted.copies, pooled), /file changed: dir\/f3/);

  const resumed = fixture(t, 10);
  await copyFrozenFiles(resumed.target, resumed.copies, pooled);
  fs.writeFileSync(path.join(resumed.target, 'b/nested/f7'), 'drift');
  await assert.rejects(copyFrozenFiles(resumed.target, resumed.copies, pooled), /file changed: b\/nested\/f7/);

  const mode = fixture(t, 10);
  await copyFrozenFiles(mode.target, mode.copies, pooled);
  fs.chmodSync(path.join(mode.target, 'a/f2'), 0o600);
  await assert.rejects(copyFrozenFiles(mode.target, mode.copies, pooled), /executable mode changed/);

  const linked = fixture(t, 10);
  fs.symlinkSync(linked.source, path.join(linked.target, 'a'));
  await assert.rejects(copyFrozenFiles(linked.target, linked.copies, pooled), /unsafe preparation directory/);
});
