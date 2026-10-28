import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

const PACKAGE_ROOT = path.join(REPOSITORY_ROOT, 'packages/agent-sdlc');

const DECOUPLED_PACKAGE_SPECS = Object.freeze([
	'testing/preflight-trigger.spec.mjs',
	'testing/verify-scripts.spec.mjs',
	'testing/test-discovery.spec.mjs',
	'testing/placement.spec.mjs',
	'testing/type-gate.spec.mjs',
	'testing/pilot-conversion.spec.mjs',
	'testing/factory-types.spec.mjs',
	'cli/commands/check-spec.spec.mjs',
]);

function readPackageJson() {
	return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
}

test('@ac AC-02 @case AC-02.1 packages/agent-sdlc/package.json typecheck script runs tsc --noEmit -p tsconfig.json', () => {
	const pkg = readPackageJson();
	assert.equal(pkg.scripts?.typecheck, 'tsc --noEmit -p tsconfig.json');
});

test('@ac AC-02 @case AC-02.2 devDependencies["@types/node"] equals ^22.18.0', () => {
	const pkg = readPackageJson();
	assert.equal(pkg.devDependencies?.['@types/node'], '^22.18.0');
});

test('@ac AC-02 @case AC-02.4 the package test:unit glob matches testing/type-gate.spec.mjs', () => {
	const pkg = readPackageJson();
	const script = pkg.scripts?.['test:unit'] ?? '';
	const match = script.match(/'([^']+\.spec\.mjs)'/);
	assert.ok(match, `expected quoted spec glob in test:unit: ${script}`);
	const pattern = match[1];
	assert.equal(pattern, '**/*.spec.mjs');
	const discovered = fs
		.globSync(pattern, { cwd: PACKAGE_ROOT })
		.map((entry) => entry.split(path.sep).join('/'));
	assert.equal(discovered.includes('testing/type-gate.spec.mjs'), true);
});

test('@ac AC-04 @case AC-04.1 @case AC-04.2 none of the 8 decoupled package spec files reads monorepo preflight script, host skills dir, or root package.json', () => {
	const preflightToken = ['tools', 'agent-preflight.sh'].join('/');
	const skillsToken = ['.agents', 'skills'].join('/');
	const rootPkgPattern = new RegExp(`path\\.join\\(\\s*REPOSITORY_ROOT\\s*,\\s*['"]package\\.json['"]\\s*\\)`);

	for (const relPath of DECOUPLED_PACKAGE_SPECS) {
		const absPath = path.join(PACKAGE_ROOT, relPath);
		const text = fs.readFileSync(absPath, 'utf8');
		assert.equal(
			text.includes(preflightToken),
			false,
			`${relPath} must not reference ${preflightToken}`,
		);
		assert.equal(
			text.includes(skillsToken),
			false,
			`${relPath} must not reference ${skillsToken}`,
		);
		assert.equal(
			rootPkgPattern.test(text),
			false,
			`${relPath} must not read root package.json via REPOSITORY_ROOT`,
		);
	}
});
