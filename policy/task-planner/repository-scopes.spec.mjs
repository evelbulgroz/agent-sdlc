import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { repositoryScopesOf, resolveTargetPackage, scanWorkspacePackages } from './workspace-packages.ts';

const profile = (workspace) => ({ adapter: 'default', workspace });

test('an empty workspace scan yields no packages instead of fabricated ones', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'no-pkgs-'));
	try {
		const scan = scanWorkspacePackages(root, profile({ packageRoots: ['packages', 'apps/services', 'apps/frontends'] }));
		assert.equal(scan.packageMap.size, 0);
		assert.equal(scan.pathToPackage.size, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('declared repositoryScopes resolve to the scope root and undeclared surfaces fail closed', () => {
	const p = profile({ repositoryScopes: ['docs/', 'package.json'], allowedPathRoots: ['src'] });
	assert.deepEqual(repositoryScopesOf(p), ['package.json', 'docs']);
	assert.equal(resolveTargetPackage('docs/specs/a.md', new Map(), { profile: p }), 'docs');
	assert.equal(resolveTargetPackage('package.json', new Map(), { profile: p }), 'package.json');
	assert.throws(
		() => resolveTargetPackage('tools/x.mjs', new Map(), { profile: p }),
		(error) => error.code === 'TASK_PLAN_INVALID',
	);
	assert.deepEqual(repositoryScopesOf(profile(undefined)), []);
});
