import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectionRecords } from './projection-records.ts';
import { createRunLedger } from './run-ledger.ts';
import { makeFixture } from '../testing/test-support.mjs';

function recordContext(store) {
	return Object.freeze({
		database: store.database,
		transaction: (operation) => store.transaction(operation),
		assertOpen: () => store.assertOpen(),
	});
}

test('projection records list a queued run and an empty unknown run', () => {
	const fixture = makeFixture('projection-direct');
	try {
		fixture.runtime.initialize({ runId: fixture.runId, goal: 'direct projections' });
		const context = recordContext(fixture.store);
		const records = createProjectionRecords(context, createRunLedger(context));
		assert.equal(records.listPendingProjections(fixture.runId).length >= 1, true);
		assert.equal(typeof records.getProjectionRevision(fixture.runId), 'number');
		assert.deepEqual(records.listPendingProjections('2026-01-01-no-such-run'), []);
	} finally {
		fixture.close();
	}
});
