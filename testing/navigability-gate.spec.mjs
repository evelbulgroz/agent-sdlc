import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import {
	NAVIGABILITY_BYTE_CEILING,
	NAVIGABILITY_LINE_CEILING,
	findNavigabilityViolations,
} from './navigability-support.mjs';

function makeRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'navigability-gate-'));
}

function writeFile(root, rel, contents) {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, contents);
}

function names(violations) {
	return violations.map((violation) => violation.path);
}

test('@ac AC-01 @case AC-01.1 an unlisted file over 500 lines or 20,480 bytes fails and the exact ceiling passes', () => {
	const root = makeRoot();
	try {
		writeFile(root, 'packages/agent-sdlc/workflow/big.mjs', `${'x\n'.repeat(501)}`);
		writeFile(root, 'packages/agent-sdlc/workflow/wide.mjs', 'a'.repeat(NAVIGABILITY_BYTE_CEILING + 1));
		const exact = `${'a'.repeat(NAVIGABILITY_BYTE_CEILING - NAVIGABILITY_LINE_CEILING)}${'\n'.repeat(NAVIGABILITY_LINE_CEILING)}`;
		assert.equal(exact.length, NAVIGABILITY_BYTE_CEILING);
		assert.equal(exact.split('').filter((char) => char === '\n').length, NAVIGABILITY_LINE_CEILING);
		writeFile(root, 'packages/agent-sdlc/workflow/exact.mjs', exact);
		const violations = findNavigabilityViolations(root, {});
		assert.deepEqual(names(violations), [
			'packages/agent-sdlc/workflow/big.mjs',
			'packages/agent-sdlc/workflow/wide.mjs',
		]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.2 a listed file one line or one byte over its entry fails naming that path', () => {
	const root = makeRoot();
	try {
		writeFile(root, 'packages/agent-sdlc/workflow/taller.mjs', 'a\n'.repeat(11));
		writeFile(root, 'packages/agent-sdlc/workflow/wider.mjs', 'abcdef');
		const violations = findNavigabilityViolations(root, {
			'packages/agent-sdlc/workflow/taller.mjs': { lines: 10, bytes: 1000 },
			'packages/agent-sdlc/workflow/wider.mjs': { lines: 10, bytes: 5 },
		});
		assert.deepEqual(names(violations), [
			'packages/agent-sdlc/workflow/taller.mjs',
			'packages/agent-sdlc/workflow/wider.mjs',
		]);
		assert.equal(violations.every((violation) => violation.reason === 'grown'), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.3 a listed file within the ceiling and a missing listed path do not fail', () => {
	const root = makeRoot();
	try {
		writeFile(root, 'packages/agent-sdlc/workflow/shrunk.mjs', 'a\n');
		const violations = findNavigabilityViolations(root, {
			'packages/agent-sdlc/workflow/shrunk.mjs': { lines: 600, bytes: 30_000 },
			'packages/agent-sdlc/workflow/gone.mjs': { lines: 900, bytes: 40_000 },
		});
		assert.deepEqual(violations, []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.4 exempt files are ignored and an oversized testing spec fails', () => {
	const root = makeRoot();
	try {
		const oversized = `${'x\n'.repeat(501)}`;
		writeFile(root, 'packages/agent-sdlc/testing/fixtures/big.mjs', oversized);
		writeFile(root, 'packages/model-usage/ledger-test-support.mjs', oversized);
		writeFile(root, 'packages/agent-sdlc/workflow/notes.json', oversized);
		writeFile(root, 'packages/agent-sdlc/workflow/node_modules/pkg/big.mjs', oversized);
		writeFile(root, 'packages/agent-sdlc/testing/big.spec.mjs', oversized);
		const violations = findNavigabilityViolations(root, {});
		assert.deepEqual(names(violations), ['packages/agent-sdlc/testing/big.spec.mjs']);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.5 an unlisted oversized TypeScript file fails naming that path', () => {
	const root = makeRoot();
	try {
		writeFile(root, 'packages/agent-sdlc/workflow/big.ts', `${'x\n'.repeat(501)}`);
		const violations = findNavigabilityViolations(root, {});
		assert.deepEqual(names(violations), ['packages/agent-sdlc/workflow/big.ts']);
		assert.equal(violations[0].reason, 'unlisted');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.6 the repository tree returns no violation against the committed exceptions file', () => {
	const exceptions = JSON.parse(
		fs.readFileSync(
			path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/testing/navigability-exceptions.json'),
			'utf8',
		),
	);
	assert.deepEqual(findNavigabilityViolations(REPOSITORY_ROOT, exceptions), []);
});

test('@ac AC-01 an empty temporary root reports no violation', () => {
	const root = makeRoot();
	try {
		assert.deepEqual(findNavigabilityViolations(root, {}), []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
