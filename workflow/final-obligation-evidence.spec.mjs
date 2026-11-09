import assert from 'node:assert/strict';
import test from 'node:test';
import { checkFinalObligationEvidence } from './final-obligation-evidence.ts';

const AC01 = 'AC-01: Thing works. Given input. Then output.';
const AC02 =
	'AC-02: Branches observed. Given input. Then output. Cases: AC-02.1: first; AC-02.2: second.';
const ob = (obligationId, criterionId, caseId = null) => ({ obligationId, criterionId, caseId });
const passed = (...ids) => ({ status: 'passed', dischargedObligationIds: ids });
const codes = (result) => result.map((failure) => failure.code);

test('@ac AC-04 a fully discharged criterion and case set passes', () => {
	const result = checkFinalObligationEvidence({
		acceptanceCriteria: [AC01, AC02],
		obligations: [ob('o1', 'AC-01'), ob('o2', 'AC-02', 'AC-02.1'), ob('o3', 'AC-02', 'AC-02.2')],
		receipts: [passed('o1', 'o2'), passed('o3')],
	});
	assert.deepEqual(result, []);
});

test('@ac AC-04 reports NO_OBLIGATION, OBLIGATION_NOT_DISCHARGED and NO_EXECUTION_EVIDENCE distinctly', () => {
	const obligations = [ob('o1', 'AC-01'), ob('o2', 'AC-02', 'AC-02.1')];
	assert.deepEqual(
		codes(checkFinalObligationEvidence({ acceptanceCriteria: [AC01, AC02], obligations, receipts: [passed('o1')] })),
		['OBLIGATION_NOT_DISCHARGED', 'NO_OBLIGATION'],
	);
	assert.deepEqual(
		codes(checkFinalObligationEvidence({ acceptanceCriteria: [AC01], obligations, receipts: [{ status: 'failed', dischargedObligationIds: [] }, null] })),
		['NO_EXECUTION_EVIDENCE'],
	);
});

test('@ac AC-04 a discharged obligation of another criterion does not discharge this one', () => {
	const result = checkFinalObligationEvidence({
		acceptanceCriteria: [AC01],
		obligations: [ob('o1', 'AC-01'), ob('o9', 'AC-09')],
		receipts: [passed('o9')],
	});
	assert.deepEqual(codes(result), ['OBLIGATION_NOT_DISCHARGED']);
});
