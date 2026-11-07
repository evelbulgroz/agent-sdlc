import assert from 'node:assert/strict';
import test from 'node:test';
import { conformanceRequest, runAdapterProcess, verifyAdapterResult } from './conformance.mjs';
import { engineContracts } from './contracts.mjs';

const REFERENCE = new URL('./reference-adapter.mjs', import.meta.url).pathname;
const argv = [process.execPath, '--experimental-strip-types', REFERENCE];
const run = (input) => runAdapterProcess({ argv, cwd: process.cwd(), input });

test('the reference adapter reports exactly the selected cases, bound to the request', async () => {
  const request = conformanceRequest();
  const result = await run(JSON.stringify(request));
  const parsed = await verifyAdapterResult(request, result);
  assert.equal(parsed.cases.length, 2);
  assert.deepEqual(parsed.cases.find((entry) => entry.caseKey === 'ready').obligationIds, ['obligation-1', 'obligation-2']);
  assert.ok(parsed.cases.every((entry) => entry.outcome === 'passed'));
});

test('the reference adapter refuses malformed, oversized and mis-bound requests without a report', async () => {
  const request = conformanceRequest();
  const mismatched = structuredClone(request);
  mismatched.obligations[0].adapterBindingHash = 'c'.repeat(64);
  const unknownField = { ...request, extra: true };
  for (const input of ['not json', JSON.stringify(mismatched), JSON.stringify(unknownField),
    JSON.stringify({ ...request, padding: 'x'.repeat(1048577) })]) {
    const result = await run(input);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
  }
});

test('the checker rejects reports that are unbound, incomplete or padded', async () => {
  const request = conformanceRequest();
  const contracts = await engineContracts();
  const good = JSON.parse((await run(JSON.stringify(request))).stdout);
  const check = (value, code = 0) => verifyAdapterResult(request, { code, stdout: JSON.stringify(value) });
  await check(good);
  await assert.rejects(check(good, 1), /adapter exited/);
  await assert.rejects(check({ ...good, requestHash: 'd'.repeat(64) }), /not bound to its request/);
  await assert.rejects(check({ ...good, operationId: 'other' }), /not bound to its request/);
  await assert.rejects(check({ ...good, cases: good.cases.slice(1) }), /exactly the selected cases/);
  const extra = { ...good.cases[0], caseKey: 'unrequested' };
  await assert.rejects(check({ ...good, cases: [...good.cases, extra] }), /exactly the selected cases/);
  await assert.rejects(check({ ...good, cases: good.cases.map((entry) => ({ ...entry, obligationIds: ['obligation-1'] })) }),
    /obligation mismatch/);
  assert.equal(contracts.EvidenceReportSchema.safeParse({ ...good, cases: [{ ...good.cases[0], attempts: [] }] }).success, false);
});
