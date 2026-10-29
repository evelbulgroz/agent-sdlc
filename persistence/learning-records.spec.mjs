import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeStore } from './runtime-store.ts';
import { createRunLedger } from './run-ledger.ts';
import { createLearningRecords } from './learning-records.ts';
import { makeFixture } from '../testing/test-support.mjs';

test('RuntimeStore persists candidate learnings and manages learning outbox', () => {
	const fixture = makeFixture('candidate-learnings', []);
	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'candidate learning test',
		});

		// 1. Record candidate learnings
		const candidate1 = fixture.store.recordCandidateLearning({
			runId: fixture.runId,
			taskId: 'task-a',
			generation: 0,
			stage: 'pipeline.pre_review',
			sourceRole: 'architect',
			type: 'architecture',
			key: 'arch-boundary-rule',
			scope: 'billing',
			query: 'cross package traversal',
			insight: 'Forbidden relative traversal.',
			confidence: 9,
		});
		assert.equal(candidate1.key, 'arch-boundary-rule');

		const list = fixture.store.listCandidateLearnings(fixture.runId);
		assert.equal(list.length, 1);
		assert.equal(list[0].key, 'arch-boundary-rule');
		assert.equal(list[0].sourceRole, 'architect');
		assert.equal(list[0].taskId, 'task-a');
		assert.equal(list[0].sourcePhase, 'architect');

		fixture.store.recordCandidateLearning({
			runId: fixture.runId,
			taskId: 'task-a',
			generation: 0,
			sourcePhase: 'architect',
			type: 'architecture',
			key: 'arch-boundary-rule',
			scope: 'billing',
			query: 'cross package traversal',
			insight: 'Updated forbidden relative traversal.',
			confidence: 10,
		});
		fixture.store.recordCandidateLearning({
			runId: fixture.runId,
			taskId: 'task-b',
			generation: 0,
			sourcePhase: 'architect',
			type: 'architecture',
			key: 'arch-boundary-rule',
			scope: 'billing',
			query: 'cross package traversal',
			insight: 'Same learning observed in another task.',
			confidence: 8,
		});
		const taskScoped = fixture.store.listCandidateLearnings(fixture.runId);
		assert.equal(taskScoped.length, 2);
		assert.equal(
			taskScoped.find((candidate) => candidate.taskId === 'task-a').insight,
			'Updated forbidden relative traversal.',
		);

		// 2. Enqueue and drain learning outbox
		const enqueued = fixture.store.enqueueLearningOutbox({
			runId: fixture.runId,
			learning: {
				type: 'architecture',
				key: 'arch-boundary-rule',
				scope: 'billing',
				query: 'cross package traversal',
				insight: 'Forbidden relative traversal.',
			},
		});
		assert.equal(enqueued.status, 'pending');

		const pending = fixture.store.listPendingLearningOutbox(fixture.runId);
		assert.equal(pending.length, 1);
		assert.equal(pending[0].outboxId, enqueued.outboxId);

		const updated = fixture.store.markLearningOutboxPublished([enqueued.outboxId]);
		assert.equal(updated, 1);

		const remaining = fixture.store.listPendingLearningOutbox(fixture.runId);
		assert.equal(remaining.length, 0);
	} finally {
		fixture.close();
	}
});

function recordContext(store) {
	return Object.freeze({
		database: store.database,
		transaction: (operation) => store.transaction(operation),
		assertOpen: () => store.assertOpen(),
	});
}

test('learning records publish only the outbox ids they are given', () => {
	const fixture = makeFixture('learning-direct');
	try {
		fixture.runtime.initialize({ runId: fixture.runId, goal: 'direct learning records' });
		const context = recordContext(fixture.store);
		const records = createLearningRecords(context, createRunLedger(context));
		assert.deepEqual(records.listPendingLearningOutbox(fixture.runId), []);
		const now = new Date().toISOString();
		records.insertLearningOutboxRow({
			outboxId: 'outbox-keep',
			runId: fixture.runId,
			runtimeRevision: 0,
			learningKey: 'keep',
			payloadJson: '{}',
			now,
		});
		records.insertLearningOutboxRow({
			outboxId: 'outbox-publish',
			runId: fixture.runId,
			runtimeRevision: 0,
			learningKey: 'publish',
			payloadJson: '{}',
			now,
		});
		assert.equal(records.markLearningOutboxPublished(['outbox-publish']), 1);
		assert.deepEqual(records.listPendingLearningOutbox(fixture.runId).map((row) => row.outboxId), ['outbox-keep']);
	} finally {
		fixture.close();
	}
});
