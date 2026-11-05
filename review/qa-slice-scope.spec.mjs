import assert from 'node:assert/strict';
import test from 'node:test';
import { qaReviewScope } from './qa-slice-scope.ts';

const obligation = (criterionId, caseId, outcome) => ({
	criterionId, caseId, observableOutcome: outcome, setupAction: 'press Enter', expectedResult: 'picker opens',
});

test('@ac AC-04 @case AC-04.1 slice QA review is limited to the slice obligations', () => {
	const scope = qaReviewScope('WHOLE GOAL TEXT', 'slice', [
		obligation('AC-02', 'AC-02.1', 'focus returns'), obligation('AC-02', 'AC-02.2', 'space opens'),
	]);
	assert.ok(!scope.specSummary.includes('WHOLE GOAL TEXT'));
	assert.match(scope.specSummary, /ONLY the obligations/);
	assert.match(scope.specSummary, /AC-02\.1: focus returns/);
	assert.match(scope.specSummary, /not a finding/);
	assert.deepEqual(scope.acceptanceCriteria, ['AC-02']);
});

test('@ac AC-04 @case AC-04.2 final QA review keeps the whole goal', () => {
	const scope = qaReviewScope('WHOLE GOAL TEXT', 'final', [obligation('AC-01', null, 'x'), obligation('AC-02', null, 'y')]);
	assert.equal(scope.specSummary, 'WHOLE GOAL TEXT');
	assert.deepEqual(scope.acceptanceCriteria, ['AC-01', 'AC-02']);
});
