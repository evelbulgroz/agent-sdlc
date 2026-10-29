import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

const IS_STANDALONE = !fs.existsSync(path.join(REPOSITORY_ROOT, 'packages/agent-sdlc'));
const ROOT = IS_STANDALONE ? REPOSITORY_ROOT : path.join(REPOSITORY_ROOT, 'packages/agent-sdlc');
const PACKAGE_AGENTS_DOC = `${'AGENTS'}.md`;

/** Direct children the factory root may contain. Membership is not required. */
const ALLOWED_CHILDREN = new Set([
	PACKAGE_AGENTS_DOC,
	'ARCHITECTURE.md',
	'README.md',
	'reflections.md',
	'package.json',
	'pnpm-lock.yaml',
	'pnpm-workspace.yaml',
	'.npmrc',
	'.gitignore',
	'.git',
	'.tmp',
	'.agents',
	'tools',
	'tsconfig.json',
	'tsconfig.build.json',
	'dist',
	'docs',
	'node_modules',
	'.turbo',
	'agent-status-validate.ts',
	'testing',
	'scripts',
	'cli',
	'workflow',
	'execution',
	'review',
	'persistence',
	'policy',
	'roles',
	'adapters',
	'host',
	'ledger',
	'prompts',
]);

test('@ac AC-01 the factory root holds only allowlisted children', () => {
	const children = fs.readdirSync(ROOT);
	for (const name of children) {
		assert.equal(ALLOWED_CHILDREN.has(name), true, name);
	}
	assert.equal(children.some((name) => name.endsWith('.mjs')), false);
});

test('@ac AC-01 @case AC-01.1 cli.mjs and contracts.mjs are absent from the factory root', () => {
	assert.equal(fs.existsSync(path.join(ROOT, 'cli.mjs')), false);
	assert.equal(fs.existsSync(path.join(ROOT, 'contracts.mjs')), false);
});

test('@ac AC-01 @case AC-01.2 review/agent-review.ts exists inside the package', () => {
	assert.equal(fs.existsSync(path.join(ROOT, 'review/agent-review.ts')), true);
});

test('@ac AC-01 @case AC-01.3 controlled-executor.mjs is absent', () => {
	assert.equal(fs.existsSync(path.join(ROOT, 'controlled-executor.mjs')), false);
});

test('@ac AC-01 @case AC-01.4 package.json declares bin and standalone scripts for the package layout', () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
	assert.equal(pkg.bin?.['agent-sdlc'], './dist/cli/cli.js');
	assert.equal(
		pkg.scripts?.['test:unit'],
		"node --test --test-concurrency=1 '**/*.spec.mjs'",
	);
	assert.equal(pkg.scripts?.typecheck, 'tsc --noEmit -p tsconfig.json');
});

test('@ac AC-01 @case AC-01.5 cli/cli.ts help exits 0 and prints usage', () => {
	const result = spawnSync(process.execPath, [path.join(ROOT, 'cli/cli.ts'), 'help'], {
		cwd: ROOT,
		encoding: 'utf8',
		timeout: 60_000,
	});
	const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
	assert.equal(result.status, 0, output);
	assert.match(output, /Usage:/);
});
