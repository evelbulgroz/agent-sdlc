import assert from 'node:assert/strict';
import test from 'node:test';
import { promptPacketText, qaReviewScope } from './qa-slice-scope.ts';

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
	assert.match(scope.specSummary, /^WHOLE GOAL TEXT\n/);
	assert.match(scope.specSummary, /AC-01: x \(setup: press Enter; expected: picker opens\)/);
	assert.match(scope.specSummary, /AC-02: y \(setup: press Enter; expected: picker opens\)/);
	assert.deepEqual(scope.acceptanceCriteria, ['AC-01', 'AC-02']);
});

test('slice prompt packet omits obligation text already present in the scope summary', () => {
	const packet = JSON.stringify({
		sources: { 'a.spec.ts': 'it("@case AC-02.1"' },
		checkpointEvidence: [{
			obligationId: 'obligation-picker',
			criterionId: 'AC-02',
			caseId: 'AC-02.1',
			observableOutcome: 'focus returns',
			setupAction: 'press Enter',
			expectedResult: 'picker opens',
			layer: 'browser',
			requiredCapabilities: ['native-browser', 'native-file-picker'],
			executedCases: [{ file: 'src/picker.spec.ts', caseKey: 'opens' }],
		}],
		receipts: [{
			receiptHash: 'a'.repeat(64),
			dischargedObligationIds: ['obligation-picker'],
			cases: [{
				file: 'src/picker.spec.ts',
				caseKey: 'opens',
				obligationIds: ['obligation-picker'],
				outcome: 'passed',
				exercisedCapabilities: ['native-browser', 'native-file-picker'],
				attempts: [{ index: 0, outcome: 'passed', durationMs: 30 }],
			}],
		}],
	});
	const text = promptPacketText(packet, 'slice');
	const parsed = JSON.parse(text);
	assert.equal(text.includes('focus returns'), false);
	assert.equal(text.includes('press Enter'), false);
	assert.equal(text.includes('picker opens'), false);
	assert.equal(parsed.checkpointEvidence[0].layer, 'browser');
	assert.deepEqual(parsed.checkpointEvidence[0].requiredCapabilities, ['native-browser', 'native-file-picker']);
	assert.deepEqual(parsed.checkpointEvidence[0].executedCases, [{ file: 'src/picker.spec.ts', caseKey: 'opens' }]);
	assert.equal(parsed.sources['a.spec.ts'].includes('@case AC-02.1'), true);
	assert.equal(parsed.receipts[0].cases[0].outcome, 'passed');
	assert.equal(parsed.receipts[0].cases[0].attempts[0].durationMs, 30);
	const finalText = promptPacketText(packet, 'final');
	const finalPacket = JSON.parse(finalText);
	assert.equal(finalText.includes('picker opens'), false);
	assert.equal(finalPacket.checkpointEvidence[0].obligationId, 'obligation-picker');
	assert.deepEqual(finalPacket.checkpointEvidence[0].requiredCapabilities, ['native-browser', 'native-file-picker']);
	assert.deepEqual(finalPacket.checkpointEvidence[0].executedCases, [{ file: 'src/picker.spec.ts', caseKey: 'opens' }]);
	assert.deepEqual(finalPacket.receipts[0].dischargedObligationIds, ['obligation-picker']);
	assert.equal(finalPacket.receipts[0].cases[0].outcome, 'passed');
	assert.deepEqual(finalPacket.receipts[0].cases[0].exercisedCapabilities, ['native-browser', 'native-file-picker']);
	assert.equal(Object.hasOwn(finalPacket.receipts[0].cases[0], 'attempts'), false);
	assert.equal(finalPacket.sources['a.spec.ts'].includes('@case AC-02.1'), true);
	assert.equal(promptPacketText('not-json', 'slice'), 'not-json');
	assert.equal(promptPacketText('not-json', 'final'), 'not-json');
	assert.equal(promptPacketText('', 'final'), '');
});
