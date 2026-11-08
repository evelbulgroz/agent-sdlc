import assert from 'node:assert/strict';
import test from 'node:test';
import { taskQualityFixture } from '../testing/task-quality-fixture.mjs';
import { createApplyQualityAnswerNode } from './nodes/quality-answer.ts';
import { sha256 } from '../policy/contracts.ts';

const H = 'a'.repeat(64);

for (const action of ['confirm', 'refute']) {
test(`a consumed ${action} answer replays after a failed transition without requiring another answer`, async t => {
	const f = taskQualityFixture(t);
	const binding = { runId: f.runId, approvedSpecHash: H, taskPlanHash: f.snapshot.taskPlanHash,
		qualityPolicyHash: sha256(f.plan.qualityPolicy), checkpointId: 'vertical', checkpointKind: 'slice',
		ownerId: 'vertical', candidateRevision: 0, baseCommitSha: f.base, treeSha: f.tree,
		revisionSetHash: sha256([]), preparationHash: H };
	const bindingHash = sha256(binding);
	if (action === 'refute') {
		const receiptHash = f.store.quality.saveVerificationReceipt({
			schemaVersion: '1.0.0', runId: f.runId, taskId: 'enable-task', executionRevision: 0,
			treeSha: f.tree, command: ['pnpm', 'test'], exitCode: 0, status: 'passed',
			artifactHash: f.artifacts.writeJson('verification', { exitCode: 0 }),
		});
		f.store.quality.registerWorktree({
			runId: f.runId, registryId: 'vertical', kind: 'slice', ownerId: 'vertical',
			relativePath: 'worktrees/enable-task', bindingHash, sourceHash: H,
		});
		f.store.quality.saveClosure({
			schemaVersion: '1.0.0', binding, selectedRevisions: [], registryId: 'vertical',
			status: 'reviewing', receiptHashes: [receiptHash], reviewOperationIds: [],
		});
	}
	const answer = {
		schemaVersion: '1.0.0', answerId: 'answer-a', interruptId: 'interrupt-a',
		bindingHash, action, findingIds: ['finding-a'],
		evidenceHashes: action === 'refute' ? [f.artifacts.writeJson('claim-evidence', {
			schemaVersion: '1.0.0', bindingHash, findingId: 'finding-a',
			rationale: 'The exact case disproves the finding.',
			evidenceHashes: [f.artifacts.writeText('evidence', 'Reproduction disproves the finding.')],
		})] : [],
		rationale: 'Keep the blocker.', correction: null,
	};
	f.store.createInterrupt({
		runId: f.runId, interruptId: answer.interruptId, kind: 'quality_review', stateHash: H,
		requestArtifact: f.artifacts.writeJson('quality-review', {
			status: 'FAIL', allowedActions: [action], findings: [{ findingId: 'finding-a' }],
		}), createdAt: new Date().toISOString(),
	});
	f.store.quality.bindInterrupt({
		runId: f.runId, interruptId: answer.interruptId, bindingHash,
		findingIds: answer.findingIds, expectedRevisions: [], affectedTaskIds: [],
	});
	const snapshot = { ...f.snapshot, state: 'BLOCKED', pendingInterruptId: answer.interruptId,
		qualityCheckpointBindingHash: bindingHash, qualityCheckpointKind: 'slice' };
	let fail = true;
	const runtime = { ...f.runtime, transition(current, options) {
		if (fail) { fail = false; throw new Error('injected transition crash'); }
		return f.runtime.transition(current, options);
	} };
	const apply = createApplyQualityAnswerNode(runtime);
	await assert.rejects(apply({ snapshot, humanResponse: answer }), /injected transition crash/);
	assert.equal(f.store.getPendingInterrupt(f.runId), null);
	const result = await apply({ snapshot, humanResponse: answer });
	assert.equal(result.snapshot.pendingInterruptId, null);
	if (action === 'refute') {
		assert.equal(result.snapshot.blockedReason, null);
		assert.equal(result.snapshot.state, 'EXECUTING_IMPLEMENTATION');
		assert.equal(f.store.quality.getClosure(f.runId, 'vertical', 0).status, 'accepted');
	} else {
		assert.equal(result.snapshot.blockedReason, 'QUALITY_CONFIRMED');
	}
	const beforeStaleAnswer = f.store.getRun(f.runId);
	await assert.rejects(apply({ snapshot, humanResponse: { ...answer, rationale: 'Changed answer' } }),
		/collision|changed/i);
	assert.deepEqual(f.store.getRun(f.runId), beforeStaleAnswer);
	assert.equal(f.store.quality.getConsumedAnswer(f.runId, answer.interruptId).answerHash, sha256(answer));
});
}
