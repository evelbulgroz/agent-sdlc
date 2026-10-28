import assert from 'node:assert/strict';
import test from 'node:test';
import { createCheckpointRecords } from './checkpoint-records.ts';
import { makeFixture } from '../testing/test-support.mjs';

function recordContext(store) {
	return Object.freeze({
		database: store.database,
		transaction: (operation) => store.transaction(operation),
		assertOpen: () => store.assertOpen(),
	});
}

test('checkpoint records list an empty thread and reject a row without a thread id', () => {
	const fixture = makeFixture('checkpoint-direct');
	try {
		const records = createCheckpointRecords(recordContext(fixture.store));
		assert.deepEqual(records.listCheckpointRows({ threadId: 'missing-thread' }), []);
		assert.throws(
			() => records.putCheckpointRow({
				threadId: null,
				checkpointNamespace: '',
				checkpointId: 'cp-missing',
				parentCheckpointId: null,
				checkpointType: 'json',
				checkpoint: Buffer.from('{}'),
				metadataType: 'json',
				metadata: Buffer.from('{}'),
			}),
			/NOT NULL/,
		);
		assert.deepEqual(records.listCheckpointRows({ threadId: 'missing-thread' }), []);
		records.putCheckpointRow({
			threadId: 'thread-1',
			checkpointNamespace: '',
			checkpointId: 'cp-1',
			parentCheckpointId: null,
			checkpointType: 'json',
			checkpoint: Buffer.from('{}'),
			metadataType: 'json',
			metadata: Buffer.from('{}'),
		});
		const listed = records.listCheckpointRows({ threadId: 'thread-1' });
		assert.equal(listed.length, 1);
		assert.equal(listed[0].checkpoint_id, 'cp-1');
		assert.deepEqual(records.listCheckpointWrites({ threadId: 'thread-1', checkpointNamespace: '', checkpointId: 'cp-1' }), []);
	} finally {
		fixture.close();
	}
});
