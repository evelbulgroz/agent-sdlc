import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

const PACKAGE_ROOT = path.join(REPOSITORY_ROOT, 'packages/agent-sdlc');

test('@ac AC-09 @case AC-09.1 packages/agent-sdlc/README.md mentions .agents/sdlc-host.json, host/, fitness-app, and script, and does not call packages/agent-sdlc an npm package', () => {
	const readme = fs.readFileSync(path.join(PACKAGE_ROOT, 'README.md'), 'utf8');
	assert.match(readme, /\.agents\/sdlc-host\.json/);
	assert.match(readme, /host\//);
	assert.match(readme, /fitness-app/);
	assert.match(readme, /script/);
	assert.equal(/npm package/i.test(readme), false);
});

test('@ac AC-09 @case AC-09.2 packages/agent-sdlc/host/README.md documents schemaVersion 1.3.0, declarative hydration/workspace/prompts/learnings, and the fitness-app and script adapters', () => {
	const hostReadme = fs.readFileSync(path.join(PACKAGE_ROOT, 'host/README.md'), 'utf8');
	assert.match(hostReadme, /\.agents\/sdlc-host\.json/);
	assert.match(hostReadme, /1\.3\.0/);
	assert.match(hostReadme, /fitness-app/);
	assert.match(hostReadme, /script/);
	assert.match(hostReadme, /learnings\.ts/);
	assert.equal(/npm package/i.test(hostReadme), false);
});

test('@ac AC-05 @case AC-05.1 packages/agent-sdlc/README.md and packages/agent-sdlc/host/README.md document .agent-sdlc default single-directory state, optional runsDir projection, and adding .agent-sdlc/ to .gitignore', () => {
	const readme = fs.readFileSync(path.join(PACKAGE_ROOT, 'README.md'), 'utf8');
	const hostReadme = fs.readFileSync(path.join(PACKAGE_ROOT, 'host/README.md'), 'utf8');
	for (const doc of [readme, hostReadme]) {
		assert.match(doc, /\.agent-sdlc/);
		assert.match(doc, /runsDir/);
		assert.match(doc, /\.gitignore/);
	}
});

test('@ac AC-05 @case AC-05.2 packages/agent-sdlc/roles/README.md and packages/agent-sdlc/prompts/README.md document .agents/workflows/ override resolution against roles/defaults/protocol/ and roles/defaults/philosophy/ with zero stale prompt-composer.ts or roles/defaults/prompts/ references', () => {
	const rolesReadme = fs.readFileSync(path.join(PACKAGE_ROOT, 'roles/README.md'), 'utf8');
	const promptsReadme = fs.readFileSync(path.join(PACKAGE_ROOT, 'prompts/README.md'), 'utf8');
	for (const doc of [rolesReadme, promptsReadme]) {
		assert.match(doc, /\.agents\/workflows\//);
		assert.match(doc, /packages\/agent-sdlc\/roles\/defaults\/protocol\//);
		assert.match(doc, /packages\/agent-sdlc\/roles\/defaults\/philosophy\//);
		assert.equal(doc.includes('prompt-composer.ts'), false);
		assert.equal(doc.includes('roles/defaults/prompts/'), false);
	}
});

test('@ac AC-05 @case AC-05.3 .agents/workflows/README.md links to ../../packages/agent-sdlc/roles/README.md and ../../packages/agent-sdlc/prompts/README.md as canonical and explains that .agents/workflows/ is optional for new clients', () => {
	const workflowsReadme = fs.readFileSync(
		path.join(REPOSITORY_ROOT, '.agents/workflows/README.md'),
		'utf8',
	);
	assert.match(workflowsReadme, /\.\.\/\.\.\/packages\/agent-sdlc\/roles\/README\.md/);
	assert.match(workflowsReadme, /\.\.\/\.\.\/packages\/agent-sdlc\/prompts\/README\.md/);
	assert.match(workflowsReadme, /optional/i);
});

test('@ac AC-04 @case AC-04.1 packages/agent-sdlc/host/README.md documents the 3 verification tiers, exit-code self-attestation trust trade-off, verify-config.ts, and the agent:preflight case study', () => {
	const hostReadme = fs.readFileSync(path.join(PACKAGE_ROOT, 'host/README.md'), 'utf8');
	assert.match(hostReadme, /verify-config\.ts/);
	assert.match(hostReadme, /Tier 1/);
	assert.match(hostReadme, /npm test/);
	assert.match(hostReadme, /Tier 2/);
	assert.match(hostReadme, /verify\.argv/);
	assert.match(hostReadme, /Tier 3/);
	assert.match(hostReadme, /resultPath/);
	assert.match(hostReadme, /self-attested/i);
	assert.match(hostReadme, /agent:preflight/);
	assert.match(hostReadme, /\{baseSha\}/);
	assert.match(hostReadme, /PARTIAL/);
	assert.match(hostReadme, /canonical/);
	assert.match(hostReadme, /gitHeadSha/);
	assert.match(hostReadme, /EXIT/);
});

test('@ac AC-04 @case AC-04.2 packages/agent-sdlc/README.md and packages/agent-sdlc/review/README.md reflect configurable host verification (verify.argv / npm test default and receipt-backed agent:preflight)', () => {
	const readme = fs.readFileSync(path.join(PACKAGE_ROOT, 'README.md'), 'utf8');
	const reviewReadme = fs.readFileSync(path.join(PACKAGE_ROOT, 'review/README.md'), 'utf8');
	for (const doc of [readme, reviewReadme]) {
		assert.match(doc, /verify\.argv/);
		assert.match(doc, /npm test/);
		assert.match(doc, /agent:preflight/);
		assert.match(doc, /verify-config\.ts/);
	}
});

