import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scoreProducedSpec } from './wrap-index-oracle.mjs';

const STRONG = `import assert from 'node:assert/strict';
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
const WEAK = `import assert from 'node:assert/strict';
import test from 'node:test';
import { wrapIndex } from './wrap-index.mjs';
test('wraps', () => assert.equal(wrapIndex(12, 5), 2));
test('rejects', () => assert.throws(() => wrapIndex(1, 0)));
`;

function score(source) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n2-oracle-spec-'));
	try {
		const file = path.join(dir, 'produced.spec.mjs');
		fs.writeFileSync(file, source);
		return scoreProducedSpec(file);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test('N2 oracle: a thorough produced spec passes the reference and kills every mutant', () => {
	const report = score(STRONG);
	assert.equal(report.referencePasses, true);
	assert.deepEqual(report.survivors, []);
});

test('N2 oracle: a weak produced spec leaves mutants alive', () => {
	const report = score(WEAK);
	assert.equal(report.referencePasses, true);
	assert.ok(report.survivors.includes('negative-not-wrapped'));
	assert.ok(report.survivors.includes('wrong-error-type'));
});
