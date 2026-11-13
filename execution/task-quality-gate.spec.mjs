import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluateTaskQualityGate } from './task-quality-gate.ts';

test('@ac AC-03 @case AC-03.3 evaluateTaskQualityGate passes with no authored paths', () => {
	assert.deepEqual(evaluateTaskQualityGate({}), { pass: true, findings: [] });
	assert.deepEqual(
		evaluateTaskQualityGate({ worktreeDir: '/missing', targetPackage: 'pkg', authoredPaths: [] }),
		{ pass: true, findings: [] },
	);
});

test('evaluateTaskQualityGate does not import the tool dispatcher', () => {
	const source = fs.readFileSync(new URL('./task-quality-gate.ts', import.meta.url), 'utf8');
	assert.equal(source.includes('tools.ts'), false);
	assert.equal(source.includes('task-executor.ts'), false);
	assert.equal(source.split('spawnSync(').length, 2);
	assert.equal(/spawnSync\(\s*['"]jscpd['"]/.test(source), false);
});

test('@ac AC-01 evaluateTaskQualityGate fails when a baseline clone moves', () => {
	const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-gate-'));
	try {
		const relFile = 'pkg/src/moved.ts';
		fs.mkdirSync(path.join(worktreeDir, 'pkg/src'), { recursive: true });
		fs.mkdirSync(path.join(worktreeDir, 'tools/quality/baselines'), { recursive: true });
		fs.writeFileSync(path.join(worktreeDir, 'tools/quality/eslint-gate.cjs'), 'module.exports = {};\n');
		fs.writeFileSync(
			path.join(worktreeDir, 'tools/quality/baselines/quality-v1.json'),
			JSON.stringify({
				fingerprints: [],
				findings: [{ tool: 'jscpd', location: `${relFile}:1-1` }],
			}),
		);
		fs.writeFileSync(path.join(worktreeDir, relFile), 'const fresh = 1;\nconst clone = 1;\n');
		const result = evaluateTaskQualityGate({
			worktreeDir,
			targetPackage: 'pkg',
			authoredPaths: [relFile],
			baseCommitSha: 'a'.repeat(40),
			gitCli: () => 'const clone = 1;\n',
		});
		assert.equal(result.pass, false);
		assert.match(result.summary, /quality-gate failed/);
		const finding = result.findings.find((line) => line.startsWith('[jscpd] clone'));
		assert.ok(finding);
		assert.match(finding, /pkg\/src\/moved\.ts:1-1/);
		assert.match(finding, /pkg\/src\/moved\.ts:2-2/);
		assert.match(finding, /must stay byte-for-byte/);
		assert.match(finding, /same number of replacement lines/);
		assert.equal(finding.includes('place new imports after'), false);
	} finally {
		fs.rmSync(worktreeDir, { recursive: true, force: true });
	}
});

const BRIDGE = [
	'export class LogCacheLifecycleBridge {',
	'\tbind(): void {',
	'\t\treturn;',
	'\t}',
	'\tunbind(): void {',
	'\t\treturn;',
	'\t}',
	'}',
].join('\n');

function gate(files, options = {}) {
	const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-gate-'));
	try {
		fs.mkdirSync(path.join(worktreeDir, 'tools/quality/baselines'), { recursive: true });
		fs.writeFileSync(path.join(worktreeDir, 'tools/quality/eslint-gate.cjs'), 'module.exports = {};\n');
		fs.writeFileSync(
			path.join(worktreeDir, 'tools/quality/baselines/quality-v1.json'),
			JSON.stringify({ fingerprints: [], findings: options.findings ?? [] }),
		);
		for (const [rel, text] of Object.entries(files)) {
			const abs = path.join(worktreeDir, rel);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, text);
		}
		if (options.jscpd !== undefined) {
			fs.writeFileSync(path.join(worktreeDir, 'tools/quality/jscpd.json'), options.jscpd);
		}
		return evaluateTaskQualityGate({
			worktreeDir,
			targetPackage: 'pkg',
			authoredPaths: options.authoredPaths ?? ['pkg/src/store.ts'],
			baseCommitSha: options.baseCommitSha === undefined ? 'a'.repeat(40) : options.baseCommitSha,
			gitCli: options.gitCli ?? null,
		});
	} finally {
		fs.rmSync(worktreeDir, { recursive: true, force: true });
	}
}

function hasNewClone(result) {
	return result.findings.some((finding) => finding.includes('new clone'));
}

test('@ac AC-02 a duplicated class declaration fails the task gate with both locations', () => {
	assert.equal(BRIDGE.split('\n').length, 8);
	const body = `${BRIDGE}\n`;
	const result = gate(
		{ 'pkg/src/store.ts': body, 'pkg/src/bridge.ts': body },
		{
			gitCli: (_command, args) => {
				if (String(args?.[1] ?? '').endsWith(':pkg/src/store.ts')) return '';
				throw new Error('absent');
			},
		},
	);
	assert.equal(result.pass, false);
	const finding = result.findings.find((line) => line.includes('new clone'));
	assert.ok(finding);
	assert.match(finding, /pkg\/src\/store\.ts:1-8/);
	assert.match(finding, /pkg\/src\/bridge\.ts:1-8/);
});

test('@ac AC-03 @case AC-03.1 a window overlapping a baseline range is not a new clone', () => {
	const body = `${BRIDGE}\n`;
	const result = gate(
		{ 'pkg/src/store.ts': body, 'pkg/src/bridge.ts': body },
		{
			findings: [{ tool: 'jscpd', location: 'pkg/src/store.ts:1-20' }],
			gitCli: (_command, args) => {
				if (String(args?.[1] ?? '').endsWith(':pkg/src/store.ts')) return body;
				throw new Error('absent');
			},
		},
	);
	assert.equal(result.pass, true);
	assert.equal(hasNewClone(result), false);
});

test('@ac AC-03 @case AC-03.2 a spec file is outside the new-clone scan', () => {
	const body = `${BRIDGE}\n`;
	const result = gate(
		{ 'pkg/src/store.ts': body, 'pkg/src/store.spec.ts': body },
		{ baseCommitSha: null },
	);
	assert.equal(result.pass, true);
	assert.equal(hasNewClone(result), false);
});

test('@ac AC-03 @case AC-03.4 a duplicate already present at base is not a new clone', () => {
	const body = `${BRIDGE}\n`;
	const result = gate(
		{ 'pkg/src/store.ts': body, 'pkg/src/bridge.ts': body },
		{ gitCli: () => body },
	);
	assert.equal(result.pass, true);
	assert.equal(hasNewClone(result), false);
});

test('a missing jscpd.json uses minLines 8 and a shorter or configured window does not fail', () => {
	const body = `${BRIDGE}\n`;
	const pair = { 'pkg/src/store.ts': body, 'pkg/src/bridge.ts': body };
	const raised = gate(pair, { jscpd: '{"minLines":9}\n', baseCommitSha: null });
	assert.equal(raised.pass, true);
	assert.equal(hasNewClone(raised), false);
	const short = `${BRIDGE.split('\n').slice(0, 7).join('\n')}\n`;
	const under = gate(
		{ 'pkg/src/store.ts': short, 'pkg/src/bridge.ts': short },
		{ baseCommitSha: null },
	);
	assert.equal(under.pass, true);
	assert.equal(hasNewClone(under), false);
	const malformed = gate(pair, { jscpd: '{', baseCommitSha: null });
	assert.equal(malformed.pass, false);
	assert.equal(hasNewClone(malformed), true);
});

test('minLines comes from jscpd.json beside the eslint config', () => {
	const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-gate-'));
	try {
		fs.mkdirSync(path.join(worktreeDir, 'pkg/lint'), { recursive: true });
		fs.writeFileSync(path.join(worktreeDir, 'pkg/lint/eslint.cjs'), 'module.exports = {};\n');
		fs.writeFileSync(
			path.join(worktreeDir, 'pkg/lint/baseline.json'),
			JSON.stringify({ fingerprints: [], findings: [] }),
		);
		fs.writeFileSync(path.join(worktreeDir, 'pkg/lint/jscpd.json'), '{"minLines":9}\n');
		const body = `${BRIDGE}\n`;
		for (const rel of ['pkg/src/store.ts', 'pkg/src/bridge.ts']) {
			const abs = path.join(worktreeDir, rel);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, body);
		}
		const result = evaluateTaskQualityGate({
			worktreeDir,
			targetPackage: 'pkg',
			authoredPaths: ['pkg/src/store.ts'],
			baseCommitSha: null,
			profile: {
				qualityGate: {
					eslintConfigPath: 'pkg/lint/eslint.cjs',
					baselinePath: 'pkg/lint/baseline.json',
				},
			},
		});
		assert.equal(result.pass, true);
		assert.equal(hasNewClone(result), false);
	} finally {
		fs.rmSync(worktreeDir, { recursive: true, force: true });
	}
});

test('duplicate import lines with no class or function declaration do not fail the gate', () => {
	const imports = Array.from({ length: 10 }, (_unused, index) => `import { Name${index} } from './m${index}.ts';`).join('\n');
	const result = gate(
		{ 'pkg/src/store.ts': `${imports}\n`, 'pkg/src/bridge.ts': `${imports}\n` },
		{ baseCommitSha: null },
	);
	assert.equal(result.pass, true);
	assert.deepEqual(result.findings, []);
});

test('a copied class matches after a trailing carriage return is stripped', () => {
	const result = gate(
		{
			'pkg/src/store.ts': `${BRIDGE}\n`,
			'pkg/src/bridge.ts': `${BRIDGE.split('\n').join('\r\n')}\r\n`,
		},
		{ baseCommitSha: null },
	);
	assert.equal(result.pass, false);
	assert.equal(hasNewClone(result), true);
});

test('a duplicated class names the declaration line through the identical run', () => {
	const result = gate(
		{
			'pkg/src/bridge.ts': `${'const keep = 1;\n'.repeat(5)}${BRIDGE}\n`,
			'pkg/src/store.ts': `${'const keep = 1;\n'.repeat(91)}${BRIDGE}\n`,
		},
		{
			gitCli: (_command, args) => {
				if (String(args?.[1] ?? '').endsWith(':pkg/src/store.ts')) return '';
				throw new Error('absent');
			},
		},
	);
	const finding = result.findings.find((line) => line.includes('new clone'));
	assert.ok(finding);
	assert.match(finding, /pkg\/src\/bridge\.ts:6-13/);
	assert.match(finding, /pkg\/src\/store\.ts:92-99/);
});

test('a thrown git show on a baseline file does not become a new clone', () => {
	const body = `${BRIDGE}\n`;
	const result = gate(
		{ 'pkg/src/store.ts': body, 'pkg/src/bridge.ts': body },
		{
			findings: [{ tool: 'jscpd', location: 'pkg/src/store.ts:1-20' }],
			gitCli: () => {
				throw new Error('show failed');
			},
		},
	);
	assert.equal(result.pass, true);
	assert.equal(hasNewClone(result), false);
});

test('a missing quality-gate config does not scan for a new clone', () => {
	const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-gate-'));
	try {
		const body = `${BRIDGE}\n`;
		for (const rel of ['pkg/src/store.ts', 'pkg/src/bridge.ts']) {
			const abs = path.join(worktreeDir, rel);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, body);
		}
		assert.deepEqual(
			evaluateTaskQualityGate({
				worktreeDir,
				targetPackage: 'pkg',
				authoredPaths: ['pkg/src/store.ts'],
			}),
			{ pass: true, findings: [] },
		);
	} finally {
		fs.rmSync(worktreeDir, { recursive: true, force: true });
	}
});

test('@ac AC-04 the quality-gate files stay within the navigability budget', () => {
	for (const name of ['task-quality-gate.ts', 'task-quality-gate.spec.mjs']) {
		const data = fs.readFileSync(new URL(name, import.meta.url));
		let lines = 0;
		for (const byte of data) if (byte === 10) lines += 1;
		assert.ok(lines <= 500 && data.length <= 20480, `${name} ${lines} lines ${data.length} bytes`);
	}
});
