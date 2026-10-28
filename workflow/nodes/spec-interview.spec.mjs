import assert from 'node:assert/strict';
import test from 'node:test';
import { makeFixture } from '../../testing/test-support.mjs';
import {
	createPrepareQuestionsNode,
	createAskQuestionsNode,
	createApplyAnswersNode,
} from './spec-interview.ts';

test('createPrepareQuestionsNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createPrepareQuestionsNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createPrepareQuestionsNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createPrepareQuestionsNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});

test('createAskQuestionsNode returns the snapshot when no interrupt is pending', () => {
	const fixture = makeFixture('createAskQuestionsNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createAskQuestionsNode' });
		const result = createAskQuestionsNode(fixture.runtime)({ snapshot: initial });
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.equal(result.humanResponse, null);
	} finally {
		fixture.close();
	}
});

test('createApplyAnswersNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createApplyAnswersNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createApplyAnswersNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createApplyAnswersNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});
