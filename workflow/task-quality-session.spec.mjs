import assert from 'node:assert/strict';
import test from 'node:test';
import { taskQualityFixture as fixture } from '../testing/task-quality-fixture.ts';

test('enabling task proof persists and reuses an exact receipt without running verification twice', async t => {
	const f = fixture(t);
	await f.session.hooks.verifyTask(f.candidate, f.worktreeDir);
	assert.equal(f.commandCount(), 1);
	assert.equal(f.store.quality.getCurrentTaskRevision(f.runId, 'enable-task').status, 'completed');
	await f.session.hooks.verifyTask(f.candidate, f.worktreeDir);
	assert.equal(f.commandCount(), 1);
	assert.equal(f.store.quality.getBudget(f.runId).counters.executionInvocations, 1);
	const closure = await f.session.prepareSlice('enable', {
		...f.plan, tasks: [{ ...f.candidate, status: 'completed' }, f.plan.tasks[1]],
	});
	assert.equal(closure.status, 'verified');
	assert.equal(closure.binding.treeSha, f.candidate.targetTreeSha);
	assert.equal(closure.receiptHashes.length, 1);
	assert.equal(f.store.quality.getClosure(f.runId, closure.binding.checkpointId, 0).status, 'verified');
});

test('interrupted task verification cannot execute again without its completed receipt', async t => {
	const f = fixture(t);
	f.store.quality.reserveBudget(f.runId, {
		operationId: `verification-enable-task-r0-${f.candidate.targetTreeSha}`, kind: 'execution',
		checkpointId: 'task:enable-task', candidateRevision: 0, status: 'reserved',
	});
	await assert.rejects(f.session.hooks.verifyTask(f.candidate, f.worktreeDir), /no complete receipt/);
	assert.equal(f.commandCount(), 0);
	assert.equal(f.store.quality.getCurrentTaskRevision(f.runId, 'enable-task'), null);
});
