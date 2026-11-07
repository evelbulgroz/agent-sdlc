import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { ExperimentLedger } from './experiment-ledger.mjs';
import { ExperimentGovernor } from './experiment-governor.mjs';
import { createLedgerBroker, RemoteExperimentLedger } from './experiment-broker.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'experiment-ledger-'));
  const scenarioCaps = { logicalCalls: 2, physicalCalls: 3, inputTokens: 60000,
    outputTokens: 18000, costMicrousd: 150 };
  const configuration = {
    logicalCalls: 4, physicalCalls: 6, inputTokens: 120000, outputTokens: 36000,
    costMicrousd: 300, maxAttemptCostMicrousd: 50, maxElapsedMs: 1000,
    scenarios: {
      healthy: { ...scenarioCaps, runId: '2026-11-02-healthy' },
      defect: { ...scenarioCaps, runId: '2026-11-02-defect' },
    },
    dispatchInventory: ['healthy', 'defect'].flatMap((scenario, index) => [
      { scenario, runId: `2026-11-02-${index ? 'defect' : 'healthy'}`, roleId: 'implementer',
        logicalCalls: 1, maxPhysicalAttempts: 1, maxPromptTokens: 20000, maxCompletionTokens: 6000 },
      { scenario, runId: `2026-11-02-${index ? 'defect' : 'healthy'}`, roleId: 'critic-reviewer',
        logicalCalls: 1, maxPhysicalAttempts: 2, maxPromptTokens: 20000, maxCompletionTokens: 6000 },
    ]),
  };
  let time = 100;
  const file = path.join(root, 'experiment.sqlite');
  const ledger = new ExperimentLedger(file, configuration, { now: () => time });
  t.after(() => { ledger.close(); fs.rmSync(root, { recursive: true }); });
  ledger.begin();
  return { ledger, file, configuration, setTime: (value) => { time = value; } };
}
const request = { runId: '2026-11-02-healthy', operationId: 'operation',
  attribution: { roleId: 'critic-reviewer' } };
const charge = { logicalCalls: 1, physicalCalls: 2, inputTokens: 40000, outputTokens: 12000, costMicrousd: 100 };

test('shared caps span run IDs and do not refill after uncertain completion', (t) => {
  const { ledger, configuration } = fixture(t);
  const implementer = { ...request, operationId: 'implementer',
    attribution: { roleId: 'implementer' } };
  const implementerCharge = { logicalCalls: 1, physicalCalls: 1,
    inputTokens: 20000, outputTokens: 6000, costMicrousd: 50 };
  ledger.reserve(request, 'healthy', charge);
  ledger.settle(request);
  ledger.reserve(implementer, 'healthy', implementerCharge);
  ledger.settle(implementer);
  const defectCritic = { ...request, runId: '2026-11-02-defect', operationId: 'second' };
  ledger.reserve(defectCritic, 'defect', charge);
  ledger.settle(defectCritic);
  const defectImplementer = { ...implementer, runId: '2026-11-02-defect', operationId: 'fourth' };
  ledger.reserve(defectImplementer, 'defect', implementerCharge);
  ledger.settle(defectImplementer);
  const totals = ledger.db.prepare('SELECT charge FROM reservations').all().reduce((sum, row) => {
    const charged = JSON.parse(row.charge);
    for (const key of Object.keys(sum)) sum[key] += charged[key];
    return sum;
  }, { logicalCalls: 0, physicalCalls: 0, inputTokens: 0, outputTokens: 0, costMicrousd: 0 });
  assert.deepEqual(totals, Object.fromEntries(
    ['logicalCalls', 'physicalCalls', 'inputTokens', 'outputTokens', 'costMicrousd']
      .map(key => [key, configuration[key]])));
  assert.throws(() => ledger.reserve({ ...defectCritic, operationId: 'third' }, 'defect', charge),
    /dispatch inventory exhausted/);
  assert.throws(() => ledger.reserve(request, 'healthy', charge), /already charged/);
});

test('concurrent recovery cannot retire a live provider reservation', (t) => {
  const { ledger, file, configuration } = fixture(t);
  const other = new ExperimentLedger(file, configuration, { now: () => 100 });
  try {
    other.begin();
    ledger.reserve(request, 'healthy', charge);
    assert.throws(() => other.reserve({ ...request, runId: '2026-11-02-defect', operationId: 'second' }, 'defect', charge), /concurrency/);
    assert.throws(() => other.recover(), /live reservation owner/);
    assert.throws(() => other.settle(request), /another owner/);
    ledger.settle(request);
    other.reserve({ ...request, runId: '2026-11-02-defect', operationId: 'second' }, 'defect', charge);
  } finally { other.close(); }
});

test('recovery of an exited owner retains its full charge across reopen', (t) => {
  const { ledger, file, configuration } = fixture(t);
  const moduleUrl = new URL('./experiment-ledger.mjs', import.meta.url).href;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {ExperimentLedger} from ${JSON.stringify(moduleUrl)};
    const ledger=new ExperimentLedger(${JSON.stringify(file)},${JSON.stringify(configuration)},{now:()=>100});
    ledger.begin();
    ledger.reserve(${JSON.stringify(request)},'healthy',${JSON.stringify(charge)});
    ledger.close();
  `], { stdio: 'pipe', env });
  ledger.recover();
  assert.throws(() => ledger.reserve({ ...request, operationId: 'second' }, 'healthy', charge),
    /dispatch inventory exhausted/);
  assert.throws(() => ledger.reserve(request, 'healthy', charge), /already charged/);
});

test('pause/restart does not reset deadline and backwards clock blocks', (t) => {
  const { ledger, file, configuration, setTime } = fixture(t);
  setTime(1100);
  assert.throws(() => ledger.begin(), /deadline/);
  const reopened = new ExperimentLedger(file, configuration, { now: () => 1099 });
  try { assert.throws(() => reopened.begin(), /clock/); } finally { reopened.close(); }
  setTime(1098);
  assert.throws(() => ledger.clock(), /clock/);
});

test('time between operator commands is not charged but live process time is', (t) => {
  const { file, configuration } = fixture(t);
  let time = 50_000;
  const later = new ExperimentLedger(file, configuration, { now: () => time });
  try {
    assert.equal(later.clock().deadline, 51_000);
    time = 50_600;
    assert.equal(later.clock().deadline, 51_000);
    time = 51_000;
    assert.throws(() => later.clock(), /deadline/);
  } finally { later.close(); }
});

test('terminal accounting permits unused allowance but rejects overcharge', (t) => {
  const { ledger } = fixture(t);
  ledger.reserve(request, 'healthy', charge);
  assert.throws(() => ledger.settle(request, { ...charge, physicalCalls: 3 }), /exceeds/);
  ledger.settle(request, { logicalCalls: 1, physicalCalls: 1, inputTokens: 10, outputTokens: 5, costMicrousd: 1 });
  ledger.reserve({ ...request, runId: '2026-11-02-defect', operationId: 'second' }, 'defect',
    { logicalCalls: 1, physicalCalls: 1, inputTokens: 10, outputTokens: 5, costMicrousd: 1 });
});

test('null/empty configuration and unbound runs never reserve', (t) => {
  const { ledger, file } = fixture(t);
  assert.throws(() => new ExperimentLedger(file, null), /invalid experiment/);
  assert.throws(() => ledger.reserve({ runId: 'outside', operationId: 'x' }, 'healthy', charge), /unbound/);
  assert.throws(() => ledger.reserve(request, 'healthy', {}), /invalid reservation/);
});

test('all-role wrapper narrows attempts and retains uncertain provider charges', async (t) => {
  const { ledger } = fixture(t);
  let calls = 0;
  const wrapper = new ExperimentGovernor({
    ledger, scenario: 'healthy', maxAttemptCostMicrousd: 50,
    governor: {
      synthetic: false, execute: async (value) => {
        calls += 1;
        assert.equal(value.requestedLimits.maxPhysicalAttempts, 1);
        assert.equal(value.requestedLimits.maxFailovers, 0);
        throw new Error('transport failed');
      },
      getRunUsageLedger: () => undefined,
    },
  });
  const implementerLimits = { maxPromptTokens: 968000, maxCompletionTokens: 16000,
    maxPhysicalAttempts: 4, maxRetriesPerRoute: 1, maxFailovers: 2 };
  await assert.rejects(wrapper.execute({ ...request, attribution: { roleId: 'implementer' },
    requestedLimits: implementerLimits }), /transport/);
  await assert.rejects(wrapper.execute({ ...request, operationId: 'second',
    attribution: { roleId: 'implementer' }, requestedLimits: implementerLimits }), /dispatch inventory exhausted/);
  assert.equal(calls, 1);
});

test('governor receives the run-wide cost cap while the ledger reserves per attempt', async (t) => {
  const { ledger } = fixture(t);
  const wrapper = new ExperimentGovernor({
    ledger, scenario: 'healthy', maxAttemptCostMicrousd: 50, maxRunCostMicrousd: 300,
    governor: { synthetic: false, execute: async (value) => {
      assert.equal(value.requestedLimits.maxCostMicrousd, 300);
      throw new Error('stop');
    }, getRunUsageLedger: () => undefined },
  });
  await assert.rejects(wrapper.execute({ ...request, attribution: { roleId: 'implementer' },
    requestedLimits: { maxPromptTokens: 100, maxCompletionTokens: 10, maxPhysicalAttempts: 1,
      maxRetriesPerRoute: 0, maxFailovers: 0 } }), /stop/);
});

test('all-role limits never widen a caller that disabled retries', (t) => {
  const { ledger } = fixture(t);
  const wrapper = new ExperimentGovernor({
    ledger, scenario: 'healthy', maxAttemptCostMicrousd: 50, governor: { synthetic: false },
  });
  const narrowed = wrapper.narrow({ ...request, attribution: { roleId: 'critic-reviewer' },
    requestedLimits: { maxPromptTokens: 20000, maxCompletionTokens: 6000, maxPhysicalAttempts: 3,
      maxRetriesPerRoute: 0, maxFailovers: 1 } });
  assert.equal(narrowed.requestedLimits.maxPhysicalAttempts, 2);
  assert.equal(narrowed.requestedLimits.maxPromptTokens, 20000);
  assert.equal(narrowed.requestedLimits.maxRetriesPerRoute, 0);
  assert.equal(narrowed.requestedLimits.maxFailovers, 0);
  assert.throws(() => wrapper.narrow({ ...request, requestedLimits: undefined }), /missing frozen role limits/);
});

test('priced settlement counts one logical call across multiple physical attempts', async (t) => {
  const { ledger } = fixture(t);
  const requestId = { ...request, requestedLimits: { maxPromptTokens: 20000,
    maxCompletionTokens: 6000, maxPhysicalAttempts: 3, maxRetriesPerRoute: 2, maxFailovers: 1 } };
  const wrapper = new ExperimentGovernor({
    ledger, scenario: 'healthy', maxAttemptCostMicrousd: 50,
    governor: {
      synthetic: false,
      execute: async () => {
        assert.equal(ledger.db.prepare("SELECT state FROM reservations").get().state, 'active');
        return 'accepted';
      },
      getRunUsageLedger: () => ({
        runId: requestId.runId,
        operations: { [requestId.operationId]: { state: 'succeeded' } },
        reservations: [],
        attempts: [1, 2].map(() => ({ operationId: requestId.operationId,
          charge: { physicalCalls: 1, promptTokens: 8, completionTokens: 3, costMicrousd: 1 } })),
      }),
    },
  });
  assert.equal(await wrapper.execute(requestId), 'accepted');
  const row = ledger.db.prepare('SELECT state, charge FROM reservations').get();
  assert.equal(row.state, 'settled');
  assert.deepEqual(JSON.parse(row.charge), {
    logicalCalls: 1, physicalCalls: 2, inputTokens: 16, outputTokens: 6, costMicrousd: 2,
  });
});

test('broker authenticates run-bound reservations and preserves the parent ledger owner', async (t) => {
  const { ledger } = fixture(t);
  const broker = await createLedgerBroker(ledger, 'healthy');
  try {
    const remote = new RemoteExperimentLedger({ ...broker, scenario: 'healthy' });
    const wrong = new RemoteExperimentLedger({ ...broker, token: '0'.repeat(64), scenario: 'healthy' });
    await assert.rejects(wrong.clock(), /broker request rejected/);
    await assert.rejects(remote.call('unknown'), /broker request rejected/);
    assert.deepEqual(await remote.clock(), { startsAt: 100, deadline: 1100 });
    await remote.reserve(request, 'healthy', charge);
    assert.throws(() => ledger.recover(), /live reservation owner/);
    await remote.settle(request, { logicalCalls: 1, physicalCalls: 1, inputTokens: 10, outputTokens: 5, costMicrousd: 1 });
    await assert.rejects(remote.settle(request, null), /broker request rejected/);
    assert.equal(ledger.db.prepare('SELECT state FROM reservations').get().state, 'settled');
  } finally { await broker.close(); }
});

test('child-side ledger resolves frozen dispatch limits synchronously and rejects uninventoried roles', async (t) => {
  const { ledger, configuration } = fixture(t);
  const broker = await createLedgerBroker(ledger, 'healthy');
  try {
    const remote = new RemoteExperimentLedger({ ...broker, scenario: 'healthy' });
    assert.throws(() => remote.dispatchLimits(request, 'healthy'), /absent from frozen dispatch inventory/);
    remote.bind(configuration);
    assert.equal(remote.dispatchLimits(request, 'healthy').roleId, 'critic-reviewer');
    assert.throws(() => remote.dispatchLimits({ ...request, attribution: { roleId: 'unknown' } }, 'healthy'),
      /absent from frozen dispatch inventory/);
    assert.throws(() => remote.dispatchLimits({ ...request, runId: '2026-11-02-defect' }, 'healthy'),
      /absent from frozen dispatch inventory/);
  } finally { await broker.close(); }
});
