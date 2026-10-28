import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluateTaskQualityGate } from './task-quality-gate.ts';

test('@ac AC-06 evaluateTaskQualityGate passes with no authored paths', () => {
	assert.deepEqual(evaluateTaskQualityGate({}), { pass: true, findings: [] });
	assert.equal(
		evaluateTaskQualityGate({ worktreeDir: '/missing', targetPackage: 'pkg', authoredPaths: [] }).pass,
		true,
	);
});

test('evaluateTaskQualityGate does not import the tool dispatcher', () => {
	const source = fs.readFileSync(new URL('./task-quality-gate.ts', import.meta.url), 'utf8');
	assert.equal(source.includes('tools.ts'), false);
	assert.equal(source.includes('task-executor.ts'), false);
});

test('evaluateTaskQualityGate fails when a baseline clone moves', () => {
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
		assert.ok(result.findings.some((finding) => finding.includes('[jscpd]')));
	} finally {
		fs.rmSync(worktreeDir, { recursive: true, force: true });
	}
});
