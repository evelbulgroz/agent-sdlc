import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { recordPreflightTelemetry } from './record.ts';
import { initRun } from './run-init.ts';
import { isValidRunSlug, resolveAndValidateRunDir, resolveRunSelector } from './run-selector.ts';
import { exportTelemetrySnapshot } from './store.ts';

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '../cli/cli.ts');
const quiet = (fn) => {
	const warn = console.warn;
	console.warn = () => {};
	try { return fn(); } finally { console.warn = warn; }
};

function host(t) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-')));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, '.agents'));
	fs.writeFileSync(path.join(root, '.agents/sdlc-host.json'), JSON.stringify({
		schemaVersion: '1.7.0', profileId: 'h', repositoryId: 'h', adapter: 'default', stateDir: 'state', reviewDir: 'review',
		specDraftDir: 'specs/drafts', runsDir: 'specs/runs', telemetry: { dir: 'var/telemetry' },
		verify: { argv: ['true', '{baseSha}'], resultPath: 'var/last.json' },
	}));
	for (const slug of ['alpha', '_example']) {
		fs.mkdirSync(path.join(root, 'specs/runs', slug), { recursive: true });
		fs.writeFileSync(path.join(root, 'specs/runs', slug, 'status.json'), JSON.stringify({ runId: slug }));
	}
	fs.writeFileSync(path.join(root, '.gitignore'), 'var/\n');
	return root;
}

const options = (root, extra = {}) => ({ rootDir: root, runsDir: 'specs/runs', telemetryDir: 'var/telemetry', ...extra });
const result = (sha, extra = {}) => ({ status: 'OK', exitCode: 0, gitHeadSha: sha, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:05.000Z', ...extra });

test('@ac AC-02 @case AC-02.1 selector precedence is argument, AGENT_RUN_DIR, then AGENT_RUN_ID', () => {
	const env = { AGENT_RUN_DIR: 'dir-run', AGENT_RUN_ID: 'id-run' };
	assert.equal(resolveRunSelector('cli-run', env), 'cli-run');
	assert.equal(resolveRunSelector(null, env), 'dir-run');
	assert.equal(resolveRunSelector(' ', { AGENT_RUN_ID: 'id-run' }), 'id-run');
	assert.equal(resolveRunSelector(null, {}), null);
	assert.deepEqual(['run_01', '2026-08-21-x'].map(isValidRunSlug), [true, true]);
	assert.deepEqual(['..', '../x', 'a/b', '_example', '.hidden', ''].map(isValidRunSlug), [false, false, false, false, false, false]);
});

test('@ac AC-02 @case AC-02.2 run containment rejects escapes, the template, a missing status and a mismatched runId', (t) => {
	const root = host(t);
	assert.equal(resolveAndValidateRunDir('alpha', root, 'specs/runs').slug, 'alpha');
	assert.equal(resolveAndValidateRunDir('specs/runs/alpha', root, 'specs/runs').slug, 'alpha');
	for (const bad of ['_example', '../..', 'specs', 'missing']) assert.throws(() => resolveAndValidateRunDir(bad, root, 'specs/runs'));
	fs.mkdirSync(path.join(root, 'specs/runs/beta'));
	assert.throws(() => resolveAndValidateRunDir('beta', root, 'specs/runs'), /missing status.json/);
	fs.writeFileSync(path.join(root, 'specs/runs/beta/status.json'), JSON.stringify({ runId: 'other' }));
	assert.throws(() => resolveAndValidateRunDir('beta', root, 'specs/runs'), /does not match/);
});

test('@ac AC-02 @case AC-02.3 recording is idempotent per execution, counts retries per sha and skips when no run is selected', (t) => {
	const root = host(t);
	assert.equal(recordPreflightTelemetry(options(root, { preflightResult: result('a') })).recorded, false);
	const first = recordPreflightTelemetry(options(root, { runSelector: 'alpha', preflightResult: result('a') }));
	assert.equal(first.recorded && !first.deduplicated, true);
	assert.equal(recordPreflightTelemetry(options(root, { runSelector: 'alpha', preflightResult: result('a') })).deduplicated, true);
	const retry = recordPreflightTelemetry(options(root, { runSelector: 'alpha', preflightResult: result('a', { startedAt: '2026-01-02T00:00:00.000Z', finishedAt: '2026-01-02T00:00:09.000Z', status: 'FAIL', exitCode: 1 }) }));
	assert.equal(retry.record.retryCount, 1);
	assert.equal(retry.record.durationMs, 9000);
	const stored = JSON.parse(fs.readFileSync(path.join(root, 'var/telemetry/alpha.json'), 'utf8'));
	assert.equal(stored.records.length, 2);
	assert.equal(recordPreflightTelemetry(options(root, { runSelector: 'alpha', preflightResult: result('b') })).record.retryCount, 0);
});

test('@ac AC-02 @case AC-02.4 a corrupt telemetry file is moved aside and recording continues', (t) => {
	const root = host(t);
	fs.mkdirSync(path.join(root, 'var/telemetry'), { recursive: true });
	fs.writeFileSync(path.join(root, 'var/telemetry/alpha.json'), '{not json');
	const outcome = quiet(() => recordPreflightTelemetry(options(root, { runSelector: 'alpha', preflightResult: result('a') })));
	assert.equal(outcome.ok, true);
	assert.ok(fs.readdirSync(path.join(root, 'var/telemetry')).some((name) => name.startsWith('alpha.corrupt.')));
});

test('@ac AC-02 @case AC-02.5 export validates the slug, copies to a destination and rejects a foreign envelope', (t) => {
	const root = host(t);
	recordPreflightTelemetry(options(root, { runSelector: 'alpha', preflightResult: result('a') }));
	const dir = path.join(root, 'var/telemetry');
	assert.equal(exportTelemetrySnapshot('alpha', { telemetryDir: dir }).records.length, 1);
	const dest = path.join(root, 'out/alpha.json');
	exportTelemetrySnapshot('alpha', { telemetryDir: dir, dest });
	assert.equal(JSON.parse(fs.readFileSync(dest, 'utf8')).runId, 'alpha');
	assert.throws(() => exportTelemetrySnapshot('../alpha', { telemetryDir: dir }), /Invalid run slug/);
	assert.throws(() => exportTelemetrySnapshot('gamma', { telemetryDir: dir }), /No telemetry records/);
	fs.writeFileSync(path.join(dir, 'gamma.json'), JSON.stringify({ runId: 'other', records: [] }));
	assert.throws(() => exportTelemetrySnapshot('gamma', { telemetryDir: dir }), /Invalid telemetry envelope/);
});

test('@ac AC-03 @case AC-03.1 concurrent CLI records all land, in the profile directory, leaving a git worktree clean', async (t) => {
	const root = host(t);
	execFileSync('git', ['init', '-q'], { cwd: root });
	execFileSync('git', ['add', '.'], { cwd: root });
	execFileSync('git', ['-c', 'user.email=t@e.x', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: root });
	const payload = (n) => JSON.stringify(result(`sha${n}`));
	const runs = [1, 2, 3, 4].map((n) => {
		const child = run('node', [CLI, 'telemetry', 'record', '--root', root, '--run', 'alpha', '--stdin'], { cwd: root });
		child.child.stdin.end(payload(n));
		return child;
	});
	const outputs = await Promise.all(runs);
	for (const { stdout } of outputs) assert.match(stdout, /^telemetry record: recorded OK/);
	assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'var/telemetry/alpha.json'), 'utf8')).records.length, 4);
	assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');
});

test('@ac AC-03 @case AC-03.2 the record command exits zero for a bad run or result, and export fails closed', async (t) => {
	const root = host(t);
	const record = await run('node', [CLI, 'telemetry', 'record', '--root', root, '--run', 'nope', '--result', 'var/none.json', '--json'], { cwd: root });
	assert.equal(JSON.parse(record.stdout).ok, false);
	await assert.rejects(run('node', [CLI, 'telemetry', 'export', '--root', root, '--slug', 'alpha'], { cwd: root }));
});

const NOW = new Date('2026-03-04T05:06:07.000Z');

test('@ac AC-01 @case AC-01.1 run init creates a validated folder from the bundled templates with git metadata', (t) => {
	const root = host(t);
	fs.rmSync(path.join(root, 'specs/runs/_example'), { recursive: true });
	const out = initRun({ rootDir: root, runsDir: 'specs/runs', slug: 'my-feature', now: NOW, resultFile: 'var/last.json' });
	assert.equal(out.runId, '2026-03-04-my-feature');
	const dir = path.join(root, out.runDir);
	assert.deepEqual(fs.readdirSync(dir).sort(), ['decisions.md', 'intent.md', 'plan.md', 'status.json']);
	const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
	assert.equal(status.activeOwner, 'role:spec');
	assert.equal(status.verification.preflight.resultFile, 'var/last.json');
	assert.equal(resolveAndValidateRunDir(out.runId, root, 'specs/runs').slug, out.runId);
});

test('@ac AC-01 @case AC-01.2 run init prefers a complete host _example and ignores an incomplete one', (t) => {
	const root = host(t);
	const example = path.join(root, 'specs/runs/_example');
	for (const f of ['intent.md', 'plan.md', 'decisions.md']) fs.writeFileSync(path.join(example, f), `host ${f}`);
	fs.writeFileSync(path.join(example, 'status.json'), fs.readFileSync(path.join(import.meta.dirname, '../run-templates/status.json')));
	const a = initRun({ rootDir: root, runsDir: 'specs/runs', slug: 'a', now: NOW });
	assert.equal(fs.readFileSync(path.join(root, a.runDir, 'intent.md'), 'utf8'), 'host intent.md');
	fs.rmSync(path.join(example, 'plan.md'));
	const b = initRun({ rootDir: root, runsDir: 'specs/runs', slug: 'b', now: NOW });
	assert.match(fs.readFileSync(path.join(root, b.runDir, 'plan.md'), 'utf8'), /^# Plan/);
});

test('@ac AC-01 @case AC-01.3 run init rejects bad slugs and existing folders and leaves no folder after a failed validation', (t) => {
	const root = host(t);
	for (const slug of ['Bad', '-x', 'a/b', '..', '']) assert.throws(() => initRun({ rootDir: root, runsDir: 'specs/runs', slug, now: NOW }), /kebab-case/);
	initRun({ rootDir: root, runsDir: 'specs/runs', slug: 'dup', now: NOW });
	assert.throws(() => initRun({ rootDir: root, runsDir: 'specs/runs', slug: 'dup', now: NOW }), /Already exists/);
	const example = path.join(root, 'specs/runs/_example');
	for (const f of ['intent.md', 'plan.md', 'decisions.md']) fs.writeFileSync(path.join(example, f), 'x');
	fs.writeFileSync(path.join(example, 'status.json'), JSON.stringify({ schemaVersion: 1 }));
	assert.throws(() => initRun({ rootDir: root, runsDir: 'specs/runs', slug: 'bad-status', now: NOW }), /invalid/);
	assert.equal(fs.existsSync(path.join(root, 'specs/runs/2026-03-04-bad-status')), false);
});

test('@ac AC-01 @case AC-01.4 --orchestrated sets only the owner, and an explicit owner wins', (t) => {
	const root = host(t);
	const read = (out) => JSON.parse(fs.readFileSync(path.join(root, out.runDir, 'status.json'), 'utf8'));
	const orchestrated = read(initRun({ rootDir: root, runsDir: 'specs/runs', slug: 'o', orchestrated: true, now: NOW }));
	assert.equal(orchestrated.activeOwner, 'orchestrator:agent-sdlc');
	assert.equal('orchestration' in orchestrated, false);
	assert.equal(read(initRun({ rootDir: root, runsDir: 'specs/runs', slug: 'p', orchestrated: true, owner: 'role:implement', now: NOW })).activeOwner, 'role:implement');
});

test('@ac AC-01 @case AC-01.5 the run init command creates a folder via the CLI with flags only', async (t) => {
	const root = host(t);
	const { stdout } = await run('node', [CLI, 'run', 'init', '--root', root, '--slug', 'cli-run', '--json'], { cwd: root });
	assert.match(JSON.parse(stdout).runDir, /specs\/runs\/\d{4}-\d{2}-\d{2}-cli-run$/);
	await assert.rejects(run('node', [CLI, 'run', 'init', '--root', root, 'cli-run'], { cwd: root }));
});
