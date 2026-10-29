import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

const IS_STANDALONE = !fs.existsSync(path.join(REPOSITORY_ROOT, 'packages/engine'));
const README = IS_STANDALONE ? 'README.md' : 'packages/engine/README.md';
const REVIEW_README = IS_STANDALONE ? 'review/README.md' : 'packages/engine/review/README.md';
const PACKAGE_AGENTS = IS_STANDALONE ? `${'AGENTS'}.md` : `packages/engine/${'AGENTS'}.md`;
const CODE_PHASE_COMMAND = 'agent-review --phase code';
const RESIDUAL_CLAIM = /residual[\s`-]*(?:`?phase=code`?|phase[\s`-]*code|code[\s-]*critic)/i;

function read(rel) {
	return fs.readFileSync(path.join(REPOSITORY_ROOT, rel), 'utf8');
}

function line(rel, marker) {
	const found = read(rel)
		.split('\n')
		.find((candidate) => candidate.includes(marker));
	assert.ok(found, `${rel} has no line containing ${marker}`);
	return found;
}

test('@ac AC-03 @case AC-03.1 @ac AC-08 @case AC-08.1 the README has no residual-code-critic box and names the standalone code phase', () => {
	const text = read(README);
	assert.equal(RESIDUAL_CLAIM.test(text), false);
	assert.equal(text.includes('[Residual code critic'), false);
	assert.ok(text.includes(CODE_PHASE_COMMAND));
});

test('@ac AC-03 @case AC-03.2 @ac AC-08 @case AC-08.2 the review module README names the spec, plan, and QA graph nodes and the standalone code phase', () => {
	const text = read(REVIEW_README);
	assert.equal(RESIDUAL_CLAIM.test(text), false);
	assert.match(text, /\| `spec` \| Graph node \(before `SPEC_APPROVED`\)/);
	assert.match(text, /\| `plan` \| Graph node \(before worktree creation\)/);
	assert.match(text, /\| `qa` \| Graph node \(after green preflight & AC coverage\)/);
	assert.ok(text.includes(CODE_PHASE_COMMAND));
	assert.match(text, /Never invoked from a graph node/);
});

test('@ac AC-08 @case AC-08.3 the package AGENTS.md review entry names spec, plan, qa, and standalone code', () => {
	const sentence = line(PACKAGE_AGENTS, './review/README.md');
	assert.equal(RESIDUAL_CLAIM.test(sentence), false);
	assert.match(sentence, /`spec`/);
	assert.match(sentence, /`plan`/);
	assert.match(sentence, /`qa`/);
	assert.match(sentence, /standalone `code`/);
});

test('@ac AC-08 @case AC-08.1 none of the three package living docs says the graph runs a residual phase-code critic', () => {
	for (const rel of [README, REVIEW_README, PACKAGE_AGENTS]) {
		assert.equal(RESIDUAL_CLAIM.test(read(rel)), false, rel);
	}
});
