import assert from 'node:assert/strict';
import test from 'node:test';
import { qualificationResult } from './qualification.mjs';

const corpus = (...ids) => ({ schemaVersion: '1.0.0', cases: ids.map((id) => ({ id })) });
const LOADER = '/lib64/ld-linux-x86-64.so.2';
const native = [{ path: 'bin/probe', interpreter: LOADER }];
const mentions = (result) => result.failures.some((failure) => failure.includes(LOADER));

test('qualification preserves every untested case rather than granting capabilities', () => {
  const result = qualificationResult(corpus('picker', 'focus'),
    { schemaVersion: '1.0.0', files: [{ path: 'browser' }] });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.observedCases, []);
  assert.deepEqual(result.untestedCases, ['picker', 'focus']);
  assert.throws(() => qualificationResult(null, null), /invalid qualification/);
  assert.throws(() => qualificationResult(corpus('a'), { schemaVersion: '1.0.0', files: [] }), /invalid runtime inventory/);
});

test('native loader qualification requires an exact hash-bound vendored interpreter path', () => {
  const inventory = (files) => ({ schemaVersion: '1.0.0', files, nativeInterpreters: native });
  assert.ok(mentions(qualificationResult(corpus('native'), inventory([{ path: 'bin/probe' }]))));
  const loader = { path: `sysroot${LOADER}`, sha256: 'b'.repeat(64) };
  assert.equal(mentions(qualificationResult(corpus('native'), inventory([{ path: 'bin/probe', sha256: 'a'.repeat(64) }, loader]))), false);
  assert.ok(mentions(qualificationResult(corpus('native'), inventory([{ ...loader, sha256: 'not-a-hash' }]))));
  const escaping = { schemaVersion: '1.0.0', files: [loader],
    nativeInterpreters: [{ path: 'bin/probe', interpreter: '/lib64/../ld.so' }] };
  assert.ok(qualificationResult(corpus('native'), escaping).failures.some((failure) => failure.includes('../ld.so')));
});
