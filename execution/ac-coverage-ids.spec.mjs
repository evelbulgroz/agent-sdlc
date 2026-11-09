import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTestCitations } from './ac-citations.ts';
import { bindAcCoverageToExecution, evaluateAcCoverage } from './ac-coverage.ts';

test('@ac AC-01 @case AC-01.1 exact case-id matching never lets AC-01.10 discharge AC-01.1', () => {
	const ac =
		'AC-01: Rows are rejected. Given invalid rows. Then each fails. Cases: AC-01.1: first row; AC-01.10: tenth row.';
	const content = [
		'it.each([',
		"  { caseId: 'AC-01.1' },",
		"  { caseId: 'AC-01.10' },",
		"])('@ac AC-01 @case $caseId rejects', () => { expect(1).toBe(1); });",
	].join('\n');
	const base = evaluateAcCoverage({
		acceptanceCriteria: [ac],
		touchedFiles: [{ path: 'a.spec.ts', content }],
	});
	const onlyTenth = bindAcCoverageToExecution(base, {
		format: 'json',
		passedTitles: ['@ac AC-01 @case AC-01.10 rejects'],
		errors: [],
	});
	assert.deepEqual([...onlyTenth.notExecutedCaseIds], ['AC-01.1']);
	const onlyFirst = bindAcCoverageToExecution(base, {
		format: 'json',
		passedTitles: ['@ac AC-01 @case AC-01.1 rejects'],
		errors: [],
	});
	assert.deepEqual([...onlyFirst.notExecutedCaseIds], ['AC-01.10']);
});

test('@ac AC-09 a baseline it.each citation at the base commit does not discharge a criterion', () => {
	const ac =
		'AC-01: Rows are rejected. Given invalid rows. Then each fails. Cases: AC-01.1: first row.';
	const content = [
		'it.each([',
		"  { caseId: 'AC-01.1' },",
		"])('@ac AC-01 @case $caseId rejects', () => { expect(1).toBe(1); });",
	].join('\n');
	const touchedFiles = [{ path: 'a.spec.ts', content }];
	const baselineTestCitations = parseTestCitations(content, 'a.spec.ts');
	assert.equal(baselineTestCitations.some((row) => row.eachCaseId === 'AC-01.1'), true);
	const withBaseline = evaluateAcCoverage({
		acceptanceCriteria: [ac],
		baselineTestCitations,
		touchedFiles,
	});
	assert.equal(withBaseline.pass, false);
	assert.equal(evaluateAcCoverage({ acceptanceCriteria: [ac], touchedFiles }).pass, true);
});

const FILE_AC = 'AC-01: Thing works. Given input. Then output. ';
const FILE_CONTENT = "it('@ac AC-01 works', () => { expect(1).toBe(1); });";
const jsonReport = (results) => ({
	format: 'json',
	passedTitles: results.filter((r) => r.status === 'passed').map((r) => r.title),
	passedTests: results.filter((r) => r.status === 'passed').map((r) => ({ file: r.file, title: r.title })),
	errors: [],
});

test('@ac AC-02 a passed title in a different file does not discharge the citation', () => {
	const base = evaluateAcCoverage({
		acceptanceCriteria: [FILE_AC],
		touchedFiles: [{ path: 'src/a.spec.ts', content: FILE_CONTENT }],
	});
	const other = bindAcCoverageToExecution(
		base,
		jsonReport([{ status: 'passed', title: '@ac AC-01 works', file: '/wt/src/b.spec.ts' }]),
	);
	assert.equal(other.pass, false);
	assert.deepEqual([...other.notExecutedAcIds], ['AC-01']);
	assert.equal(other.executionEvidenceMatching, 'file');
});

test('@ac AC-02 absolute reporter paths match worktree-relative citation paths', () => {
	const base = evaluateAcCoverage({
		acceptanceCriteria: [FILE_AC],
		touchedFiles: [{ path: 'src/a.spec.ts', content: FILE_CONTENT }],
	});
	const bound = bindAcCoverageToExecution(
		base,
		jsonReport([{ status: 'passed', title: '@ac AC-01 works', file: '/wt/pkg/src/a.spec.ts' }]),
	);
	assert.equal(bound.pass, true);
	const suffixCollision = bindAcCoverageToExecution(
		base,
		jsonReport([{ status: 'passed', title: '@ac AC-01 works', file: '/wt/pkg/xsrc/a.spec.ts' }]),
	);
	assert.equal(suffixCollision.pass, false);
});

test('@ac AC-02 TAP evidence stays title-only and the report records it', () => {
	const base = evaluateAcCoverage({
		acceptanceCriteria: [FILE_AC],
		touchedFiles: [{ path: 'src/a.spec.ts', content: FILE_CONTENT }],
	});
	const tap = [
		'TAP version 13',
		'# Subtest: @ac AC-01 works',
		'ok 1 - @ac AC-01 works',
	].join('\n');
	const bound = bindAcCoverageToExecution(base, tap);
	assert.equal(bound.pass, true);
	assert.equal(bound.executionEvidenceMatching, 'title');
});

test('@ac AC-05 a test whose only assertions are no-ops is reported as a warning and never fails coverage', () => {
	const bodies = {
		literal: 'expect(true).toBe(true);',
		existence: 'const value = make(); expect(value).toBeDefined();',
		assertLiteral: 'assert.ok(true);',
		mixed: 'expect(true).toBe(true); expect(make()).toEqual({ a: 1 });',
		real: 'expect(make(1)).toBe(2);',
	};
	const content = Object.entries(bodies)
		.map(([name, body]) => `it('@ac AC-01 ${name}', () => { ${body} });`)
		.join('\n');
	const report = evaluateAcCoverage({
		acceptanceCriteria: [FILE_AC],
		touchedFiles: [{ path: 'src/a.spec.ts', content }],
	});
	assert.equal(report.pass, true);
	assert.deepEqual(
		report.noopAssertionTests.map((test) => test.title),
		['@ac AC-01 literal', '@ac AC-01 existence', '@ac AC-01 assertLiteral'],
	);
});
