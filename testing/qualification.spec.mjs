import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AGENT_SDLC_PACKAGE_ROOT } from '../policy/canary-planning-files.ts';

const cases = JSON.parse(
	fs.readFileSync(path.join(AGENT_SDLC_PACKAGE_ROOT, 'testing/qualification/cases.json'), 'utf8'),
).cases;

test('qualification manifest has unique ids and a predicted outcome for every case', () => {
	assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
	for (const c of cases) {
		assert.ok([1, 2].includes(c.tier), `${c.id} tier`);
		assert.ok(c.seededDefect && c.expectedOutcome, `${c.id} defect and outcome`);
	}
});

test('every tier 1 negative case is proven by a named test that asserts its expected code', () => {
	const tier1 = cases.filter((c) => c.tier === 1);
	assert.ok(tier1.length >= 4);
	for (const c of tier1) {
		const source = fs.readFileSync(path.join(AGENT_SDLC_PACKAGE_ROOT, c.proof.file), 'utf8');
		const start = source.indexOf(`test('${c.proof.test}'`);
		assert.ok(start >= 0, `${c.id}: proof test missing in ${c.proof.file}`);
		const next = source.indexOf('\ntest(', start + 1);
		const body = source.slice(start, next < 0 ? undefined : next);
		assert.ok(body.includes(c.expectedCode), `${c.id}: proof must assert ${c.expectedCode}`);
	}
});
