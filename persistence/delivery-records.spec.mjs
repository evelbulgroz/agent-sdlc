import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliveryRecords } from './delivery-records.ts';
import { makeFixture } from '../testing/test-support.mjs';

function recordContext(store) {
	return Object.freeze({
		database: store.database,
		transaction: (operation) => store.transaction(operation),
		assertOpen: () => store.assertOpen(),
	});
}

test('delivery records return null and reject an invalid git commit before writing', () => {
	const fixture = makeFixture('delivery-direct');
	try {
		fixture.runtime.initialize({ runId: fixture.runId, goal: 'direct delivery' });
		const records = createDeliveryRecords(recordContext(fixture.store));
		assert.equal(records.getGitCommit(fixture.runId), null);
		assert.equal(records.getPullRequest(fixture.runId), null);
		const before = fixture.store.database.prepare('SELECT count(*) AS count FROM git_commits').get().count;
		assert.throws(() => records.saveGitCommit({ runId: fixture.runId, commitSha: 'not-a-sha' }));
		assert.equal(fixture.store.database.prepare('SELECT count(*) AS count FROM git_commits').get().count, before);
	} finally {
		fixture.close();
	}
});
