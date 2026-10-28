import assert from 'node:assert/strict';
import test from 'node:test';
import {
	parseTestExecutionEvidence,
} from './test-execution-evidence.ts';

test('@ac AC-03 parses passing node test TAP titles', () => {
	const evidence = parseTestExecutionEvidence([
		'TAP version 13',
		'# Subtest: behavior is observable @ac AC-01',
		'ok 1 - behavior is observable @ac AC-01',
		'1..1',
	].join('\n'));
	assert.equal(evidence.format, 'tap');
	assert.deepEqual(evidence.passedTitles, ['behavior is observable @ac AC-01']);
});

test('@ac AC-04 malformed and empty execution evidence fail closed', () => {
	for (const output of ['', 'RUN 3 tests\\nall green']) {
		const evidence = parseTestExecutionEvidence(output);
		assert.equal(evidence.format, null);
		assert.deepEqual(evidence.passedTitles, []);
		assert.equal(evidence.errors.length, 1);
	}
});

test('@ac AC-09 parseTestExecutionEvidence locates and parses a pretty-printed multi-line JSON test report', () => {
	const prettyJson = JSON.stringify(
		{
			testResults: [
				{
					assertionResults: [
						{ title: 'behavior is observable @ac AC-01', status: 'passed' },
						{ title: 'ignored failure', status: 'failed' },
					],
				},
			],
		},
		null,
		2,
	);
	const output = ['> package@1.0.0 test', '> node --test', '', prettyJson].join('\n');
	const evidence = parseTestExecutionEvidence(output);
	assert.equal(evidence.format, 'json');
	assert.deepEqual(evidence.passedTitles, ['behavior is observable @ac AC-01']);
});

test('@case AC-09 pretty-printed JSON preceded and followed by non-JSON command output still parses', () => {
	const prettyJson = JSON.stringify(
		{
			testResults: [
				{
					assertionResults: [{ title: 'covers edge case', status: 'passed' }],
				},
			],
		},
		null,
		2,
	);
	const output = [
		'$ pnpm test',
		prettyJson,
		'',
		'Done in 1.2s.',
	].join('\n');
	const evidence = parseTestExecutionEvidence(output);
	assert.equal(evidence.format, 'json');
	assert.deepEqual(evidence.passedTitles, ['covers edge case']);
});
