import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DENYLIST = new RegExp(
	[
		'fitness(?! for a particular)',
		'@example/',
		'apps/services',
		'apps/frontends',
		'apps/e2e',
		'security-config',
		'agent:preflight',
		'agent:test-sdlc',
		'quality:changed',
		'ddd-base',
		'conditioning',
		'packages/agent-sdlc',
	].join('|'),
	'i',
);

const EXEMPT = [
	/^testing\//,
	/\.spec\.mjs$/,
	/^docs\/specs\//,
	/^pnpm-lock\.yaml$/,
	/^reflections\.md$/,
	// The migration table intentionally names the old implicit behaviour.
	/^host\/README\.md$/,
];

function trackedFiles() {
	const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
		cwd: ENGINE_ROOT,
		encoding: 'utf8',
	});
	return out.split('\0').filter((file) => file && fs.existsSync(path.join(ENGINE_ROOT, file)));
}

test('denylist matches host literals and spares the license sentence', () => {
	assert.equal(DENYLIST.test('see apps/services/x'), true);
	assert.equal(DENYLIST.test('run agent:preflight'), true);
	assert.equal(DENYLIST.test('FITNESS-app'), true);
	assert.equal(DENYLIST.test('MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE'), false);
});

test('engine source, prompts, rubrics, profile, and docs reference no prior-host names or layout', () => {
	const offenders = [];
	for (const file of trackedFiles()) {
		if (EXEMPT.some((pattern) => pattern.test(file))) continue;
		const text = fs.readFileSync(path.join(ENGINE_ROOT, file), 'utf8');
		text.split('\n').forEach((line, index) => {
			if (DENYLIST.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 100)}`);
		});
	}
	assert.deepEqual(offenders, []);
});
