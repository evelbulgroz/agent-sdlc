import assert from 'node:assert/strict';
import test from 'node:test';
import {
	approvedAcCases,
	approvedAcIds,
	parseTestCitations,
} from './ac-citations.ts';
import {
	bindAcCoverageToExecution,
	evaluateAcCoverage,
} from './ac-coverage.ts';
import {
	formatAcCoverageFailure,
} from './ac-author-feedback.ts';

const AC01 =
	'AC-01: An exact spec is approved. Given a complete grammatical draft and operator approval. Then approvedSpecHash equals the draft hash.';
const AC02 =
	'AC-02: Second criterion is stored. Given a newline-separated answer. Then both ids are unique.';
const AC03 =
	'AC-03: Third criterion stays uncovered. Given no citing test. Then ac-coverage reports AC-03.';
const AC_WITH_CASES =
	'AC-04: Every branch is observed. Given either username or password is empty. Then submission is disabled. Cases: AC-04.1: username empty with password present; AC-04.2: password empty with username present.';

test('@ac AC-02 parses and enforces distinct parent-bound asserting oracle cases', () => {
	assert.deepEqual(approvedAcCases([AC_WITH_CASES]), [
		{ id: 'AC-04.1', description: 'username empty with password present' },
		{ id: 'AC-04.2', description: 'password empty with username present' },
	]);
	const result = evaluateAcCoverage({
		acceptanceCriteria: [AC_WITH_CASES],
		touchedFiles: [
			{
				path: 'src/feature.spec.ts',
				content: [
					`it('first @ac AC-04 @case AC-04.1', () => { expect(true).toBe(true); });`,
					`it('bundled @ac AC-04 @case AC-04.1 @case AC-04.2', () => { expect(true).toBe(true); });`,
					`it('parentless @case AC-04.2', () => { expect(true).toBe(true); });`,
					`it('assertion-free @ac AC-04 @case AC-04.2', () => { const value = true; });`,
					`it('unknown @ac AC-04 @case AC-04.9', () => { expect(true).toBe(true); });`,
				].join('\n'),
			},
		],
	});
	assert.equal(result.pass, false);
	assert.deepEqual(result.uncoveredCaseIds, ['AC-04.2']);
	assert.equal(result.multipleCaseCitations.length, 1);
	assert.equal(result.caseWithoutParent[0].caseId, 'AC-04.2');
	assert.equal(result.caseWithoutAssertion[0].caseId, 'AC-04.2');
	assert.equal(result.unknownCaseCitations[0].caseId, 'AC-04.9');
	const failure = formatAcCoverageFailure(result);
	assert.doesNotMatch(failure, /has no cases/);
	assert.match(failure, /\[uncovered-case\] AC-04\.2/);
	assert.match(failure, /\[case-repair\].*literal text/);
	assert.match(failure, /\[assertion-repair\].*direct expect\(/);
	assert.match(
		failure,
		/\[case-without-parent\].*test title requires both @ac AC-04 and @case AC-04\.2/,
	);
	assert.match(failure, /or @ac AC-04 on an enclosing describe block/);
	assert.match(
		failure,
		/\[case-without-parent-repair\].*read_file.*replace_in_file.*exact literal old_string.*new_string.*expected_file_hash/,
	);
});

test('a superfluous @case on a case-free parent is ignored when @ac is cited', () => {
	const parentOnly =
		'AC-06: Overview keeps the summary. Given a ready snapshot. Then the overview omits series.';
	const result = evaluateAcCoverage({
		acceptanceCriteria: [parentOnly],
		touchedFiles: [{
			path: 'src/dto.spec.ts',
			content: "it('@ac AC-06 @case AC-06.1 overview', () => { expect(true).toBe(true); });\n",
		}],
	});
	assert.equal(result.pass, true);
	assert.deepEqual(result.caseFreeAcIds, ['AC-06']);
	assert.deepEqual(result.uncoveredAcIds, []);
	assert.deepEqual(result.unknownCaseCitations, []);
});

test('evaluateAcCoverage fails closed on uncovered, unknown, and cite-without-assertion', () => {
	const citing = `
it('covers first @ac AC-01', () => { expect(1).toBe(1); });
it('claims missing id @ac AC-99', () => { expect(1).toBe(1); });
it('cites without assert @ac AC-02', () => { const x = 1; });
it('uncited extra case', () => { expect(2).toBe(2); });
`;
	const result = evaluateAcCoverage({
		acceptanceCriteria: [AC01, AC02, AC03],
		touchedFiles: [{ path: 'src/feature.spec.ts', content: citing }],
	});
	assert.equal(result.pass, false);
	assert.deepEqual(result.uncoveredAcIds, ['AC-03']);
	assert.equal(result.unknownCitations[0].id, 'AC-99');
	assert.equal(result.citeWithoutAssertion[0].id, 'AC-02');
	assert.equal(result.uncitedTouchedTests.length, 1);
	assert.match(formatAcCoverageFailure(result), /\[unknown\].*AC-99/);
	assert.match(formatAcCoverageFailure(result), /\[cite-without-assertion\].*AC-02/);
	assert.match(formatAcCoverageFailure(result), /\[assertion-repair\].*direct expect\(/);
	assert.match(
		formatAcCoverageFailure(result),
		/\[uncited-existing\] src\/feature\.spec\.ts 1 existing tests have no @ac citation/,
	);
	assert.match(formatAcCoverageFailure(result), /do not block completion/);
});

test('evaluateAcCoverage treats uncited empty-assert files as advisory and passes when ACs are cited', () => {
	const result = evaluateAcCoverage({
		acceptanceCriteria: [AC01],
		touchedFiles: [
			{
				path: 'src/feature.spec.ts',
				content: `it('covers @ac AC-01', () => { expect(true).toBe(true); });`,
			},
			{
				path: 'src/noise.spec.ts',
				content: `it('does nothing useful', () => { const x = 1; });`,
			},
		],
	});
	assert.equal(result.pass, true);
	assert.deepEqual(result.emptyAssertFiles, ['src/noise.spec.ts']);
	assert.equal(result.uncitedTouchedTests.length, 1);
});

test('stale untouched oracles are advisory and do not fail the run', () => {
	const result = evaluateAcCoverage({
		acceptanceCriteria: [AC01],
		touchedFiles: [
			{
				path: 'src/feature.spec.ts',
				content: `it('covers @ac AC-01', () => { expect(true).toBe(true); });`,
			},
		],
		untouchedOracleFiles: [
			{
				path: 'src/legacy.oracle.spec.ts',
				content: `it('old promise @ac AC-99 @oracle', () => { expect(1).toBe(1); });`,
			},
		],
	});
	assert.equal(result.pass, true);
	assert.equal(result.staleOracleCitations[0].id, 'AC-99');
});

test('evaluateAcCoverage fails closed on empty criteria', () => {
	const result = evaluateAcCoverage({
		acceptanceCriteria: [],
		touchedFiles: [],
	});
	assert.equal(result.pass, false);
	assert.equal(result.errors[0].code, 'EMPTY');
});

test('@ac AC-01 AC-03 binds citations only to JSON-reported passing tests', () => {
	const coverage = evaluateAcCoverage({
		acceptanceCriteria: [AC01, AC02],
		touchedFiles: [
			{
				path: 'src/feature.spec.ts',
				content: [
					`it('first behavior @ac AC-01', () => { expect(true).toBe(true); });`,
					`it('second behavior @ac AC-02', () => { expect(true).toBe(true); });`,
				].join('\n'),
			},
		],
	});

	const result = bindAcCoverageToExecution(
		coverage,
		[
			'package prelude',
			JSON.stringify({
				testResults: [
					{
						assertionResults: [
							{
								title: 'first behavior @ac AC-01',
								fullName: 'feature first behavior @ac AC-01',
								status: 'passed',
							},
							{
								title: 'second behavior @ac AC-02',
								fullName: 'feature second behavior @ac AC-02',
								status: 'failed',
							},
						],
					},
				],
			}),
		].join('\n'),
	);
	assert.equal(result.pass, false);
	assert.deepEqual(result.notExecutedAcIds, ['AC-02']);
	assert.match(formatAcCoverageFailure(result), /\[not-executed\] AC-02/);
});

test('@ac AC-03 AC-05 binds every frozen oracle case to a distinct passing test', () => {
	const coverage = evaluateAcCoverage({
		acceptanceCriteria: [AC_WITH_CASES],
		touchedFiles: [
			{
				path: 'src/feature.spec.ts',
				content: [
					`it('username branch @ac AC-04 @case AC-04.1', () => { expect(true).toBe(true); });`,
					`it('password branch @ac AC-04 @case AC-04.2', () => { expect(true).toBe(true); });`,
				].join('\n'),
			},
		],
	});
	const result = bindAcCoverageToExecution(
		coverage,
		JSON.stringify({
			testResults: [
				{
					assertionResults: [
						{
							title: 'username branch @ac AC-04 @case AC-04.1',
							status: 'passed',
						},
						{
							title: 'password branch @ac AC-04 @case AC-04.2',
							status: 'failed',
						},
					],
				},
			],
		}),
	);
	assert.equal(result.pass, false);
	assert.deepEqual(result.notExecutedCaseIds, ['AC-04.2']);
	assert.match(formatAcCoverageFailure(result), /\[not-executed-case\] AC-04\.2/);
});

test('@ac AC-04 preserves execution coverage for criteria without oracle cases', () => {
	const coverage = evaluateAcCoverage({
		acceptanceCriteria: [AC01],
		touchedFiles: [
			{
				path: 'src/feature.spec.ts',
				content: `it('existing @ac AC-01', () => { expect(true).toBe(true); });`,
			},
		],
	});
	const result = bindAcCoverageToExecution(
		coverage,
		JSON.stringify({
			testResults: [
				{
					assertionResults: [
						{ title: 'existing @ac AC-01', status: 'passed' },
					],
				},
			],
		}),
	);
	assert.equal(result.pass, true);
	assert.deepEqual(result.approvedCaseIds, []);
	assert.deepEqual(result.notExecutedCaseIds, []);
});

test('evaluateAcCoverage accepts knownAcceptanceCriteria and does not flag other spec criteria as unknown citations while requiring assigned criteria to be covered', () => {
	const specCriteria = [
		'AC-01: Calculate Power Zones. Given FTP. Then Coggan thresholds are returned.',
		'AC-02: Calculate Normalized Power. Given samples. Then NP is returned.',
		'AC-03: Derive Power Zone Distribution. Given samples and FTP. Then time in each zone is returned.',
	];
	const taskCriteria = [
		'AC-03: Derive Power Zone Distribution. Given samples and FTP. Then time in each zone is returned.',
	];
	// A touched test file from a previous task has AC-01, while the current task has AC-03
	const result = evaluateAcCoverage({
		acceptanceCriteria: taskCriteria,
		knownAcceptanceCriteria: specCriteria,
		touchedFiles: [
			{
				path: 'src/existing-helper.spec.ts',
				content: `it('calculates Coggan zones @ac AC-01', () => { expect(true).toBe(true); });`,
			},
			{
				path: 'src/new-distribution.spec.ts',
				content: `it('derives distribution @ac AC-03', () => { expect(true).toBe(true); });`,
			},
		],
	});
	assert.equal(result.pass, true);
	assert.deepEqual(result.unknownCitations, []);
	assert.deepEqual(result.uncoveredAcIds, []);
	assert.deepEqual(result.approvedAcIds, ['AC-03']);

	// If the current task does NOT cover AC-03, it still fails closed
	const failingResult = evaluateAcCoverage({
		acceptanceCriteria: taskCriteria,
		knownAcceptanceCriteria: specCriteria,
		touchedFiles: [
			{
				path: 'src/existing-helper.spec.ts',
				content: `it('calculates Coggan zones @ac AC-01', () => { expect(true).toBe(true); });`,
			},
		],
	});
	assert.equal(failingResult.pass, false);
	assert.deepEqual(failingResult.uncoveredAcIds, ['AC-03']);
	assert.deepEqual(failingResult.unknownCitations, []);

	// An AC not in knownAcceptanceCriteria is still flagged as unknown citation
	const unknownResult = evaluateAcCoverage({
		acceptanceCriteria: taskCriteria,
		knownAcceptanceCriteria: specCriteria,
		touchedFiles: [
			{
				path: 'src/new-distribution.spec.ts',
				content: `it('hallucinated criterion @ac AC-99', () => { expect(true).toBe(true); });`,
			},
		],
	});
	assert.equal(unknownResult.pass, false);
	assert.equal(unknownResult.unknownCitations.length, 1);
	assert.equal(unknownResult.unknownCitations[0].id, 'AC-99');
});

test('evaluateAcCoverage recognizes baseline citations from baselineTestCitations and does not flag them as unknown citations', () => {
	const taskCriteria = [
		'AC-01: User button readiness. Given credentials. Then button enabled.',
	];

	// An existing brownfield test file contains @ac AC-05 from an earlier landed commit
	const result = evaluateAcCoverage({
		acceptanceCriteria: taskCriteria,
		baselineTestCitations: ['AC-05'],
		touchedFiles: [
			{
				path: 'src/ui/SignInPage.spec.tsx',
				content: `
it('reports no axe violations @ac AC-05', () => { expect(true).toBe(true); });
it('enables button when credentials present @ac AC-01', () => { expect(true).toBe(true); });
`,
			},
		],
	});
	assert.equal(result.pass, true);
	assert.deepEqual(result.unknownCitations, []);
	assert.deepEqual(result.uncoveredAcIds, []);
	assert.deepEqual(result.approvedAcIds, ['AC-01']);

	// If the current task does NOT cover AC-01, it still fails closed
	const failingResult = evaluateAcCoverage({
		acceptanceCriteria: taskCriteria,
		baselineTestCitations: ['AC-05'],
		touchedFiles: [
			{
				path: 'src/ui/SignInPage.spec.tsx',
				content: `it('reports no axe violations @ac AC-05', () => { expect(true).toBe(true); });`,
			},
		],
	});
	assert.equal(failingResult.pass, false);
	assert.deepEqual(failingResult.uncoveredAcIds, ['AC-01']);
	assert.deepEqual(failingResult.unknownCitations, []);

	// A brand new hallucinated criterion (not in criteria and not in baseline) is still flagged
	const unknownResult = evaluateAcCoverage({
		acceptanceCriteria: taskCriteria,
		baselineTestCitations: ['AC-05'],
		touchedFiles: [
			{
				path: 'src/ui/SignInPage.spec.tsx',
				content: `
it('reports no axe violations @ac AC-05', () => { expect(true).toBe(true); });
it('enables button when credentials present @ac AC-01', () => { expect(true).toBe(true); });
it('hallucinated criterion @ac AC-99', () => { expect(true).toBe(true); });
`,
			},
		],
	});
	assert.equal(unknownResult.pass, false);
	assert.equal(unknownResult.unknownCitations.length, 1);
	assert.equal(unknownResult.unknownCitations[0].id, 'AC-99');
});

test('evaluateAcCoverage does not count a citation that already existed in the base test file', () => {
	const content = "it('@ac AC-01 older feature', () => { expect(1).toBe(1); });";
	const touchedFiles = [{ path: 'a.spec.ts', content }];
	const [existing] = parseTestCitations(content, 'a.spec.ts');
	const withBaseline = evaluateAcCoverage({
		acceptanceCriteria: [AC01],
		baselineTestCitations: [existing],
		touchedFiles,
	});
	assert.deepEqual([...withBaseline.uncoveredAcIds], ['AC-01']);
	const withoutBaseline = evaluateAcCoverage({ acceptanceCriteria: [AC01], touchedFiles });
	assert.deepEqual([...withoutBaseline.uncoveredAcIds], []);
});

test('@ac AC-05 @case AC-05.1 propagates describe-level @ac AC-04 to child @case tests', () => {
	const content = [
		"describe('@ac AC-04 weather validation', () => {",
		"  it('@case AC-04.1 accepts valid range', () => { expect(1).toBe(1); });",
		"  it('@case AC-04.2 rejects invalid range', () => { expect(2).toBe(2); });",
		'});',
	].join('\n');
	const result = evaluateAcCoverage({
		acceptanceCriteria: [AC_WITH_CASES],
		touchedFiles: [{ path: 'src/weather.spec.ts', content }],
	});
	assert.equal(result.pass, true);
	assert.deepEqual(result.uncoveredAcIds, []);
	assert.deepEqual(result.uncoveredCaseIds, []);
	assert.deepEqual(result.caseWithoutParent, []);
});

test('@ac AC-05 @case AC-05.2 expands it.each case table rows and binds only passing interpolated titles', () => {
	const ac08 =
		'AC-08: Rejects invalid weather fields. Given a weather payload. Then out-of-range values fail. Cases: AC-08.1: temperature > 60; AC-08.2: humidity < 0; AC-08.3: windSpeed < 0.';
	const content = [
		'describe("weather validation", () => {',
		"  it.each([",
		"    { caseId: 'AC-08.1', field: 'temperature', val: 61 },",
		"    { caseId: 'AC-08.2', field: 'humidity', val: -1 },",
		"    { caseId: 'AC-08.3', field: 'windSpeed', val: -5 },",
		"  ])('@ac AC-08 @case $caseId rejects $field', ({ val }) => {",
		'    expect(val).toBeDefined();',
		'  });',
		'});',
	].join('\n');
	const base = evaluateAcCoverage({
		acceptanceCriteria: [ac08],
		touchedFiles: [{ path: 'src/weather.spec.ts', content }],
	});
	assert.equal(base.pass, true);

	const allPassed = bindAcCoverageToExecution(base, {
		format: 'json',
		passedTitles: [
			'@ac AC-08 @case AC-08.1 rejects temperature',
			'@ac AC-08 @case AC-08.2 rejects humidity',
			'@ac AC-08 @case AC-08.3 rejects windSpeed',
		],
		errors: [],
	});
	assert.equal(allPassed.pass, true);
	assert.deepEqual(allPassed.notExecutedCaseIds, []);

	const partialPassed = bindAcCoverageToExecution(base, {
		format: 'json',
		passedTitles: [
			'@ac AC-08 @case AC-08.1 rejects temperature',
			'@ac AC-08 @case AC-08.2 rejects humidity',
		],
		errors: [],
	});
	assert.equal(partialPassed.pass, false);
	assert.deepEqual(partialPassed.notExecutedCaseIds, ['AC-08.3']);
});

test('@ac AC-05 @case AC-05.3 ignores superfluous @case tags on case-free parent ACs', () => {
	const ac07 = 'AC-07: Preserves existing logs without weather. Given a legacy log. Then weather is omitted.';
	const content = [
		"describe('@ac AC-07 legacy logs', () => {",
		"  it('@case AC-07.1 loads without weather', () => { expect(true).toBe(true); });",
		'});',
	].join('\n');
	const result = evaluateAcCoverage({
		acceptanceCriteria: [ac07],
		touchedFiles: [{ path: 'src/legacy.spec.ts', content }],
	});
	assert.equal(result.pass, true);
	assert.deepEqual(result.uncoveredAcIds, []);
	assert.deepEqual(result.unknownCaseCitations, []);
});
