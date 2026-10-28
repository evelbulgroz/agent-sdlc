import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import * as continuationFixtures from './continuation-fixtures.mjs';
import {
	findNavigabilityViolations,
	NAVIGABILITY_BYTE_CEILING,
	NAVIGABILITY_LINE_CEILING,
} from './navigability-support.mjs';
import * as recoveryFixtures from './recovery-fixtures.mjs';

const FROZEN_RECOVERY_TITLES = Object.freeze(
	[
		'Slice 2 execution and repair crash boundaries resume without duplicate effects',
		'Slice 3 git and commit crash boundaries resume without duplicate commits',
		'Slice 4 multi-task execution and reconciliation crash boundaries resume cleanly',
		'answer-record crash window resumes once without duplicate event or model operation',
		'atomic cancellation transaction boundary rolls back completely on mid-transaction fault',
		'blocked, revision, rejection, cancellation, and operator-cancel boundaries recover',
		'comprehensive reconciliation fails closed for every canonical record family',
		'named answer and approval crash boundaries resume exactly once',
		'named graph and projection crash boundaries resume without duplicate effects',
		'production CLI blocks with valid JSON and zero network when no route is enabled',
		'production CLI import graph excludes testing adapters and limits providers to governor',
		'production import traversal follows from, side-effect, and dynamic imports',
		'projection drift fails closed with actionable status',
	].sort(),
);

const FROZEN_CONTINUATION_TITLES = Object.freeze(
	[
		'@ac AC-01 @ac AC-10 SPEC_APPROVED without an envelope exits 2 on a consumed authorize card',
		'@ac AC-01 @ac AC-10 approval pause replays one host card from the command, status, and status.json',
		'@ac AC-01 @ac AC-14 headless approve binds hash and yields exit 2 authorize without envelope',
		'@ac AC-02 @ac AC-14 a stored envelope admits planning and a plan-critic residual waits for a human answer',
		'@ac AC-03 @ac AC-09 @ac AC-10 @ac AC-14 hydration failure continues once with resume and halts on repeated resume with stop',
		'@ac AC-04 @ac AC-14 proven provider interruption continues task from checkpoint leaving sibling completed',
		'@ac AC-04 route exhaustion continues once without proven non-execution',
		'@ac AC-05 @ac AC-06 @ac AC-07 @ac AC-14 exhausted repair halts on resume and only resets on resume --retry',
		'@ac AC-08 @ac AC-14 authorized manifest change refreshes lockfile via pnpm install before frozen install',
		'@ac AC-10 @ac AC-14 HEAD drift maintains envelope baseCommitSha for detached worktree',
		'@ac AC-11 reconciliation conflict interrupt exits 2 with answer and HUMAN_RESPONSE_REQUIRED',
		'@ac AC-12 READY_FOR_GIT_APPROVAL exits 0 with stop and GIT_APPROVAL',
		'@ac AC-13 @ac AC-14 both host documents describe the same continuation loop',
		'@ac AC-14 fixture source file strictly contains zero forbidden vendor tokens',
		'@ac AC-15 committed model limits do not increase and profiles stay coherent',
	].sort(),
);

const IS_STANDALONE = !fs.existsSync(path.join(REPOSITORY_ROOT, 'packages/agent-sdlc'));
const SDLC_ROOT = IS_STANDALONE ? REPOSITORY_ROOT : path.join(REPOSITORY_ROOT, 'packages/agent-sdlc');

function resolveRepo(rel) {
	if (fs.existsSync(path.join(REPOSITORY_ROOT, rel))) return path.join(REPOSITORY_ROOT, rel);
	return path.join(SDLC_ROOT, rel.replace(/^packages\/agent-sdlc\//, ''));
}

const RECOVERY_FILES = Object.freeze([
	'packages/agent-sdlc/workflow/recovery-answer-boundaries.spec.mjs',
	'packages/agent-sdlc/workflow/recovery-production-isolation.spec.mjs',
	'packages/agent-sdlc/workflow/recovery-graph-boundaries.spec.mjs',
	'packages/agent-sdlc/workflow/recovery-reconciliation.spec.mjs',
	'packages/agent-sdlc/workflow/recovery-execution-boundaries.spec.mjs',
	'packages/agent-sdlc/workflow/recovery-delivery-boundaries.spec.mjs',
]);

const CONTINUATION_FILES = Object.freeze([
	'packages/agent-sdlc/workflow/continuation-authorization.spec.mjs',
	'packages/agent-sdlc/workflow/continuation-hydration.spec.mjs',
	'packages/agent-sdlc/workflow/continuation-interruption.spec.mjs',
	'packages/agent-sdlc/workflow/continuation-planning.spec.mjs',
]);

function measure(rel) {
	const data = fs.readFileSync(resolveRepo(rel));
	let lines = 0;
	for (const byte of data) {
		if (byte === 0x0a) lines += 1;
	}
	return { lines, bytes: data.length };
}

function topLevelTestTitles(rel) {
	const source = fs.readFileSync(resolveRepo(rel), 'utf8');
	return [...source.matchAll(/^test\(\s*'([^']+)'/gm)].map((match) => match[1]);
}

function definedNames(rel) {
	const source = fs.readFileSync(resolveRepo(rel), 'utf8');
	const names = new Set();
	for (const match of source.matchAll(
		/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)|^(?:export\s+)?(?:const|let)\s+([A-Za-z0-9_]+)/gm,
	)) {
		names.add(match[1] ?? match[2]);
	}
	return names;
}

test('@ac AC-01 @case AC-01.1 recovery.spec.mjs is absent and the six recovery spec files are within the ceiling', () => {
	assert.equal(
		fs.existsSync(resolveRepo('packages/agent-sdlc/workflow/recovery.spec.mjs')),
		false,
	);
	for (const rel of RECOVERY_FILES) {
		const size = measure(rel);
		assert.ok(size.lines <= NAVIGABILITY_LINE_CEILING, `${rel} lines ${size.lines}`);
		assert.ok(size.bytes <= NAVIGABILITY_BYTE_CEILING, `${rel} bytes ${size.bytes}`);
	}
});

test('@ac AC-01 @case AC-01.2 each frozen recovery title appears in exactly one recovery-*.spec.mjs file', () => {
	const workflowDir = path.join(SDLC_ROOT, 'workflow');
	const matching = fs
		.readdirSync(workflowDir)
		.filter((name) => /^recovery.*\.spec\.mjs$/.test(name))
		.map((name) => `packages/agent-sdlc/workflow/${name}`)
		.sort();
	assert.deepEqual(matching, [...RECOVERY_FILES].sort());
	const allTitles = matching.flatMap((rel) => topLevelTestTitles(rel));
	assert.equal(allTitles.length, FROZEN_RECOVERY_TITLES.length);
	assert.deepEqual([...allTitles].sort(), [...FROZEN_RECOVERY_TITLES]);
});

test('@ac AC-01 @case AC-01.3 no recovery spec file defines a helper that testing/recovery-fixtures.mjs exports', () => {
	const exported = Object.keys(recoveryFixtures);
	assert.ok(exported.length > 0);
	for (const rel of RECOVERY_FILES) {
		const defined = definedNames(rel);
		for (const helper of exported) {
			assert.equal(defined.has(helper), false, `${rel} defines ${helper}`);
		}
	}
});

test('@ac AC-02 @case AC-02.1 continuation.spec.mjs is absent and the four continuation spec files are within the ceiling', () => {
	assert.equal(
		fs.existsSync(resolveRepo('packages/agent-sdlc/workflow/continuation.spec.mjs')),
		false,
	);
	for (const rel of CONTINUATION_FILES) {
		const size = measure(rel);
		assert.ok(size.lines <= NAVIGABILITY_LINE_CEILING, `${rel} lines ${size.lines}`);
		assert.ok(size.bytes <= NAVIGABILITY_BYTE_CEILING, `${rel} bytes ${size.bytes}`);
	}
});

test('@ac AC-02 @case AC-02.2 each frozen continuation title appears in exactly one continuation-*.spec.mjs file', () => {
	const workflowDir = path.join(SDLC_ROOT, 'workflow');
	const matching = fs
		.readdirSync(workflowDir)
		.filter((name) => /^continuation.*\.spec\.mjs$/.test(name))
		.map((name) => `packages/agent-sdlc/workflow/${name}`)
		.sort();
	assert.deepEqual(matching, [...CONTINUATION_FILES].sort());
	const allTitles = matching.flatMap((rel) => topLevelTestTitles(rel));
	assert.equal(allTitles.length, FROZEN_CONTINUATION_TITLES.length);
	assert.deepEqual([...allTitles].sort(), [...FROZEN_CONTINUATION_TITLES]);
});

test('@ac AC-02 @case AC-02.3 no continuation spec file defines a helper that testing/continuation-fixtures.mjs exports', () => {
	const exported = Object.keys(continuationFixtures);
	assert.ok(exported.length > 0);
	for (const rel of CONTINUATION_FILES) {
		const defined = definedNames(rel);
		for (const helper of exported) {
			assert.equal(defined.has(helper), false, `${rel} defines ${helper}`);
		}
	}
});

test('@ac AC-03 @case AC-03.1 the navigability exceptions file parses to an object with no keys', () => {
	const raw = fs.readFileSync(
		path.join(SDLC_ROOT, 'testing/navigability-exceptions.json'),
		'utf8',
	);
	const parsed = JSON.parse(raw);
	assert.equal(typeof parsed, 'object');
	assert.notEqual(parsed, null);
	assert.equal(Array.isArray(parsed), false);
	assert.deepEqual(Object.keys(parsed), []);
});

test('@ac AC-03 @case AC-03.2 the navigability gate passes on the repository tree with no exceptions', () => {
	assert.deepEqual(findNavigabilityViolations(REPOSITORY_ROOT, {}), []);
});

test('@ac AC-03 @case AC-03.3 in a temporary root a 501-line *.spec.mjs file makes the gate fail and name that file', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepen-test-suites-'));
	try {
		const rel = 'packages/agent-sdlc/workflow/oversized.spec.mjs';
		const full = path.join(root, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, 'x\n'.repeat(501));
		const violations = findNavigabilityViolations(root, {});
		assert.deepEqual(
			violations.map((item) => item.path),
			[rel],
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-04 packages/agent-sdlc/README.md names no recovery.spec.mjs or continuation.spec.mjs path and every spec path it names exists', () => {
	const readme = fs.readFileSync(path.join(SDLC_ROOT, 'README.md'), 'utf8');
	assert.doesNotMatch(readme, /\brecovery\.spec\.mjs\b/);
	assert.doesNotMatch(readme, /\bcontinuation\.spec\.mjs\b/);
	for (const match of readme.matchAll(
		/(?:tools|packages)\/agent-sdlc\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.spec\.mjs/g,
	)) {
		assert.equal(fs.existsSync(resolveRepo(match[0])), true, match[0]);
	}
});
