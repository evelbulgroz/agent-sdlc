import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExperimentLedger } from './experiment-ledger.ts';
import { createLedgerBroker, RemoteExperimentLedger } from './experiment-broker.ts';
import { shellInvocations } from './live-records.ts';
import { assertShellInvocation, launchSupervised, superviseExperiment } from './supervisor.ts';
import { recipeHandler } from './supervisor-recipes.ts';

const NODE = process.execPath;
const RUN_ID = '2026-11-03-recipe-broker';
const INPUT = ['pm', '--filter', 'pkg', 'run', 'lint'];
const STATE = 'state';

test('only the seven pinned guarded invocations are admitted', () => {
  const runId = '2026-11-03-canary-healthy';
  const now = () => Date.parse('2026-11-03T12:00:00Z');
  const invocations = shellInvocations({ slug: 'canary-healthy', output: 'out/c1' },
    { runId, spec: 'docs/a.md', tasks: 'docs/a.tasks.json' });
  assert.equal(invocations.length, 7);
  for (const argv of invocations) {
    assert.doesNotThrow(() => assertShellInvocation(argv, { runId, invocations, skipCanary: true }, now));
  }
  const authorize = invocations[5];
  assert.deepEqual(authorize.slice(0, 2), ['authorize', '--run']);
  for (const argv of [[...invocations[0], '--skip-canary'], ['shell', 'watch', '--run', runId],
    authorize.slice(0, 5), [...authorize, '--push'],
    authorize.map((part) => part.endsWith('envelope.json') ? 'x.json' : part),
    invocations[4].map((part) => part === runId ? 'other' : part),
    [...invocations[6], '--push'], invocations[6].map((part) => part.endsWith('reply.json') ? 'x.json' : part)]) {
    assert.throws(() => assertShellInvocation(argv, { runId, invocations, skipCanary: true }, now), /unapproved|escaped/);
  }
  assert.deepEqual(invocations[6].slice(0, 2), ['resume', '--run']);
  for (const argv of [invocations[0], invocations[1]]) {
    assert.throws(() => assertShellInvocation(argv, { runId, invocations }, now), /unapproved/);
  }
  const watch = invocations[2];
  assert.throws(() => assertShellInvocation([...watch, '--skip-canary'],
    { runId, invocations: [[...watch, '--skip-canary']], skipCanary: true }, now), /unapproved/);
});

test('shell entry accepts only frozen scenario argv and cannot authorize delivery or another run', () => {
  const runId = '2026-11-02-canary-healthy', now = () => Date.parse('2026-11-02T12:00:00Z');
  const start = ['shell', 'start', '--slug', 'canary-healthy', '--goal-file', 'approved.md',
    '--task-plan-file', 'approved.tasks.json'];
  const watch = ['shell', 'watch', '--run', runId];
  const binding = { runId, invocations: [start, watch] };
  assert.doesNotThrow(() => assertShellInvocation(start, binding, now));
  assert.doesNotThrow(() => assertShellInvocation(watch, binding, now));
  for (const argv of [null, [], ['shell', 'watch'], [...watch, '--json'],
    ['shell', 'watch', '--run', '2026-11-02-unrelated'], ['pr', '--push']]) {
    assert.throws(() => assertShellInvocation(argv, binding, now), /unapproved shell invocation/);
  }
  for (const invocations of [null, [], [watch, watch]]) {
    assert.throws(() => assertShellInvocation(watch, { runId, invocations }, now), /unapproved/);
  }
  assert.throws(() => assertShellInvocation(start, binding,
    () => Date.parse('2026-11-03T00:00:00Z')), /frozen spec\/plan\/run binding/);
  for (const argv of [['pr', '--push'], ['commit', '--run', runId],
    ['shell', 'watch', '--run', '2026-11-02-unrelated'],
    [...start, '--skip-canary'], [...watch, '--run', runId],
    ['shell', 'start', '--slug', 'canary-healthy', '--goal-file', 'approved.md']]) {
    assert.throws(() => assertShellInvocation(argv, { runId, invocations: [argv] }, now),
      /unapproved shell invocation|frozen (run|spec\/plan\/run binding)/);
  }
});

function workspace(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-broker-')));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const worktree = path.join(root, STATE, RUN_ID, 'worktree');
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(path.join(root, 'outside'));
  const body = JSON.stringify({ schemaVersion: '1.0.0', recipes: [{ id: 'lint', inputArgv: INPUT, timeoutMs: 1000 }] });
  fs.writeFileSync(path.join(root, 'recipes.json'), body);
  const reference = { path: 'recipes.json', sha256: crypto.createHash('sha256').update(body).digest('hex') };
  return { root, worktree, reference };
}

test('recipe handler runs only frozen recipes inside the authorized run and bounds the result', async (t) => {
  const { root, worktree, reference } = workspace(t);
  const calls = [];
  const run = async (...args) => { calls.push(args); return { code: 3, stdout: 'x'.repeat(20000), stderr: '' }; };
  const handler = recipeHandler({ root, config: { stateDir: STATE }, reference, runId: RUN_ID, run });
  const result = await handler({ argv: INPUT, worktree, timeoutMs: 5000 });
  assert.deepEqual([result.code, result.stdout.length], [3, 16384]);
  assert.deepEqual([calls[0][0], calls[0][3]], [worktree, 1000]);
  await assert.rejects(handler({ argv: ['pm', 'run', 'other'], worktree }), /not a frozen canary recipe/);
  await assert.rejects(handler({ argv: INPUT, worktree: path.join(root, 'outside') }), /escaped authorized run/);
  assert.equal(calls.length, 1);
});

const caps = { logicalCalls: 1, physicalCalls: 1, inputTokens: 1000, outputTokens: 1000, costMicrousd: 10 };
function ledgerFixture(t, maxElapsedMs = 1000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-ledger-'));
  const ledger = new ExperimentLedger(path.join(root, 'ledger.sqlite'), { ...caps, maxAttemptCostMicrousd: 10,
    maxElapsedMs, scenarios: { healthy: { ...caps, runId: RUN_ID } },
    dispatchInventory: [{ scenario: 'healthy', runId: RUN_ID, roleId: 'implementer', logicalCalls: 1,
      maxPhysicalAttempts: 1, maxPromptTokens: 1000, maxCompletionTokens: 1000 }] });
  t.after(() => { ledger.close(); fs.rmSync(root, { recursive: true }); });
  return { ledger, root };
}

test('broker routes recipe requests to the parent handler only with the token and bound run', async (t) => {
  const { ledger } = ledgerFixture(t);
  const seen = [];
  const broker = await createLedgerBroker(ledger, 'healthy', { recipe: async (request) => { seen.push(request); return { code: 0 }; } });
  t.after(() => broker.close());
  const remote = new RemoteExperimentLedger({ socketName: broker.socketName, token: broker.token, scenario: 'healthy' });
  assert.deepEqual(await remote.recipe({ runId: RUN_ID, argv: INPUT, worktree: '/w' }, 100), { code: 0 });
  const forged = new RemoteExperimentLedger({ socketName: broker.socketName, token: 'a'.repeat(64), scenario: 'healthy' });
  await assert.rejects(forged.recipe({ runId: RUN_ID, argv: INPUT, worktree: '/w' }, 100), /rejected/);
  await assert.rejects(remote.recipe({ runId: '2026-11-03-other', argv: INPUT, worktree: '/w' }, 100), /rejected/);
  assert.equal(seen.length, 1);
});

const request = { runId: RUN_ID, operationId: 'operation', attribution: { roleId: 'implementer' } };
const charge = caps;

function controller(t, maxElapsedMs) {
  const { ledger, root } = ledgerFixture(t, maxElapsedMs);
  const helpers = fs.realpathSync(path.dirname(new URL(import.meta.url).pathname));
  const readOnly = ['/usr', '/lib', '/lib64'].map(destination => ({ source: fs.realpathSync(destination), destination }));
  readOnly.push({ source: path.dirname(NODE), destination: path.dirname(NODE) }, { source: helpers, destination: helpers });
  const url = new URL('./experiment-broker.ts', import.meta.url).href;
  const program = `import {RemoteExperimentLedger} from ${JSON.stringify(url)};
    const ledger=new RemoteExperimentLedger({
      socketName:process.env.AGENT_SDLC_CANARY_BROKER_SOCKET,
      token:process.env.AGENT_SDLC_CANARY_BROKER_TOKEN,
      scenario:process.env.AGENT_SDLC_CANARY_SCENARIO});
    await ledger.reserve(${JSON.stringify(request)},'healthy',${JSON.stringify(charge)});
    console.log('reserved');`;
  return { ledger, root, readOnly, program };
}

test('supervised experiment owns broker lifetime and charges an unsettled successful child', async t => {
  const { ledger, readOnly, program } = controller(t, 5000);
  const result = await superviseExperiment({ ledger, scenario: 'healthy', readOnly,
    argv: [NODE, '--input-type=module', '-e', program], cwd: path.dirname(NODE) });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'reserved');
  const row = ledger.db.prepare('SELECT state, charge, owner FROM reservations').get();
  assert.equal(row.state, 'uncertain');
  assert.deepEqual(JSON.parse(row.charge), charge);
  assert.equal(JSON.parse(row.owner).pid, process.pid);
  assert.equal(JSON.parse(row.owner).namespace, fs.readlinkSync('/proc/self/ns/pid'));
  const clock = ledger.clock();
  const repeated = await superviseExperiment({ ledger, scenario: 'healthy', readOnly,
    argv: [NODE, '--input-type=module', '-e', program], cwd: path.dirname(NODE) });
  assert.equal(repeated.code, 1);
  assert.match(repeated.stderr, /broker request rejected/);
  assert.deepEqual(ledger.clock(), clock);
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS count FROM reservations').get().count, 1);
});

test('supervised experiment kills a blocked child at the sealed clock and retains its full charge', async t => {
  const { ledger, readOnly, program } = controller(t, 600);
  const started = Date.now();
  await assert.rejects(superviseExperiment({ ledger, scenario: 'healthy', readOnly,
    argv: [NODE, '--input-type=module', '-e', `${program}while(true){}`],
    cwd: path.dirname(NODE), deadline: Date.now() + 5000 }), /EvidenceTimeout/);
  assert.ok(Date.now() - started < 3000);
  const row = ledger.db.prepare('SELECT state, charge FROM reservations').get();
  assert.equal(row.state, 'uncertain');
  assert.deepEqual(JSON.parse(row.charge), charge);
  assert.throws(() => ledger.begin(), /deadline/);
});

test('invalid supervised experiment inputs never begin an execution window', async t => {
  const { ledger, readOnly } = controller(t, 5000);
  for (const options of [null, {}, { ledger, scenario: 'outside', readOnly, argv: [NODE] },
    { ledger, scenario: 'healthy', readOnly, argv: [] },
    { ledger, scenario: 'healthy', readOnly: [], argv: [NODE] },
    { ledger, scenario: 'healthy', readOnly, argv: [NODE], privateEnv: null },
    { ledger, scenario: 'healthy', readOnly, argv: [NODE],
      env: { AGENT_SDLC_CANARY_BROKER_SOCKET: 'replacement' } }]) {
    await assert.rejects(superviseExperiment(options), /invalid supervised experiment/);
  }
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS count FROM experiment').get().count, 0);
});

test('launchSupervised is re-exported unchanged', async () => {
  const process_ = await import('./process.ts');
  assert.equal(launchSupervised, process_.launchSupervised);
});
