import assert from 'node:assert/strict';
import test from 'node:test';

import { createRunLedger } from './run-ledger.ts';
import { createGenerationRecords } from './generation-records.ts';
import { createTaskPlanRecords } from './task-plan-records.ts';
import { createProjectionRecords } from './projection-records.ts';
import { createStoreIntegrity } from './store-integrity.ts';
import { makeFixture } from '../testing/test-support.mjs';
import { createEvent } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';

test('@ac AC-03 @case AC-03.2 runtime store reconciliation validates v3 authorization, generation sequence, and tool outputs', () => {
	const fixture = makeFixture('reconcile-v3', []);
	try {
		const initial = fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Slice 2 reconcile test',
		});

		// Add generation 0
		fixture.store.saveGeneration({
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			generation: 0,
			baseCommitSha: 'a'.repeat(40),
			targetTreeSha: 'b'.repeat(40),
			scopeFingerprints: { 'apps/services/conditioning': 'c'.repeat(64) },
			taskOwnedPaths: ['apps/services/conditioning/**'],
			materializedAt: new Date().toISOString(),
		});

		// Reconcile succeeds
		const result = fixture.store.reconcile(fixture.runId);
		assert.equal(result.generations.length, 1);

		// Gap in generations (adding generation 2 skipping 1) must fail reconciliation
		fixture.store.saveGeneration({
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			generation: 2,
			baseCommitSha: 'a'.repeat(40),
			targetTreeSha: 'b'.repeat(40),
			scopeFingerprints: { 'apps/services/conditioning': 'c'.repeat(64) },
			taskOwnedPaths: ['apps/services/conditioning/**'],
			materializedAt: new Date().toISOString(),
		});
		assert.throws(
			() => fixture.store.reconcile(fixture.runId),
			(error) =>
				error.code === 'STORE_RECONCILIATION_FAILED' &&
				/Generations must be sequentially indexed/.test(error.message),
		);
	} finally {
		fixture.close();
	}
});

test('@ac AC-03 @case AC-03.3 runtime store accepts a contiguous generation suffix starting at a resumed generation', () => {
	const fixture = makeFixture('reconcile-resumed-generation', []);
	try {
		const initial = fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Resume generation reconciliation test',
		});
		const failedState = {
			...initial,
			state: 'FAILED',
			activeGeneration: 1,
			runtimeRevision: initial.runtimeRevision + 1,
			lastError: {
				code: 'GOVERNOR_BUDGET_DENIED',
				message: 'Reviewer prompt exceeded its budget',
			},
			updatedAt: new Date().toISOString(),
		};
		fixture.store.saveTransition(
			initial.runtimeRevision,
			failedState,
			createEvent({
				eventType: 'RUN_FAILED',
				runId: fixture.runId,
				runtimeRevision: failedState.runtimeRevision,
				state: failedState,
				input: initial,
				output: { reason: 'GOVERNOR_BUDGET_DENIED' },
				causalId: `${fixture.runId}:reviewer-budget-denied`,
				payload: { reason: 'GOVERNOR_BUDGET_DENIED' },
			}),
		);

		for (const generation of [1, 2]) {
			fixture.store.saveGeneration({
				schemaVersion: '1.0.0',
				runId: fixture.runId,
				generation,
				baseCommitSha: 'a'.repeat(40),
				targetTreeSha: 'b'.repeat(40),
				scopeFingerprints: { 'apps/services/conditioning': 'c'.repeat(64) },
				taskOwnedPaths: ['apps/services/conditioning/**'],
				materializedAt: new Date().toISOString(),
			});
		}
		assert.equal(fixture.store.reconcile(fixture.runId).generations.length, 2);

		fixture.store.saveGeneration({
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			generation: 4,
			baseCommitSha: 'a'.repeat(40),
			targetTreeSha: 'b'.repeat(40),
			scopeFingerprints: { 'apps/services/conditioning': 'c'.repeat(64) },
			taskOwnedPaths: ['apps/services/conditioning/**'],
			materializedAt: new Date().toISOString(),
		});
		assert.throws(
			() => fixture.store.reconcile(fixture.runId),
			(error) =>
				error.code === 'STORE_RECONCILIATION_FAILED' &&
				/Generations must be sequentially indexed/.test(error.message),
		);
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

test('@ac AC-03 @case AC-03.1 facade reconcile and store integrity return the same verdict', () => {
	const fixture = makeFixture('reconcile-equal');
	try {
		fixture.runtime.initialize({ runId: fixture.runId, goal: 'equal reconcile' });
		const context = recordContext(fixture.store);
		const ledger = createRunLedger(context);
		const integrity = createStoreIntegrity(context, {
			ledger,
			projections: createProjectionRecords(context, ledger),
			taskPlans: createTaskPlanRecords(context),
			generations: createGenerationRecords(context),
		});
		const throughFacade = fixture.store.reconcile(fixture.runId);
		const throughModule = integrity.reconcile(fixture.runId);
		assert.deepEqual(throughFacade, throughModule);
		for (const key of ['state', 'transitions', 'generations', 'toolExecutions', 'tasks', 'pendingProjections', 'currentProjection']) {
			assert.equal(Object.hasOwn(throughModule, key), true, key);
		}
	} finally {
		fixture.close();
	}
});

test('@ac AC-03 @case AC-03.4 reconcile names a missing artifact hash', () => {
	const fixture = makeFixture('reconcile-missing-artifact');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'missing artifact' });
		fixture.store.database.prepare('DELETE FROM artifacts WHERE hash = ?').run(initial.goalArtifact);
		assert.throws(
			() => fixture.store.reconcile(fixture.runId),
			(error) => error instanceof SdlcError
				&& error.code === 'STORE_RECONCILIATION_FAILED'
				&& error.message.includes(initial.goalArtifact),
		);
	} finally {
		fixture.close();
	}
});
