import assert from 'node:assert/strict';
import test from 'node:test';
import { H, T, initialize, makeFixture } from '../testing/quality-test-support.mjs';

test('task revision lifecycle preserves identity, keeps selections separate, and freezes completed contents', () => {
	const fixture = makeFixture('quality-lifecycle');
	try {
		initialize(fixture);
		const q = fixture.store.quality;
		const initial = {
			schemaVersion: '1.0.0', runId: fixture.runId, taskPlanHash: H, taskId: 'task-a',
			executionRevision: 0, correctionId: null, parentTreeSha: T, parentRevisionSetHash: H,
			status: 'materializing', targetTreeSha: null, patchHash: null, receiptHashes: [],
		};
		q.saveTaskRevision(initial);
		const executing = { ...initial, status: 'executing' };
		q.saveTaskRevision(executing);
		assert.deepEqual(q.getTaskRevision(fixture.runId, 'task-a', 0), executing);
		assert.equal(q.getCurrentTaskRevision(fixture.runId, 'task-a'), null);
		assert.throws(() => q.selectTaskRevision(fixture.runId, 'task-a', 0), /receipts/);
		for (const change of [{ parentTreeSha: 'c'.repeat(40) }, { parentRevisionSetHash: 'c'.repeat(64) },
			{ correctionId: 'foreign' }, { taskPlanHash: 'c'.repeat(64) }]) {
			assert.throws(() => q.saveTaskRevision({ ...executing, ...change }), /identity/);
		}
		assert.throws(() => q.saveTaskRevision(initial), /transition/);
		assert.throws(() => q.saveTaskRevision({ ...executing, patchHash: H }), /completion fields/);
		assert.throws(() => q.saveTaskRevision(null));
		assert.throws(() => q.saveTaskRevision({}));
		const artifactHash = fixture.artifacts.writeJson('verification', { command: ['pnpm', 'test'], exitCode: 0 });
		const hash = q.saveVerificationReceipt({ schemaVersion: '1.0.0', runId: fixture.runId,
			taskId: 'task-a', executionRevision: 0, treeSha: T, command: ['pnpm', 'test'],
			artifactHash, exitCode: 0, status: 'passed' });
		const completed = { ...initial, status: 'completed', targetTreeSha: T, patchHash: H, receiptHashes: [hash] };
		q.saveTaskRevision({ ...completed, status: 'verifying', receiptHashes: [] });
		assert.equal(q.getCurrentTaskRevision(fixture.runId, 'task-a'), null);
		assert.throws(() => q.saveTaskRevision({ ...completed, targetTreeSha: 'c'.repeat(40) }), /identity/);
		assert.throws(() => q.saveTaskRevision(executing), /identity|transition/);
		q.saveTaskRevision(completed);
		assert.equal(q.getCurrentTaskRevision(fixture.runId, 'task-a'), null);
		q.selectTaskRevision(fixture.runId, 'task-a', 0);
		assert.deepEqual(q.listRevisionSelections(fixture.runId), [
			{ taskId: 'task-a', executionRevision: 0, eligible: true },
		]);
		assert.deepEqual(q.getCurrentTaskRevision(fixture.runId, 'task-a'), completed);
		assert.deepEqual(q.saveTaskRevision(completed), completed);
		assert.throws(() => q.saveTaskRevision({ ...completed, patchHash: 'c'.repeat(64) }), /immutable/);
		assert.throws(() => q.saveTaskRevision({ ...completed, status: 'failed' }), /immutable/);
		assert.deepEqual(q.listTaskRevisions(fixture.runId, 'task-a'), [completed]);
		q.saveTaskRevision({ ...initial, executionRevision: 1, status: 'executing' });
		assert.equal(q.getCurrentTaskRevision(fixture.runId, 'task-a').executionRevision, 0);
		q.saveTaskRevision({ ...initial, executionRevision: 1, status: 'failed' });
		assert.throws(() => q.saveTaskRevision({ ...initial, executionRevision: 1, status: 'executing' }), /immutable/);
		const requestArtifact = fixture.artifacts.writeJson('interrupt', { finding: 'failure-a' });
		fixture.store.createInterrupt({ interruptId: 'interrupt-a', runId: fixture.runId,
			kind: 'QUALITY_REVIEW', stateHash: H, requestArtifact, createdAt: '2026-11-01T12:00:00.000Z' });
		q.bindInterrupt({ runId: fixture.runId, interruptId: 'interrupt-a', bindingHash: H,
			findingIds: ['failure-a'], expectedRevisions: [{ taskId: 'task-a', executionRevision: 0 }],
			affectedTaskIds: ['task-a'] });
		q.consumeAnswer({ runId: fixture.runId, expectedBindingHash: H, affectedTaskIds: ['task-a'],
			correctionId: 'correction-a', answer: {
				schemaVersion: '1.0.0', answerId: 'answer-a', interruptId: 'interrupt-a', bindingHash: H,
				findingIds: ['failure-a'], action: 'approve-correction', rationale: 'Fix owner source',
				evidenceHashes: [], correction: {
					owners: [{ taskId: 'task-a', expectedRevision: 0, editPaths: ['src/a.ts'] }],
					rerunObligationIds: [], maxSourceEditIterations: 1, expectedBudgetLedgerHash: q.budgetHash(fixture.runId),
				},
			} });
		assert.equal(q.getCurrentTaskRevision(fixture.runId, 'task-a'), null);
		assert.deepEqual(q.listRevisionSelections(fixture.runId), [
			{ taskId: 'task-a', executionRevision: 0, eligible: false },
		]);
		assert.equal(q.getTaskRevision(fixture.runId, 'task-a', 1).status, 'failed');
	} finally { fixture.close(); }
});
