import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scoreProducedSpec as scoreRound } from './round-half-away-oracle.mjs';
import { scoreProducedSpec as scoreWrap } from './wrap-index-oracle.mjs';

const WRAP_STRONG = `import assert from 'node:assert/strict';
import test from 'node:test';
import { wrapIndex } from './wrap-index.mjs';
test('wraps', () => {
	assert.equal(wrapIndex(-1, 5), 4);
	assert.equal(wrapIndex(5, 5), 0);
	assert.equal(wrapIndex(12, 5), 2);
	assert.equal(wrapIndex(0, 5), 0);
});
test('rejects invalid input', () => {
	for (const length of [0, -3, 2.5, Number.NaN]) assert.throws(() => wrapIndex(1, length), RangeError);
	assert.throws(() => wrapIndex(1.5, 5), RangeError);
});
`;
const WRAP_WEAK = `import assert from 'node:assert/strict';
import test from 'node:test';
import { wrapIndex } from './wrap-index.mjs';
test('wraps', () => assert.equal(wrapIndex(12, 5), 2));
test('rejects', () => assert.throws(() => wrapIndex(1, 0)));
`;
const ROUND_STRONG = `import assert from 'node:assert/strict';
import test from 'node:test';
import { roundHalfAway } from './round-half-away.mjs';
test('rounds half away from zero', () => {
	assert.equal(roundHalfAway(2.5), 3);
	assert.equal(roundHalfAway(-2.5), -3);
	assert.equal(roundHalfAway(1.25, 1), 1.3);
	assert.equal(roundHalfAway(-1.25, 1), -1.3);
	assert.equal(roundHalfAway(1.2345, 2), 1.23);
	assert.ok(Object.is(roundHalfAway(-0.4), 0));
});
test('rejects invalid input', () => {
	for (const v of [Number.NaN, Infinity]) assert.throws(() => roundHalfAway(v), RangeError);
	for (const d of [-1, 1.5, 11]) assert.throws(() => roundHalfAway(1, d), RangeError);
});
`;
const ROUND_WEAK = `import assert from 'node:assert/strict';
import test from 'node:test';
import { roundHalfAway } from './round-half-away.mjs';
test('rounds', () => {
	assert.equal(roundHalfAway(2.5), 3);
	assert.equal(roundHalfAway(1.25, 1), 1.3);
});
test('rejects', () => assert.throws(() => roundHalfAway(Number.NaN), RangeError));
`;

function score(scorer, source) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-spec-'));
	try {
		const file = path.join(dir, 'produced.spec.mjs');
		fs.writeFileSync(file, source);
		return scorer(file);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test('N2 oracle: a thorough produced spec passes the reference and kills every mutant', () => {
	const report = score(scoreWrap, WRAP_STRONG);
	assert.equal(report.referencePasses, true);
	assert.deepEqual(report.survivors, []);
});

test('N2 oracle: a weak produced spec leaves mutants alive', () => {
	const report = score(scoreWrap, WRAP_WEAK);
	assert.equal(report.referencePasses, true);
	assert.ok(report.survivors.includes('negative-not-wrapped'));
	assert.ok(report.survivors.includes('wrong-error-type'));
});

test('N2b oracle: a thorough spec kills every mutant and a positive-only spec leaves the negative-half mutant alive', () => {
	const strong = score(scoreRound, ROUND_STRONG);
	assert.equal(strong.referencePasses, true);
	assert.deepEqual(strong.survivors, []);
	const weak = score(scoreRound, ROUND_WEAK);
	assert.equal(weak.referencePasses, true);
	assert.ok(weak.survivors.includes('negative-half-toward-positive'));
	assert.ok(weak.survivors.includes('negative-zero-returned'));
});
