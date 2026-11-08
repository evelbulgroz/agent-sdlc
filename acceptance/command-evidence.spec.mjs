import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { casesFromReport, runCommandInSandbox } from './command-evidence.mjs';
import { evidenceHandler } from './evidence-broker.mjs';
import { namespaceArgv } from './sandbox.mjs';

const RUN_ID = 'run-1';
const STATE_DIR = 'state/runs';

function tree(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-sandbox-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['rt/sysroot/usr/lib', 'rt/node_modules', 'pkg/node_modules', 'out']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const config = { root, runtime: 'rt', packageRoot: 'pkg', readOnlyBinds: [], helpers: null, openApiPath: null, output: 'out', node: process.execPath };
  return { root, config, report: path.join(root, 'out') };
}
const pairs = (argv, flag) => argv.flatMap((value, index) => value === flag ? [[argv[index + 1], argv[index + 2]]] : []);
const NODE = fs.realpathSync(process.execPath);

test('@ac AC-05 @case AC-05.1 command namespace mounts /bin, a fixed PATH, binaries, cwd and a writable /report', (t) => {
  const { root, config, report } = tree(t);
  const argv = namespaceArgv(config, ['/opt/sdlc/bin/node', 't.mjs'], {
    command: { binaries: [{ source: NODE, destination: '/opt/sdlc/bin/node' }], report, cwd: 'pkg' },
  });
  assert.deepEqual(pairs(argv, '--symlink')[0], ['usr/bin', '/bin']);
  assert.ok(pairs(argv, '--ro-bind').some(([source, destination]) => source === NODE && destination === '/opt/sdlc/bin/node'));
  assert.ok(pairs(argv, '--bind').some(([source, destination]) => source === report && destination === '/report'));
  assert.equal(argv[argv.indexOf('PATH') + 1], '/bin:/opt/sdlc/bin');
  assert.equal(argv[argv.indexOf('--chdir') + 1], path.join(root, 'pkg'));
  assert.deepEqual(argv.slice(-3), ['--', '/opt/sdlc/bin/node', 't.mjs'].slice(-3));
});

test('@ac AC-05 @case AC-05.3 every namespace binds the runtime dir read-only without a helpers mount', (t) => {
  const { root, config } = tree(t);
  for (const options of [{}, { command: { report: path.join(root, 'out'), cwd: 'pkg' } }]) {
    const argv = namespaceArgv(config, ['/x'], options);
    assert.ok(pairs(argv, '--ro-bind').some(([source, destination]) => source === path.join(root, 'rt') && destination === source));
  }
});

test('@ac AC-05 @case AC-05.2 command mounts reject escapes, reserved destinations and unsafe cwd or report paths', (t) => {
  const { root, config, report } = tree(t);
  fs.symlinkSync(root, path.join(root, 'link'));
  const run = (command) => namespaceArgv(config, ['/x'], { command });
  for (const destination of ['relative/node', '/proc/node', '/dev/node', '/tmp/node', '/report/node', '/opt/../etc/node']) {
    assert.throws(() => run({ binaries: [{ source: NODE, destination }], report }), /unsafe command binary/);
  }
  assert.throws(() => run({ binaries: [{ source: root, destination: '/opt/dir' }], report }), /unsafe command binary/);
  assert.throws(() => run({ report: path.join(root, 'link/out') }), /unsafe report directory/);
  assert.throws(() => run({ report, cwd: '../outside' }));
  assert.throws(() => run({ report, cwd: path.join(root, 'link') }));
  assert.throws(() => run({ report, cwd: 'link' }), /unsafe command cwd/);
});

const registration = (extra = {}) => ({
  kind: 'command', argv: ['/usr/bin/node', 'run.mjs'], cwd: 'pkg', reportFormat: 'junit', retries: 0,
  profiles: [{ profileId: 'unit' }], limits: { timeoutMs: 1000, maxReportBytes: 1024 }, ...extra,
});

test('@ac AC-07 @case AC-07.1 evidence handler brokers command report bytes for frozen registrations only', async (t) => {
  const { root } = tree(t);
  const worktree = path.join(root, STATE_DIR, RUN_ID, 'worktree');
  fs.mkdirSync(worktree, { recursive: true });
  const calls = [];
  const runCommand = async (input) => { calls.push(input); return { code: 0, reportBytes: Buffer.from('<testsuites/>'), stderr: 'warn' }; };
  const reg = registration();
  const stdin = Buffer.from(JSON.stringify({ baseSha: 'abc' })).toString('base64');
  const request = { argv: reg.argv, cwd: worktree, stdin, timeoutMs: 9999999, env: {} };
  const handler = evidenceHandler({ root, stateDir: STATE_DIR, registrations: [reg], runId: RUN_ID, config: { any: true }, runCommand });
  const result = await handler(request);
  assert.equal(Buffer.from(result.stdout, 'base64').toString(), '<testsuites/>');
  assert.equal(Buffer.from(result.stderr, 'base64').toString(), 'warn');
  assert.equal(calls[0].baseSha, 'abc');
  assert.equal(calls[0].timeoutMs, 1000);
  assert.equal(fs.existsSync(calls[0].reportDirectory), false);
  await assert.rejects(handler({ ...request, argv: ['/usr/bin/node', 'other.mjs'] }), /not a frozen evidence adapter/);
  await assert.rejects(handler({ ...request, cwd: root }), /escaped authorized run/);
  const bare = evidenceHandler({ root, stateDir: STATE_DIR, registrations: [reg], runId: RUN_ID, runCommand });
  await assert.rejects(bare(request), /requires the acceptance config/);
});

test('@ac AC-08 @case AC-08.1 the sandbox runner rejects a report that predates the run or is missing', async (t) => {
  const { root, config, report } = tree(t);
  const worktree = root;
  fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
  const executable = NODE;
  const sha = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
  const { commandBindingHash } = await import('../host/command-evidence.ts');
  const argv = [executable, 'run.mjs', '--out={reportPath}'];
  const reg = registration({ argv, executable: { path: executable, sha256: sha }, pins: [],
    commandSha256: commandBindingHash(argv, sha, []) });
  const base = { worktree, config: { ...config, node: executable }, registration: reg, baseSha: 'abc', reportDirectory: report, timeoutMs: 1000 };
  const write = (age) => async (namespaced) => {
    const target = path.join(report, 'unit.xml');
    fs.writeFileSync(target, '<testsuites/>');
    const when = new Date(Date.now() - age);
    fs.utimesSync(target, when, when);
    assert.ok(namespaced.includes('/report/unit.xml') || namespaced.some((token) => token.includes('/report/unit.xml')));
    return { code: 0, stderr: '' };
  };
  await assert.rejects(runCommandInSandbox({ ...base, execute: write(60000) }), /REPORT_|stale|fresh/i);
  await assert.rejects(runCommandInSandbox({ ...base, execute: async () => ({ code: 0, stderr: '' }) }), /REPORT_|missing|exist/i);
  const ok = await runCommandInSandbox({ ...base, execute: write(0) });
  assert.equal(ok.code, 0);
});

test('@ac AC-04 @case AC-04.4 casesFromReport parses the brokered bytes and rejects exit contradictions', () => {
  const reg = registration();
  const bytes = Buffer.from('<testsuites><testcase name="@case AC-01.1 a"/></testsuites>');
  assert.equal(casesFromReport({ registration: reg, selected: ['AC-01.1'], code: 0, reportBytes: bytes })[0].outcome, 'passed');
  assert.throws(() => casesFromReport({ registration: reg, selected: ['AC-01.1'], code: 1, reportBytes: bytes }), /EXIT|contradict/i);
});

test('@ac AC-09 @case AC-09.1 pretest steps run first in the sandbox, must exit 0, and are bound into the registration hash', async (t) => {
  const { root, config, report } = tree(t);
  fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pkg/setup.mjs'), '1');
  const { commandBindingHash, recordPins } = await import('../host/command-evidence.ts');
  const { verifyCommandRegistration } = await import('../host/command-evidence.ts');
  const sha = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(NODE)).digest('hex');
  const step = { id: 'gen', argv: [NODE, 'setup.mjs'], cwd: 'pkg', timeoutMs: 500, executable: { path: NODE, sha256: sha },
    pins: recordPins(root, 'pkg', [{ file: 'setup.mjs' }]) };
  const argv = [NODE, 'run.mjs', '--out={reportPath}'];
  const reg = registration({ argv, executable: { path: NODE, sha256: sha }, pins: [], pretest: [step],
    commandSha256: commandBindingHash(argv, sha, [], [step]) });
  assert.notEqual(reg.commandSha256, commandBindingHash(argv, sha, []));
  verifyCommandRegistration(root, reg);
  const order = [];
  const base = { worktree: root, config: { ...config, node: NODE }, registration: reg, baseSha: 'abc', reportDirectory: report, timeoutMs: 1000 };
  const execute = (code) => async (namespaced) => {
    order.push(namespaced.includes('setup.mjs') ? 'pretest' : 'command');
    if (order.at(-1) === 'command') fs.writeFileSync(path.join(report, 'unit.xml'), '<testsuites/>');
    return { code: order.at(-1) === 'pretest' ? code : 0, stderr: 'boom' };
  };
  await runCommandInSandbox({ ...base, execute: execute(0) });
  assert.deepEqual(order, ['pretest', 'command']);
  order.length = 0;
  await assert.rejects(runCommandInSandbox({ ...base, execute: execute(2) }), /pretest step failed: gen \(exit 2\)/);
  assert.deepEqual(order, ['pretest']);
  fs.writeFileSync(path.join(root, 'pkg/setup.mjs'), '2');
  assert.throws(() => verifyCommandRegistration(root, reg), /PINNED_FILE_MODIFIED/);
});
