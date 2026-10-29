import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

const PACKAGE_ROOT = fs.existsSync(path.join(REPOSITORY_ROOT, 'packages/engine'))
	? path.join(REPOSITORY_ROOT, 'packages/engine')
	: REPOSITORY_ROOT;

test('@ac AC-09 @case AC-09.1 README.md mentions .agents/sdlc-host.json, host/, default, and script, and does not call packages/engine an npm package', () => {
	const readme = fs.readFileSync(path.join(PACKAGE_ROOT, 'README.md'), 'utf8');
	assert.match(readme, /\.agents\/sdlc-host\.json/);
	assert.match(readme, /host\//);
	assert.match(readme, /default/);
	assert.match(readme, /script/);
	assert.equal(/npm package/i.test(readme), false);
});

test('@ac AC-09 @case AC-09.2 host/README.md documents schemaVersion 1.3.0, declarative hydration/workspace/prompts/learnings, and the default and script adapters', () => {
	const hostReadme = fs.readFileSync(path.join(PACKAGE_ROOT, 'host/README.md'), 'utf8');
	assert.match(hostReadme, /\.agents\/sdlc-host\.json/);
	assert.match(hostReadme, /1\.3\.0/);
	assert.match(hostReadme, /default/);
	assert.match(hostReadme, /script/);
	assert.match(hostReadme, /learnings\.ts/);
	assert.equal(/npm package/i.test(hostReadme), false);
});

test('@ac AC-05 @case AC-05.1 packages/engine/README.md and packages/engine/host/README.md document .agent-sdlc default single-directory state, optional runsDir projection, and adding .agent-sdlc/ to .gitignore', () => {
	const readme = fs.readFileSync(path.join(PACKAGE_ROOT, 'README.md'), 'utf8');
	const hostReadme = fs.readFileSync(path.join(PACKAGE_ROOT, 'host/README.md'), 'utf8');
	for (const doc of [readme, hostReadme]) {
		assert.match(doc, /\.agent-sdlc/);
		assert.match(doc, /runsDir/);
		assert.match(doc, /\.gitignore/);
	}
});

test('@ac AC-05 @case AC-05.2 roles/README.md and prompts/README.md document .agents/workflows/ override resolution against roles/defaults/protocol/ and roles/defaults/philosophy/ with zero stale prompt-composer.ts or roles/defaults/prompts/ references', () => {
	const rolesReadme = fs.readFileSync(path.join(PACKAGE_ROOT, 'roles/README.md'), 'utf8');
	const promptsReadme = fs.readFileSync(path.join(PACKAGE_ROOT, 'prompts/README.md'), 'utf8');
	for (const doc of [rolesReadme, promptsReadme]) {
		assert.match(doc, /\.agents\/workflows\//);
		assert.match(doc, /roles\/defaults\/protocol\//);
		assert.match(doc, /roles\/defaults\/philosophy\//);
		assert.equal(doc.includes('prompt-composer.ts'), false);
		assert.equal(doc.includes('roles/defaults/prompts/'), false);
	}
});

test('@ac AC-05 @case AC-05.3 .agents/workflows/README.md links to ../../roles/README.md and ../../prompts/README.md as canonical and explains that .agents/workflows/ is optional for new clients', () => {
	const workflowsReadme = fs.readFileSync(
		path.join(REPOSITORY_ROOT, '.agents/workflows/README.md'),
		'utf8',
	);
	assert.match(workflowsReadme, /\.\.\/\.\.\/roles\/README\.md/);
	assert.match(workflowsReadme, /\.\.\/\.\.\/prompts\/README\.md/);
	assert.match(workflowsReadme, /optional/i);
});

test('@ac AC-04 @case AC-04.1 host/README.md documents the 3 verification tiers, exit-code self-attestation trust trade-off, verify-config.ts, and the verify:receipt case study', () => {
	const hostReadme = fs.readFileSync(path.join(PACKAGE_ROOT, 'host/README.md'), 'utf8');
	assert.match(hostReadme, /verify-config\.ts/);
	assert.match(hostReadme, /Tier 1/);
	assert.match(hostReadme, /npm test/);
	assert.match(hostReadme, /Tier 2/);
	assert.match(hostReadme, /verify\.argv/);
	assert.match(hostReadme, /Tier 3/);
	assert.match(hostReadme, /resultPath/);
	assert.match(hostReadme, /self-attested/i);
	assert.match(hostReadme, /verify:receipt/);
	assert.match(hostReadme, /\{baseSha\}/);
	assert.match(hostReadme, /PARTIAL/);
	assert.match(hostReadme, /canonical/);
	assert.match(hostReadme, /gitHeadSha/);
	assert.match(hostReadme, /EXIT/);
});

test('@ac AC-04 @case AC-04.2 README.md and review/README.md reflect configurable host verification (verify.argv / npm test default and receipt-backed verify:receipt)', () => {
	const readme = fs.readFileSync(path.join(PACKAGE_ROOT, 'README.md'), 'utf8');
	const reviewReadme = fs.readFileSync(path.join(PACKAGE_ROOT, 'review/README.md'), 'utf8');
	for (const doc of [readme, reviewReadme]) {
		assert.match(doc, /verify\.argv/);
		assert.match(doc, /npm test/);
		assert.match(doc, /verify:receipt/);
		assert.match(doc, /verify-config\.ts/);
	}
});

