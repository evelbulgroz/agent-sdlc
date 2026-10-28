import assert from 'node:assert/strict';
import test from 'node:test';

import { createRunLedger } from './run-ledger.ts';
import { createModelOperationRecords } from './model-operation-records.ts';
import { makeFixture } from '../testing/test-support.mjs';

test('recordDiagnostic commits diagnostic row and FALSE_ECONOMY_DETECTED event atomically, handles idempotency and collision', () => {
	const fixture = makeFixture('store-diagnostic', []);
	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Diagnostic store test',
		});

		const diagnosticPayload = {
			initialRouteIds: ['openai-compatible-conservative'],
			effectiveStrategy: 'min-cost',
			costInitialMicrousd: 500,
			repairAttemptCount: 1,
			costRepairMicrousd: 1500,
			netChurnCostMicrousd: 2000,
			deltaMicrousd: 1000,
			burnedRepairAttempts: 1,
		};

		// 1. Record diagnostic
		const rec = fixture.store.recordDiagnostic({
			diagnosticId: 'diag-1',
			runId: fixture.runId,
			taskId: 'task-0',
			kind: 'FALSE_ECONOMY_DETECTED',
			payload: diagnosticPayload,
		});
		assert.equal(rec.diagnosticId, 'diag-1');
		assert.equal(rec.kind, 'FALSE_ECONOMY_DETECTED');

		// Verify event was recorded atomically
		const events = fixture.store.listEvents(fixture.runId);
		const falseEconomyEvent = events.find((e) => e.eventType === 'FALSE_ECONOMY_DETECTED');
		assert.ok(falseEconomyEvent);
		assert.equal(falseEconomyEvent.payload.netChurnCostMicrousd, 2000);
		assert.equal(falseEconomyEvent.causalId, 'diag-1');

		// 2. Query via listDiagnostics
		const list = fixture.store.listDiagnostics(fixture.runId);
		assert.equal(list.length, 1);
		assert.equal(list[0].diagnosticId, 'diag-1');
		assert.deepEqual(list[0].payload, diagnosticPayload);

		// 3. Idempotent replay with identical payload
		const replayed = fixture.store.recordDiagnostic({
			diagnosticId: 'diag-1',
			runId: fixture.runId,
			taskId: 'task-0',
			kind: 'FALSE_ECONOMY_DETECTED',
			payload: diagnosticPayload,
		});
		assert.equal(replayed.diagnosticId, 'diag-1');
		assert.equal(fixture.store.listDiagnostics(fixture.runId).length, 1);

		// 4. Collision with different payload throws STORE_RECONCILIATION_FAILED
		assert.throws(
			() =>
				fixture.store.recordDiagnostic({
					diagnosticId: 'diag-1',
					runId: fixture.runId,
					taskId: 'task-0',
					kind: 'FALSE_ECONOMY_DETECTED',
					payload: { ...diagnosticPayload, netChurnCostMicrousd: 9999 },
				}),
			(err) =>
				err.code === 'STORE_RECONCILIATION_FAILED' &&
				err.message.includes('different payload'),
		);

		// 5. Collision with different taskId throws STORE_RECONCILIATION_FAILED
		assert.throws(
			() =>
				fixture.store.recordDiagnostic({
					diagnosticId: 'diag-1',
					runId: fixture.runId,
					taskId: 'task-other',
					kind: 'FALSE_ECONOMY_DETECTED',
					payload: diagnosticPayload,
				}),
			(err) =>
				err.code === 'STORE_RECONCILIATION_FAILED' &&
				err.message.includes('different task ID'),
		);

		// 6. Collision with different kind throws STORE_RECONCILIATION_FAILED
		assert.throws(
			() =>
				fixture.store.recordDiagnostic({
					diagnosticId: 'diag-1',
					runId: fixture.runId,
					taskId: 'task-0',
					kind: 'OTHER_DIAGNOSTIC',
					payload: diagnosticPayload,
				}),
			(err) =>
				err.code === 'STORE_RECONCILIATION_FAILED' &&
				err.message.includes('different kind'),
		);

		// 7. Event missing or altered throws STORE_RECONCILIATION_FAILED
		// Delete the event to simulate corrupted/missing event identity
		fixture.store.database
			.prepare('DELETE FROM events WHERE event_id = ?')
			.run(falseEconomyEvent.eventId);
		assert.throws(
			() =>
				fixture.store.recordDiagnostic({
					diagnosticId: 'diag-1',
					runId: fixture.runId,
					taskId: 'task-0',
					kind: 'FALSE_ECONOMY_DETECTED',
					payload: diagnosticPayload,
				}),
			(err) =>
				err.code === 'STORE_RECONCILIATION_FAILED' &&
				err.message.includes('associated event is missing'),
		);
	} finally {
		fixture.close();
	}
});

test('model_operations lifecycle preserves nullable calibration fields', () => {
	const fixture = makeFixture('store-model-op', []);
	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Model op calibration test',
		});

		// 1. Initial reservation / requested state: calibration fields undefined
		fixture.store.recordModelOperation({
			operationId: 'op-calib-1',
			runId: fixture.runId,
			synthetic: false,
			status: 'requested',
		});
		const initial = fixture.store.getModelOperation('op-calib-1');
		assert.equal(initial.status, 'requested');
		assert.equal(initial.effectiveStrategy, undefined);
		assert.equal(initial.selectedQualityTier, undefined);
		assert.equal(initial.counterfactualTier2CostMicrousd, undefined);

		// 2. Terminal completion records calibration fields
		fixture.store.recordModelOperation({
			operationId: 'op-calib-1',
			runId: fixture.runId,
			synthetic: false,
			status: 'succeeded',
			effectiveStrategy: 'min-cost',
			selectedQualityTier: 1,
			counterfactualTier2CostMicrousd: 500,
		});
		const completed = fixture.store.getModelOperation('op-calib-1');
		assert.equal(completed.status, 'succeeded');
		assert.equal(completed.effectiveStrategy, 'min-cost');
		assert.equal(completed.selectedQualityTier, 1);
		assert.equal(completed.counterfactualTier2CostMicrousd, 500);
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

test('model operation records count and list an empty run directly', () => {
	const fixture = makeFixture('model-direct');
	try {
		fixture.runtime.initialize({ runId: fixture.runId, goal: 'direct model operations' });
		const context = recordContext(fixture.store);
		const records = createModelOperationRecords(context, createRunLedger(context));
		assert.equal(records.countModelOperations(fixture.runId), 0);
		assert.equal(records.getModelOperation('missing-operation'), null);
		assert.deepEqual(records.listDiagnostics(fixture.runId), []);
	} finally {
		fixture.close();
	}
});
