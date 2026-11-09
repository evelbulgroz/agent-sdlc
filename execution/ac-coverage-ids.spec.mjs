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
