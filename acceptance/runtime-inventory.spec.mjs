import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bytesHash, verifyFile } from './primitives.mjs';
import {
  dependencyManifest, elfInterpreter, inventorySources, materialize, packageSources, verifyRuntime,
} from './runtime-inventory.mjs';

const RUNTIME = 'state/runtime';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  return root;
}

test('inventories and materializes exact regular-file bytes without installing', (t) => {
  const root = temporary(t);
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'file'), 'frozen');
  const inventory = inventorySources({ schemaVersion: '1.0.0', allowedSourceRoots: [source],
    entries: [{ source, destination: 'package', provenance: 'fixture', license: 'test' }] });
  assert.equal(inventory.files.length, 1);
  assert.equal(inventory.qualified, false);
  materialize(root, inventory, RUNTIME);
  assert.equal(fs.readFileSync(path.join(root, RUNTIME, 'package/file'), 'utf8'), 'frozen');
  assert.throws(() => materialize(root, inventory, RUNTIME), /already exists/);
  assert.throws(() => materialize(root, inventory, '../escape'), /EvidenceAdmissionError/);
  assert.throws(() => materialize(root, inventory), /invalid runtime materialization/);
});

test('source drift blocks materialization before any runtime is written', (t) => {
  const root = temporary(t);
  const file = path.join(root, 'input');
  fs.writeFileSync(file, 'original');
  const inventory = inventorySources({ schemaVersion: '1.0.0', allowedSourceRoots: [root],
    entries: [{ source: file, destination: 'input', provenance: 'fixture', license: 'test' }] });
  fs.writeFileSync(file, 'changed');
  assert.throws(() => materialize(root, inventory, RUNTIME), /source drift/);
  assert.equal(fs.existsSync(path.join(root, RUNTIME)), false);
});

test('dependency manifest binds every file hash under the configured runtime path', () => {
  const inventory = { schemaVersion: '1.0.0', files: [
    { path: 'z/runtime', sha256: 'a'.repeat(64), source: '/private/source', mode: 0o755 },
    { path: 'a/runtime', sha256: 'b'.repeat(64) },
  ] };
  const expected = { schemaVersion: '1.0.0', files: [
    { path: `${RUNTIME}/a/runtime`, sha256: 'b'.repeat(64) },
    { path: `${RUNTIME}/z/runtime`, sha256: 'a'.repeat(64) },
  ] };
  assert.deepEqual(dependencyManifest(inventory, RUNTIME), expected);
  assert.deepEqual(dependencyManifest({ ...inventory, files: [...inventory.files].reverse() }, RUNTIME), expected);
  for (const value of [null, {}, { ...inventory, files: [] },
    { ...inventory, files: [inventory.files[0], inventory.files[0]] },
    { ...inventory, files: [{ path: '../escape', sha256: 'a'.repeat(64) }] },
    { ...inventory, files: [{ path: 'runtime', sha256: '' }] }]) {
    assert.throws(() => dependencyManifest(value, RUNTIME), /EvidenceAdmissionError/);
  }
  assert.throws(() => dependencyManifest(inventory, '/abs'), /EvidenceAdmissionError/);
});

test('rejects unapproved symlink targets, cycles and symlinked retrieval parents', (t) => {
  const root = temporary(t);
  const allowed = path.join(root, 'allowed');
  fs.mkdirSync(allowed);
  fs.writeFileSync(path.join(root, 'outside'), 'outside');
  fs.symlinkSync(path.join(root, 'outside'), path.join(allowed, 'escape'));
  const sources = { schemaVersion: '1.0.0', allowedSourceRoots: [allowed],
    entries: [{ source: allowed, destination: 'input', provenance: 'fixture', license: 'test' }] };
  assert.throws(() => inventorySources(sources), /unapproved source/);
  fs.unlinkSync(path.join(allowed, 'escape'));
  fs.symlinkSync(allowed, path.join(allowed, 'loop'));
  assert.throws(() => inventorySources(sources), /cycle/);
  fs.symlinkSync(root, path.join(root, 'alias'));
  assert.throws(() => verifyFile(root, { path: 'alias/outside',
    sha256: bytesHash(Buffer.from('outside')) }), /non-regular/);
});

test('null, empty and unqualified inputs are rejected', () => {
  assert.throws(() => inventorySources(null), /empty source/);
  assert.throws(() => inventorySources({ schemaVersion: '1.0.0', entries: [] }), /empty source/);
  assert.throws(() => verifyRuntime(process.cwd(), { schemaVersion: '1.0.0', qualified: false }), /not qualified/);
});

test('reads the ELF interpreter from program headers and rejects malformed headers', () => {
  const bytes = Buffer.alloc(160);
  bytes.write('7f454c46', 0, 'hex');
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(1, 56);
  bytes.writeUInt32LE(3, 64);
  bytes.writeBigUInt64LE(120n, 72);
  bytes.writeBigUInt64LE(BigInt(Buffer.byteLength('/lib64/ld-linux-x86-64.so.2') + 1), 96);
  bytes.write('/lib64/ld-linux-x86-64.so.2', 120);
  assert.equal(elfInterpreter(bytes), '/lib64/ld-linux-x86-64.so.2');
  assert.equal(elfInterpreter(Buffer.from('not elf at all, just text padding to sixty-four bytes long........')), null);
  const truncated = Buffer.from(bytes);
  truncated.writeUInt16LE(500, 56);
  assert.throws(() => elfInterpreter(truncated), /invalid ELF headers/);
});

test('cyclic package dependencies materialize as finite regular directories', (t) => {
  const root = temporary(t);
  const modules = path.join(root, 'node_modules');
  for (const [name, dependency] of [['first', 'second'], ['second', 'first']]) {
    const directory = path.join(modules, name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
      name, version: '1.0.0', license: 'MIT', dependencies: { [dependency]: '1.0.0' },
    }));
    fs.writeFileSync(path.join(directory, 'index.js'), 'module.exports = true;');
  }
  const sources = packageSources(root, ['first']);
  assert.deepEqual(sources.entries.map((entry) => entry.destination),
    ['node_modules/first', 'node_modules/second']);
  const inventory = inventorySources({
    schemaVersion: '1.0.0', entries: sources.entries, allowedSourceRoots: sources.sourceRoots,
  });
  materialize(root, inventory, RUNTIME);
  assert.ok(fs.statSync(path.join(root, RUNTIME, 'node_modules/second/index.js')).isFile());
});
