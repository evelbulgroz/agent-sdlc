import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

const PACKAGE_ROOT = path.join(REPOSITORY_ROOT, 'packages/agent-sdlc');

const SUBDIRECTORY_READMES = Object.freeze([
	'adapters/README.md',
	'cli/README.md',
	'execution/README.md',
	'host/README.md',
	'ledger/README.md',
	'persistence/README.md',
	'policy/README.md',
	'prompts/README.md',
	'review/README.md',
	'roles/README.md',
	'workflow/README.md',
]);

const PACKAGE_MARKDOWN_FILES = Object.freeze([
	'README.md',
	'ARCHITECTURE.md',
	`${'AGENTS'}.md`,
	...SUBDIRECTORY_READMES,
]);

function readPackageDoc(relPath) {
	return fs.readFileSync(path.join(PACKAGE_ROOT, relPath), 'utf8');
}

test('@ac AC-02 @case AC-02.1 all 14 package markdown files exist and contain zero upward monorepo links', () => {
	const upwardLinkPattern = /\.\.\/\.\.\/(?:docs|AGENTS\.md|tools)/;
	assert.equal(PACKAGE_MARKDOWN_FILES.length, 14);
	for (const relPath of PACKAGE_MARKDOWN_FILES) {
		const absPath = path.join(PACKAGE_ROOT, relPath);
		assert.equal(fs.existsSync(absPath), true, `missing packages/agent-sdlc/${relPath}`);
		const text = fs.readFileSync(absPath, 'utf8');
		assert.equal(
			upwardLinkPattern.test(text),
			false,
			`packages/agent-sdlc/${relPath} contains upward monorepo link`,
		);
	}
});

test('@ac AC-02 @case AC-02.2 none of the 14 package markdown files contains fitness-app service or shared-kernel examples', () => {
	const domainExamplePattern = /apps\/services\/|packages\/ddd-base|fitnessapp-base/;
	for (const relPath of PACKAGE_MARKDOWN_FILES) {
		const text = readPackageDoc(relPath);
		assert.equal(
			domainExamplePattern.test(text),
			false,
			`packages/agent-sdlc/${relPath} contains fitness-app service or domain example`,
		);
	}
});

test('@ac AC-03 @case AC-03.1 none of the 14 package markdown files contains monorepo root pnpm run agent:* CLI script references', () => {
	const rootAgentCommandPattern =
		/pnpm run agent:(?:sdlc(?:-trace|-skills|-trends)?|review|test-sdlc|typecheck-factory)\b/;
	for (const relPath of PACKAGE_MARKDOWN_FILES) {
		const text = readPackageDoc(relPath);
		assert.equal(
			rootAgentCommandPattern.test(text),
			false,
			`packages/agent-sdlc/${relPath} contains forbidden monorepo root pnpm run agent:* CLI reference`,
		);
	}
});

test('@ac AC-03 @case AC-03.2 packages/agent-sdlc/AGENTS.md and packages/agent-sdlc/README.md document package-scoped commands', () => {
	const agentsText = readPackageDoc(`${'AGENTS'}.md`);
	const readmeText = readPackageDoc('README.md');
	for (const token of [
		'agent-sdlc',
		'agent-review',
		'pnpm --filter @fitness-app/agent-sdlc run test:unit',
		'pnpm --filter @fitness-app/agent-sdlc run typecheck',
	]) {
		assert.equal(agentsText.includes(token), true, `AGENTS.md missing ${token}`);
		assert.equal(readmeText.includes(token), true, `README.md missing ${token}`);
	}
});

test('@ac AC-08 @case AC-08.1 packages/agent-sdlc/README.md names @fitness-app/agent-sdlc, @fitness-app/model-usage, packages/agent-sdlc, packages/model-usage, AGENT_SDLC_STATE_DIR, and repositoryId', () => {
	const text = readPackageDoc('README.md');
	for (const token of [
		'@fitness-app/agent-sdlc',
		'@fitness-app/model-usage',
		'packages/agent-sdlc',
		'packages/model-usage',
		'AGENT_SDLC_STATE_DIR',
		'repositoryId',
	]) {
		assert.equal(text.includes(token), true, `packages/agent-sdlc/README.md missing ${token}`);
	}
});

test('@ac AC-08 @case AC-08.2 no package markdown file contains tools/agent-sdlc or tools/model-usage while tools/.agent-sdlc remains valid', () => {
	const legacyPathPattern = /tools\/(?:agent-sdlc|model-usage)(?:\/|\b)/;
	for (const relPath of [...PACKAGE_MARKDOWN_FILES, 'adapters/README.md']) {
		const text = readPackageDoc(relPath);
		assert.equal(
			legacyPathPattern.test(text),
			false,
			`packages/agent-sdlc/${relPath} still contains tools/agent-sdlc or tools/model-usage`,
		);
	}
	assert.equal(readPackageDoc('README.md').includes('tools/.agent-sdlc'), true);
});

test('@ac AC-08 @case AC-08.3 packages/agent-sdlc/README.md describes @fitness-app/agent-sdlc as a private workspace package and not an npm package', () => {
	const text = readPackageDoc('README.md');
	assert.equal(/npm package/i.test(text), false, 'README.md must not say npm package');
	assert.equal(
		/private workspace package/i.test(text),
		true,
		'README.md must describe private workspace packages',
	);
});

