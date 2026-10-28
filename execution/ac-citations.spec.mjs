import assert from 'node:assert/strict';
import test from 'node:test';
import {
	approvedAcIds,
	isOraclePath,
	parseTestCitations,
} from './ac-citations.ts';

const AC01 =
	'AC-01: An exact spec is approved. Given a complete grammatical draft and operator approval. Then approvedSpecHash equals the draft hash.';
const AC02 =
	'AC-02: Second criterion is stored. Given a newline-separated answer. Then both ids are unique.';
const AC03 =
	'AC-03: Third criterion stays uncovered. Given no citing test. Then ac-coverage reports AC-03.';
const AC_WITH_CASES =
	'AC-04: Every branch is observed. Given either username or password is empty. Then submission is disabled. Cases: AC-04.1: username empty with password present; AC-04.2: password empty with username present.';

test('isOraclePath matches oracle spec suffixes only', () => {
	assert.equal(isOraclePath('apps/x/foo.oracle.spec.ts'), true);
	assert.equal(isOraclePath('apps/x/foo.oracle.spec.tsx'), true);
	assert.equal(isOraclePath('./apps/x/foo.oracle.spec.ts'), true);
	assert.equal(isOraclePath('apps/x/foo.spec.ts'), false);
	assert.equal(isOraclePath(''), false);
	assert.equal(isOraclePath(null), false);
});

test('parseTestCitations dedupes duplicate @ac tags and allows @regression together', () => {
	const source = `
describe('feature', () => {
  it('covers the outcome @ac AC-01 @ac AC-01 @regression bug-1 @shadow happy', () => {
    expect(true).toBe(true);
  });
});
`;
	const tests = parseTestCitations(source, 'src/feature.spec.ts');
	assert.equal(tests.length, 1);
	assert.deepEqual(tests[0].acIds, ['AC-01']);
	assert.deepEqual(tests[0].caseIds, []);
	assert.equal(tests[0].regressionId, 'bug-1');
	assert.equal(tests[0].shadow, 'happy');
	assert.equal(tests[0].hasAssertion, true);
});

test('approvedAcIds ignores ungrammatical strings', () => {
	assert.deepEqual(approvedAcIds(['One outcome', AC01]), ['AC-01']);
});

test('@ac AC-09 parseTestCitations recognizes test.concurrent and it.each parameterized call sites', () => {
	const source = `
describe('feature', () => {
  test.concurrent('runs concurrently @ac AC-01', async () => {
    expect(true).toBe(true);
  });

  it.each([
    [1, 2, 3],
    [2, 3, 5],
  ])('adds %i + %i to equal %i @ac AC-02', (a, b, expected) => {
    assert.equal(a + b, expected);
  });
});
`;
	const tests = parseTestCitations(source, 'src/feature.spec.ts');
	assert.equal(tests.length, 2);
	assert.deepEqual(tests[0].acIds, ['AC-01']);
	assert.equal(tests[0].title, 'runs concurrently @ac AC-01');
	assert.equal(tests[0].hasAssertion, true);
	assert.deepEqual(tests[1].acIds, ['AC-02']);
	assert.equal(tests[1].title, 'adds %i + %i to equal %i @ac AC-02');
	assert.equal(tests[1].hasAssertion, true);
});

test('parseTestCitations recognizes it.each with destructured arrow parameters as having assertions', () => {
	const source = `
describe('feature', () => {
  it.each([
    { label: 'empty', samples: [] },
    { label: 'null', samples: null },
  ])('@ac AC-02 returns zero durations for $label samples', ({ samples }) => {
    expect(samples).toBeDefined();
  });
});
`;
	const tests = parseTestCitations(source, 'src/feature.spec.ts');
	assert.equal(tests.length, 1);
	assert.deepEqual(tests[0].acIds, ['AC-02']);
	assert.equal(tests[0].hasAssertion, true);
});
