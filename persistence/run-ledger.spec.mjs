import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvent } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { makeFixture } from '../testing/test-support.mjs';
import { createRunLedger } from './run-ledger.ts';

function recordContext(store) {
	return Object.freeze({
		database: store.database,
		transaction: (operation) => store.transaction(operation),
		assertOpen: () => store.assertOpen(),
	});
}

test('@ac AC-02 @case AC-02.1 a ledger write uses the context transaction once and does not begin one itself', () => {
	const statements = [];
	const database = {
		exec(sql) {
			statements.push(sql);
		},
		prepare(sql) {
			statements.push(sql);
			return {
				get() {
					return undefined;
				},
				run() {
					return { changes: 1 };
				},
			};
		},
	};
	let transactions = 0;
	const ledger = createRunLedger(Object.freeze({
		database,
		assertOpen() {},
		transaction(operation) {
			transactions += 1;
			return operation();
		},
	}));
	ledger.insertEvent(createEvent({
		eventType: 'RUN_BLOCKED',
		runId: '2026-10-22-ledger-spy',
		runtimeRevision: 0,
		causalId: 'spy',
		payload: {},
	}));
	assert.equal(transactions, 1);
	assert.equal(statements.some((sql) => /\b(?:BEGIN|COMMIT|ROLLBACK)\b/.test(sql)), false);
});

test('@ac AC-02 @case AC-02.2 an event insert that throws inside the store transaction leaves no row', () => {
	const fixture = makeFixture('ledger-rollback');
	try {
		fixture.runtime.initialize({ runId: fixture.runId, goal: 'ledger rollback' });
		const ledger = createRunLedger(recordContext(fixture.store));
		const event = createEvent({
			eventType: 'RUN_BLOCKED',
			runId: fixture.runId,
			runtimeRevision: 0,
			causalId: 'ledger-rollback',
			payload: {},
		});
		assert.throws(() => fixture.store.transaction(() => {
			ledger.insertEvent(event);
			throw new Error('abort event');
		}), /abort event/);
		assert.equal(fixture.store.database.prepare('SELECT count(*) AS count FROM events WHERE event_id = ?').get(event.eventId).count, 0);
	} finally {
		fixture.close();
	}
});

test('@ac AC-02 @case AC-02.3 a lock error inside the store transaction is STORE_BUSY', () => {
	const fixture = makeFixture('ledger-busy');
	try {
		assert.throws(
			() => fixture.store.transaction(() => {
				throw new Error('database is locked');
			}),
			(error) => error instanceof SdlcError
				&& error.code === 'STORE_BUSY'
				&& error.message === 'Runtime database write timed out',
		);
	} finally {
		fixture.close();
	}
});

test('@ac AC-02 @case AC-02.4 a ledger read after close reports that the store is closed', () => {
	const fixture = makeFixture('ledger-closed');
	try {
		fixture.runtime.initialize({ runId: fixture.runId, goal: 'ledger closed' });
		const ledger = createRunLedger(recordContext(fixture.store));
		fixture.store.close();
		assert.throws(
			() => ledger.getRun(fixture.runId),
			(error) => error instanceof SdlcError
				&& error.code === 'INTERNAL_ERROR'
				&& error.message === 'Runtime store is closed',
		);
	} finally {
		fixture.close();
	}
});

test('run ledger rejects a missing run and a duplicate event with different content', () => {
	const fixture = makeFixture('ledger-direct');
	try {
		fixture.runtime.initialize({ runId: fixture.runId, goal: 'direct ledger' });
		const ledger = createRunLedger(recordContext(fixture.store));
		assert.throws(
			() => ledger.getRun('2026-01-01-missing-run'),
			(error) => error instanceof SdlcError && error.code === 'RUN_NOT_FOUND',
		);
		const event = createEvent({
			eventType: 'RUN_BLOCKED',
			runId: fixture.runId,
			runtimeRevision: 0,
			causalId: 'duplicate-event',
			payload: { first: true },
		});
		ledger.insertEvent(event);
		assert.throws(
			() => ledger.insertEvent({ ...event, payload: { first: false } }),
			(error) => error instanceof SdlcError && error.code === 'STORE_RECONCILIATION_FAILED',
		);
	} finally {
		fixture.close();
	}
});
