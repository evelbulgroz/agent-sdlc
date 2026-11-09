import assert from 'node:assert/strict';
import test from 'node:test';
import { composeReceipt } from './offline-receipt.ts';

const inventory = { blockingRequirements: ['Audit native loader and shared libraries',
  'Exclude process escape or obtain explicit external containment approval'] };
const passed = { status: 'passed' };
const base = { inventory, corpusSha256: 'a'.repeat(64), inventorySha256: 'b'.repeat(64), baseCommitSha: 'c'.repeat(40) };

test('offline receipt passes only when every blocking requirement has passed evidence', () => {
  const components = { native: passed, writeLimits: passed };
  assert.deepEqual(composeReceipt({ ...base, components }).failures, []);
  assert.equal(composeReceipt({ ...base, components: { native: passed, writeLimits: { status: 'blocked' } } }).status, 'blocked');
  assert.equal(composeReceipt({ ...base, components: { native: passed } }).status, 'blocked');
});

test('offline receipt rejects unmapped blocking requirements', () => {
  const result = composeReceipt({ ...base, inventory: { blockingRequirements: ['Something new'] },
    components: { native: passed } });
  assert.match(result.failures[0], /unmapped/);
});

test('offline receipt hashes each component and never claims live qualification', () => {
  const receipt = composeReceipt({ ...base, components: { native: passed, writeLimits: passed } });
  assert.equal(receipt.liveQualified, false);
  assert.equal(receipt.providerOperations, 0);
  assert.match(receipt.components.native.sha256, /^[0-9a-f]{64}$/);
});
