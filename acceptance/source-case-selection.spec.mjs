import assert from 'node:assert/strict';
import test from 'node:test';
import { casesFromReport } from './command-evidence.ts';
import { parseJunit } from './report-formats.ts';
import { structuralIdentityFailure } from './source-case-selection.ts';

const registration = { reportFormat: 'junit', retries: 0, caseIdentity: 'case-file-criterion' };
const source = (file = 'pkg/src/bundle-time.spec.mjs', criterionId = 'AC-03', caseId = 'AC-03.1') =>
	({ file, criterionId, caseId });
const leaf = (identity, outcome = 'passed', title = 'emits one performed letter row as straight') =>
	`<testcase file="${identity.file}" name="@ac ${identity.criterionId} @case ${identity.caseId} ${title}">${
		outcome === 'passed' ? '' : outcome === 'skipped' ? '<skipped/>' : `<${outcome}/>`
	}</testcase>`;
function select(body, identities = [source()], code = 0, overrides = {}) {
	return casesFromReport({
		registration, selected: [...new Set(identities.map((item) => item.caseId))], code,
		reportBytes: Buffer.from(`<testsuite>${body}</testsuite>`),
		request: { obligations: identities.map((item) => ({
			caseId: item.caseId, criterionId: item.criterionId, testCases: [{ file: item.file, caseKey: 'leaf' }],
		})) },
		...overrides,
	});
}
const throwsCode = (fn, code) => assert.throws(fn, (error) => error.code === code);

test('source selection distinguishes both live historic case collisions at zero retries', () => {
	for (const [oldFile, newFile, criterionId, caseId, title] of [
		['parse-grid.spec.mjs', 'bundle-time.spec.mjs', 'AC-03', 'AC-03.1', 'emits one performed letter row as straight'],
		['precedence.spec.mjs', 'bundle-preparation.spec.mjs', 'AC-06', 'AC-06.1', 'derived rows fill one date with straight blocks'],
	]) {
		const expected = source(`pkg/src/${newFile}`, criterionId, caseId);
		const old = source(`pkg/src/${oldFile}`, criterionId, caseId);
		const body = leaf(old, 'passed', title) + leaf(expected, 'passed', title);
		const [result] = select(body, [expected]);
		assert.equal(result.outcome, 'passed');
		assert.equal(result.attempts, 1);
		assert.deepEqual(result.source, expected);
		assert.deepEqual(select(body, [old, expected]).map((item) => item.source), [old, expected]);
		assert.throws(() => select(body, [expected], 0, {
			registration: { reportFormat: 'junit', retries: 0 },
		}), /REPORT_DUPLICATE_IDENTITY/);
	}
});

test('source selection rejects wrong-file, wrong-criterion, missing-file and ambiguous tags', () => {
	for (const body of [
		leaf(source('pkg/src/parse-grid.spec.mjs')),
		leaf(source(undefined, 'AC-04')),
		'<testcase classname="test" name="@ac AC-03 @case AC-03.1"/>',
		leaf(source('/pkg/src/bundle-time.spec.mjs')),
		leaf(source(), 'passed', '@ac AC-04'),
		leaf(source(), 'passed', '@case AC-03.2'),
	]) throwsCode(() => select(body), 'REPORT_SOURCE_MISMATCH');
	assert.throws(() => select(leaf(source()), [source()], 0, { request: undefined }), /invalid-evidence/);
	assert.throws(() => select(leaf(source()), [source()], 0, {
		request: { obligations: [{ caseId: null, criterionId: 'AC-03', testCases: [] }] },
	}), /invalid-evidence/);
});

test('source selection preserves missing, skipped, failed and error outcomes', () => {
	const [absent] = select(leaf(source(undefined, 'AC-04', 'AC-04.1')));
	assert.equal(absent.outcome, 'not-run');
	assert.equal(absent.attempts, 0);
	for (const [reported, expected, code] of [['skipped', 'skipped', 0], ['failure', 'failed', 1], ['error', 'failed', 1]]) {
		assert.equal(select(leaf(source(), reported), [source()], code)[0].outcome, expected);
	}
	throwsCode(() => select(''), 'REPORT_ZERO_CASES');
	throwsCode(() => select(leaf(source()), []), 'REPORT_ZERO_CASES');
	assert.throws(() => select('', [source()], 0, { reportBytes: Buffer.alloc(0) }), /REPORT_MALFORMED/);
});

test('a contradictory exit does not make a duplicate or source mismatch retryable', () => {
	const duplicate = parseJunit(`<testsuite>${leaf(source())}${leaf(source())}</testsuite>`);
	assert.equal(structuralIdentityFailure(duplicate, [source()]), 'REPORT_DUPLICATE_IDENTITY');
	const mismatch = parseJunit(`<testsuite>${leaf(source('pkg/src/other.spec.mjs'), 'failure')}</testsuite>`);
	assert.equal(structuralIdentityFailure(mismatch, [source()]), 'REPORT_SOURCE_MISMATCH');
	assert.equal(structuralIdentityFailure(parseJunit(`<testsuite>${leaf(source())}</testsuite>`), [source()]), null);
});

test('full-report exit correspondence precedes source matching and duplicate collapse', () => {
	const body = leaf(source()) + leaf(source('pkg/src/parse-grid.spec.mjs'), 'failure');
	assert.equal(select(body, [source()], 1)[0].outcome, 'passed');
	throwsCode(() => select(body), 'REPORT_EXIT_CONTRADICTION');
	throwsCode(() => select(leaf(source()), [source()], 1), 'REPORT_EXIT_CONTRADICTION');
	throwsCode(() => select(leaf(source()) + leaf(source())), 'REPORT_DUPLICATE_IDENTITY');
	throwsCode(() => select(leaf(source()) + leaf(source()) + leaf(source('pkg/src/other.spec.mjs'), 'failure')),
		'REPORT_EXIT_CONTRADICTION');
	throwsCode(() => select(leaf(source('pkg/src/other.spec.mjs'), 'failure')), 'REPORT_EXIT_CONTRADICTION');
});
