import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { loadHostProfile } from './host-profile.ts';
import { checkGraduations, extractDepcruiseRuleNames, extractSemgrepRuleIds } from './learnings-graduations.ts';

const run = promisify(execFile);
const CLI = path.join(import.meta.dirname, '../cli/cli.ts');
const entry = (key, graduationTarget, extra = {}) => ({ ts: 't', type: 'pitfall', key, scope: 'global', query: 'q', insight: 'i', confidence: 8, source: 'observed', graduationTarget, ...extra });
const CONFIG = {
	identifierPrefix: 'acme', semgrepRules: 'rules/semgrep.yml', dependencyCruiserConfig: 'rules/dc.cjs',
	testDirs: ['src'], handbookDirs: ['docs'], skillDirs: ['skills'],
};

function repo(t, files = {}) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'grad-')));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	for (const [rel, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), content);
	}
	return root;
}

test('@ac AC-04 @case AC-04.1 semgrep ids are extracted without commented rules and match exactly or by prefix only', (t) => {
	assert.deepEqual([...extractSemgrepRuleIds('rules:\n  - id: no-eval\n  # - id: dead\n  - id: acme.no-fs # note\n')].sort(), ['acme.no-fs', 'no-eval']);
	const root = repo(t, { 'rules/semgrep.yml': '- id: no-eval\n- id: acme.no-fs\n# - id: commented\n- id: no-eval-extra\n' });
	const report = checkGraduations([
		entry('no-eval', 'semgrep'), entry('no-fs', 'semgrep'), entry('commented', 'semgrep'), entry('eval', 'semgrep'),
	], root, CONFIG);
	assert.deepEqual(report.candidates.map((c) => c.key), ['no-eval', 'no-fs']);
	assert.equal(report.ok, false);
});

test('@ac AC-04 @case AC-04.2 dependency-cruiser names come from the config, not comments', (t) => {
	const root = repo(t, { 'rules/dc.cjs': "module.exports = { forbidden: [{ name: 'no-cycles' }], /* { name: 'dead' } */ };\n" });
	assert.deepEqual([...extractDepcruiseRuleNames(path.join(root, 'rules/dc.cjs'))], ['no-cycles']);
	const report = checkGraduations([entry('no-cycles', 'depcruise'), entry('dead', 'depcruise')], root, CONFIG);
	assert.deepEqual(report.candidates.map((c) => c.key), ['no-cycles']);
});

test('@ac AC-04 @case AC-04.3 test and handbook targets need the explicit prefixed identifier, not generic keys or incidental text', (t) => {
	const root = repo(t, {
		'src/a.spec.mjs': "it('acme:rounding-mode holds')\nit('acme.tests-pass')\n// rounding-mode appears here too\n",
		'src/node_modules/x.spec.mjs': 'acme:hidden-key',
		'src/.hidden/y.spec.mjs': 'acme:hidden-dir',
		'src/plain.mjs': 'acme:not-a-test',
		'docs/guide.md': 'See acme.rounding-mode for details. Heading: tests\n',
	});
	const report = checkGraduations([
		entry('rounding-mode', 'test'), entry('hidden-key', 'test'), entry('hidden-dir', 'test'), entry('not-a-test', 'test'),
		entry('tests', 'test'), entry('rounding-mode-x', 'test'), entry('rounding-mode', 'handbook', { scope: 'docs' }), entry('guide', 'handbook'),
	], root, CONFIG);
	assert.deepEqual(report.candidates.map((c) => `${c.graduationTarget}:${c.key}`), ['test:rounding-mode', 'handbook:rounding-mode']);
	assert.match(report.candidates[0].reason, /acme:rounding-mode.*src\/a\.spec\.mjs/);
});

test('@ac AC-04 @case AC-04.4 skill targets match a SKILL.md under a configured directory', (t) => {
	const root = repo(t, { 'skills/my-skill/SKILL.md': '# s', 'skills/empty/README.md': '' });
	const report = checkGraduations([entry('my-skill', 'skill'), entry('empty', 'skill'), entry('absent', 'skill')], root, CONFIG);
	assert.deepEqual(report.candidates.map((c) => c.key), ['my-skill']);
});

test('@ac AC-04 @case AC-04.5 an unset source or prefix reports no match and an empty store is clean', (t) => {
	const root = repo(t, { 'rules/semgrep.yml': '- id: acme.no-fs\n', 'src/a.spec.mjs': 'acme:thing', 'skills/s/SKILL.md': '' });
	const entries = [entry('no-fs', 'semgrep'), entry('thing', 'test'), entry('s', 'skill')];
	assert.deepEqual(checkGraduations(entries, root, {}).candidates, []);
	assert.deepEqual(checkGraduations(entries, root, { semgrepRules: 'rules/semgrep.yml', testDirs: ['src'] }).candidates.map((c) => c.key), []);
	assert.deepEqual(checkGraduations([], root, CONFIG), { ok: true, total: 0, candidates: [] });
});

test('@ac AC-04 @case AC-04.6 the profile requires 1.7.0 for graduations and keeps sources contained', (t) => {
	const base = { profileId: 'h', repositoryId: 'h', adapter: 'default', learnings: { graduations: CONFIG } };
	const write = (profile) => { const r = repo(t, { '.agents/sdlc-host.json': JSON.stringify(profile) }); return r; };
	assert.deepEqual(loadHostProfile(write({ ...base, schemaVersion: '1.7.0' })).learnings.graduations.testDirs, ['src']);
	assert.throws(() => loadHostProfile(write({ ...base, schemaVersion: '1.6.0' })), /requires schemaVersion '1.7.0'/);
	assert.throws(() => loadHostProfile(write({ ...base, schemaVersion: '1.7.0', learnings: { graduations: { semgrepRules: '../outside.yml' } } })));
	assert.throws(() => loadHostProfile(write({ ...base, schemaVersion: '1.7.0', learnings: { graduations: { identifierPrefix: 'a b' } } })));
});

async function cli(root, ...args) {
	try {
		const { stdout } = await run('node', [CLI, 'learnings', 'graduations', '--root', root, ...args], { cwd: root });
		return { status: 0, stdout };
	} catch (error) {
		return { status: error.code, stdout: error.stdout };
	}
}

test('@ac AC-04 @case AC-04.7 the command exits 1 when entries graduated, and 0 with --advisory or --warn-only or a clean store', async (t) => {
	const profile = { schemaVersion: '1.7.0', profileId: 'h', repositoryId: 'h', adapter: 'default', learnings: { graduations: CONFIG } };
	const root = repo(t, {
		'.agents/sdlc-host.json': JSON.stringify(profile), 'rules/semgrep.yml': '- id: acme.no-fs\n',
		'.learnings.jsonl': `${JSON.stringify({ type: 'pitfall', key: 'no-fs', scope: 'global', query: 'q', insight: 'i', graduationTarget: 'semgrep' })}\n`,
	});
	const blocked = await cli(root);
	assert.equal(blocked.status, 1);
	assert.match(blocked.stdout, /FAIL: 1 graduated entry to prune/);
	assert.equal((await cli(root, '--advisory')).status, 0);
	assert.equal((await cli(root, '--warn-only')).status, 0);
	const json = await cli(root, '--json');
	assert.equal(json.status, 1);
	assert.equal(JSON.parse(json.stdout).blocking, true);
	fs.writeFileSync(path.join(root, '.learnings.jsonl'), '');
	const clean = await cli(root);
	assert.equal(clean.status, 0);
	assert.match(clean.stdout, /OK \(0 entries/);
});
