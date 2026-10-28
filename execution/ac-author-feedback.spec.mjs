import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAcCoverage } from './ac-coverage.ts';
import {
	citationRule,
	formatAcCoverageFailure,
	verificationBlock,
} from './ac-author-feedback.ts';

const AC_WITH_CASES =
	'AC-04: Every branch is observed. Given either username or password is empty. Then submission is disabled. Cases: AC-04.1: username empty with password present; AC-04.2: password empty with username present.';

test('formatAcCoverageFailure cites a template case title and does not accept it', () => {
	const file = 'src/domain/session-heart-rate-summary.spec.ts';
	const result = evaluateAcCoverage({
		acceptanceCriteria: [AC_WITH_CASES],
		touchedFiles: [
			{
				path: file,
				content:
					'it(`@ac AC-04 @case AC-04.${n} example`, () => { expect(true).toBe(true); });\n',
			},
		],
	});
	assert.equal(result.pass, false);
	assert.ok(result.uncoveredCaseIds.includes('AC-04.1'));
	assert.ok(result.uncoveredCaseIds.includes('AC-04.2'));
	assert.match(
		formatAcCoverageFailure(result),
		/\[template-case\] src\/domain\/session-heart-rate-summary\.spec\.ts:1/,
	);
});

test('formatAcCoverageFailure cites a touched spec when cases are uncovered and no template is present', () => {
	const file = 'src/ui/SessionDetailPage.spec.tsx';
	const result = evaluateAcCoverage({
		acceptanceCriteria: [AC_WITH_CASES],
		touchedFiles: [{
			path: file,
			content: "it('@ac AC-04 shows the strip', () => { expect(true).toBe(true); });\n",
		}],
	});
	assert.equal(result.pass, false);
	assert.ok(result.uncoveredCaseIds.includes('AC-04.1'));
	const summary = formatAcCoverageFailure(result);
	assert.match(summary, /\[coverage-file\] src\/ui\/SessionDetailPage\.spec\.tsx/);
	assert.doesNotMatch(summary, /\[template-case\]/);
});

test('citationRule names listed cases and forbids invented cases on a parent', () => {
	const parentOnly =
		'AC-06: Overview keeps the summary. Given a ready snapshot. Then the overview omits series.';
	const rule = citationRule([AC_WITH_CASES, parentOnly]);
	assert.match(rule, /it\('@ac AC-04 @case AC-04\.1 \.\.\.'\)/);
	assert.match(rule, /The case ids are AC-04\.1, AC-04\.2/);
	assert.match(rule, /it\('@ac AC-06 \.\.\.'\)/);
	assert.match(rule, /AC-06 has no cases\. Do not add @case/);
	assert.match(rule, /\$\{caseId\} does not count/);
	assert.equal(rule.includes('AC-01.1'), false);
	assert.equal(citationRule([]), '');
	assert.equal(citationRule(undefined), '');
	assert.equal(citationRule(['not a criterion']).includes('AC-01.1'), false);
});

test('verificationBlock keeps a missing-file failure until that path is written', () => {
	const pathName = 'src/conditioning-log-weather.dto.spec.ts';
	const feedback =
		`ac-coverage failed\n[execution-evidence] Touched test file is missing from the worktree: '${pathName}'`;
	const original = `### Verification\n${feedback}`;
	assert.equal(verificationBlock(feedback, []), original);
	assert.equal(verificationBlock(feedback, null), original);
	assert.equal(verificationBlock('missing case ids', []), '### Verification\nmissing case ids');
	assert.equal(verificationBlock(undefined, []), '### Verification\nundefined');
	const read = {
		toolName: 'read_file',
		parameters: { path: pathName },
		result: { content: 'present', totalLines: 41, truncated: false },
	};
	assert.equal(verificationBlock(feedback, [read]), original);
	const otherWrite = {
		toolName: 'write_file',
		parameters: { path: 'src/other.spec.ts' },
		result: { written: true },
	};
	assert.equal(verificationBlock(feedback, [otherWrite]), original);
	const failedWrite = {
		toolName: 'write_file',
		parameters: { path: pathName },
		result: { written: true, error: 'parse failed', code: 'INVALID_INPUT' },
	};
	assert.equal(verificationBlock(feedback, [failedWrite]), original);
	const write = {
		toolName: 'write_file',
		parameters: { path: pathName },
		result: { written: true, byteLength: 20, hash: 'abc' },
	};
	const cleared = verificationBlock(feedback, [read, write]);
	assert.match(cleared, new RegExp(`Previous check said '${pathName}' was missing`));
	assert.match(cleared, /Declare complete so the check can run again/);
	assert.equal(cleared.includes('missing from the worktree'), false);
});
