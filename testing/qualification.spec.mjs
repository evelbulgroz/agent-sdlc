import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AGENT_SDLC_PACKAGE_ROOT } from '../policy/canary-planning-files.ts';
import { findProofBody } from './qualification/proof-finder.mjs';

const manifest = JSON.parse(
	fs.readFileSync(path.join(AGENT_SDLC_PACKAGE_ROOT, 'testing/qualification/cases.json'), 'utf8'),
);
const cases = manifest.cases;
const KINDS = Object.keys(manifest.outcomeClasses);

test('qualification manifest has unique ids and a predicted outcome for every case', () => {
	assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
	for (const c of cases) {
		assert.ok([1, 2].includes(c.tier), `${c.id} tier`);
		assert.ok(c.seededDefect && c.expectedOutcome, `${c.id} defect and outcome`);
	}
});

test('every tier 1 negative case is proven by a named test that asserts its expected code and messages', () => {
	const tier1 = cases.filter((c) => c.tier === 1);
	assert.ok(tier1.length >= 4);
	for (const c of tier1) {
		const source = fs.readFileSync(path.join(AGENT_SDLC_PACKAGE_ROOT, c.proof.file), 'utf8');
		const body = findProofBody(source, c.proof.test);
		assert.ok(body, `${c.id}: proof test missing in ${c.proof.file}`);
		assert.ok(body.includes(c.expectedCode), `${c.id}: proof must assert ${c.expectedCode}`);
		for (const message of c.expectedMessages ?? []) {
			assert.ok(body.includes(message), `${c.id}: proof must assert "${message}"`);
		}
	}
});

test('a known gap names the item that tracks it', () => {
	for (const c of cases.filter((entry) => entry.knownGap === true)) {
		assert.ok(typeof c.gapRef === 'string' && c.gapRef.length > 0, `${c.id}: gapRef`);
	}
});

test('N6 is split so each mismatch path and the expiry are pinned', () => {
	const byId = new Map(cases.map((c) => [c.id, c]));
	assert.equal(byId.get('N6a')?.expectedCode, 'AUTHORIZATION_EXPIRED');
	assert.equal(byId.get('N6b')?.expectedCode, 'AUTHORIZATION_INVALID');
	for (const message of ['Run ID mismatch', 'Base commit SHA mismatch', 'Approved spec hash mismatch']) {
		assert.ok(byId.get('N6b')?.expectedMessages?.includes(message), message);
	}
});

test('every tier 2 case has a kind with outcome classes, an engine fixture spec, and scoring, and needs no host', () => {
	const tier2 = cases.filter((c) => c.tier === 2);
	assert.ok(tier2.length >= 1);
	for (const c of tier2) {
		assert.ok(KINDS.includes(c.kind), `${c.id}: kind`);
		assert.ok(manifest.outcomeClasses[c.kind].length > 0, `${c.id}: outcome classes`);
		assert.match(c.fixtureSpec ?? '', /^testing\/qualification\/fixtures\/[\w.-]+\.md$/, `${c.id}: fixtureSpec`);
		assert.ok(c.scoring, `${c.id}: scoring`);
		assert.equal('spec' in c, false, `${c.id}: host spec field is retired`);
	}
});

test('@ac AC-01 the proof finder accepts test, it and any quote style, and still rejects a missing title', () => {
	const source = [
		"test('single quoted', () => { a(); });",
		'test("double quoted", () => { b(); });',
		'it(`backtick`, () => {\n\tc();\n\ttest(\'nested\', () => {});\n});',
		"test.skip('skipped', () => { d(); });",
	].join('\n');
	for (const [title, token] of [['single quoted', 'a()'], ['double quoted', 'b()'], ['backtick', 'c()'], ['skipped', 'd()']]) {
		assert.ok(findProofBody(source, title)?.includes(token), title);
	}
	assert.ok(findProofBody(source, 'backtick').includes("test('nested'"));
	assert.equal(findProofBody(source, 'renamed'), null);
});
