import assert from 'node:assert/strict';
import test from 'node:test';
import { createInterruptRecords } from './interrupt-records.ts';
import { makeFixture } from '../testing/test-support.mjs';

function recordContext(store) {
	return Object.freeze({
		database: store.database,
		transaction: (operation) => store.transaction(operation),
		assertOpen: () => store.assertOpen(),
	});
}

test('interrupt records report no pending interrupt for a new run', () => {
	const fixture = makeFixture('interrupt-direct');
	try {
		fixture.runtime.initialize({ runId: fixture.runId, goal: 'direct interrupts' });
		const records = createInterruptRecords(recordContext(fixture.store));
		assert.equal(records.getPendingInterrupt(fixture.runId), null);
		assert.equal(records.getInterrupt('missing-interrupt'), null);
		assert.equal(records.getContinuationAttempts(fixture.runId, 'blocked'), 0);
	} finally {
		fixture.close();
	}
});
