import assert from 'node:assert/strict';
import test from 'node:test';
import { extractTestExcerpts } from './excerpt-extractor.ts';

test('extractTestExcerpts formats compact lines with path:line for title and assertions', () => {
	const source = `
describe('suite', () => {
  it('happy path @ac AC-01', () => {
    const res = compute();
    expect(res).toBe(42);
    assert.equal(res, 42);
  });
});
`;
	const result = extractTestExcerpts({
		touchedFiles: [{ path: 'test/sample.spec.ts', content: source }],
		acceptanceCriteria: ['AC-01: Given input. Then 42.'],
	});

	assert.equal(result.fileCount, 1);
	assert.equal(result.testCount, 1);
	assert.match(result.text, /test\/sample\.spec\.ts:3 it\("happy path @ac AC-01"\)/);
	assert.match(result.text, /test\/sample\.spec\.ts:5 expect\(res\)\.toBe\(42\);/);
	assert.match(result.text, /test\/sample\.spec\.ts:6 assert\.equal\(res, 42\);/);
});

test('extractTestExcerpts truncates long assertion lines to 240 chars with … (AC-07)', () => {
	const hugePayload = 'x'.repeat(3000);
	const source = `
it('long assertion @ac AC-01', () => {
  expect(val).toEqual("${hugePayload}");
});
`;
	const result = extractTestExcerpts({
		touchedFiles: [{ path: 'test/huge.spec.ts', content: source }],
		acceptanceCriteria: ['AC-01: outcome.'],
	});

	assert.equal(result.testCount, 1);
	const assertLine = result.lines.find((l) => l.includes('expect(val)'));
	assert.ok(assertLine);
	// Line starts with path:line + space
	const prefix = 'test/huge.spec.ts:3 ';
	const assertText = assertLine.slice(prefix.length);
	assert.ok(assertText.length <= 240);
	assert.ok(assertText.endsWith('…'));
});

test('extractTestExcerpts emits (no assertion lines) for tests without assertions (AC-05)', () => {
	const source = `
it('empty test without assertions', () => {
  const a = 1;
  const b = 2;
});
`;
	const result = extractTestExcerpts({
		touchedFiles: [{ path: 'test/empty.spec.ts', content: source }],
	});

	assert.equal(result.testCount, 1);
	assert.match(result.text, /test\/empty\.spec\.ts:2 it\("empty test without assertions"\)/);
	assert.match(result.text, /\(no assertion lines\)/);
});

test('extractTestExcerpts enforces preserve-one rule and drops extra assertions first during eviction', () => {
	// 2 tests in one file, each with 3 assertions
	const source = `
it('test 1 @ac AC-01', () => {
  expect(1).toBe(1);
  expect(2).toBe(2);
  expect(3).toBe(3);
});
it('test 2 @ac AC-02', () => {
  expect(4).toBe(4);
  expect(5).toBe(5);
  expect(6).toBe(6);
});
`;
	// Set a tight line budget that forces dropping extra assertions
	const result = extractTestExcerpts({
		touchedFiles: [{ path: 'test/multi.spec.ts', content: source }],
		acceptanceCriteria: ['AC-01: first', 'AC-02: second'],
		maxLines: 5, // 2 tests * (1 title + 1 assert) = 4 lines <= 5 lines
	});

	assert.equal(result.testCount, 2);
	// Both tests retained exactly 1 assertion each (preserve-one rule held)
	assert.match(result.text, /expect\(1\)\.toBe\(1\)/);
	assert.doesNotMatch(result.text, /expect\(2\)\.toBe\(2\)/);
	assert.match(result.text, /expect\(4\)\.toBe\(4\)/);
	assert.doesNotMatch(result.text, /expect\(5\)\.toBe\(5\)/);
});

test('extractTestExcerpts evicts extra tests before oracle tests', () => {
	const normalSource = `
it('test A @ac AC-01', () => {
  expect(1).toBe(1);
});
it('test B non-ac', () => {
  expect(2).toBe(2);
});
`;
	const oracleSource = `
it('oracle test @ac AC-02 @oracle', () => {
  expect(3).toBe(3);
});
`;
	// Tight line budget: can only fit 2 tests (4 lines)
	const result = extractTestExcerpts({
		touchedFiles: [
			{ path: 'test/normal.spec.ts', content: normalSource },
			{ path: 'test/sample.oracle.spec.ts', content: oracleSource },
		],
		acceptanceCriteria: ['AC-01: normal', 'AC-02: oracle'],
		maxLines: 5,
	});

	// The non-AC test from normal.spec.ts should be evicted first, keeping test A and the oracle test
	assert.match(result.text, /oracle test/);
	assert.match(result.text, /test A/);
	assert.doesNotMatch(result.text, /test B/);
});

test('extractTestExcerpts throws INPUT_OVERSIZED with required fields when budget cannot fit (AC-09)', () => {
	const source = `
it('test A', () => {
  expect(1).toBe(1);
});
`;
	assert.throws(
		() =>
			extractTestExcerpts({
				touchedFiles: [{ path: 'test/normal.spec.ts', content: source }],
				maxBytes: 10, // Unreasonably small budget
			}),
		(err) => {
			assert.equal(err.code, 'INPUT_OVERSIZED');
			assert.ok(err.message.includes('split the run or reduce touched tests'));
			assert.ok(err.message.includes('bytes'));
			assert.ok(err.message.includes('lines'));
			assert.ok(err.message.includes('files'));
			assert.ok(err.message.includes('tests'));
			assert.ok(!err.message.includes('skip QA'));
			assert.ok(!err.message.includes('approvedSpecHash'));
			return true;
		},
	);
});

test('extractTestExcerpts returns (none) when touchedFiles is empty', () => {
	const result = extractTestExcerpts({ touchedFiles: [] });
	assert.equal(result.text, '(none)');
	assert.equal(result.fileCount, 0);
	assert.equal(result.testCount, 0);
});
