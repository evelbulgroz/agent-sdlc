import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { runCli } from '../cli/cli.ts';
import { canonicalJson, createEvent, sha256 } from '../policy/contracts.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { RuntimeStore } from '../persistence/runtime-store.ts';
import { FakeModelGovernor } from '../testing/fake-model-governor.mjs';
import { cleanupRun } from '../testing/recovery-fixtures.mjs';
import { completeProposal, trackTestRun } from '../testing/test-support.mjs';

test('comprehensive reconciliation fails closed for every canonical record family', async (t) => {
	const corruptions = [
		[
			'intermediate-event-state-hash',
			(database, runId) => {
				const row = database
					.prepare(
						`
							SELECT event_id, event_json FROM events
							WHERE run_id = ? AND event_type <> 'PROJECTION_WRITTEN'
							ORDER BY runtime_revision LIMIT 1 OFFSET 1
						`,
					)
					.get(runId);
				const event = JSON.parse(row.event_json);
				event.stateHash = '0'.repeat(64);
				database
					.prepare('UPDATE events SET event_json = ? WHERE event_id = ?')
					.run(JSON.stringify(event), row.event_id);
			},
		],
		[
			'intermediate-event-payload',
			(database, runId) => {
				const row = database
					.prepare(
						`
							SELECT event_id, event_json FROM events
							WHERE run_id = ? AND event_type <> 'PROJECTION_WRITTEN'
							ORDER BY runtime_revision LIMIT 1 OFFSET 1
						`,
					)
					.get(runId);
				const event = JSON.parse(row.event_json);
				event.payload = { ...event.payload, corrupted: true };
				database
					.prepare('UPDATE events SET event_json = ? WHERE event_id = ?')
					.run(JSON.stringify(event), row.event_id);
			},
		],
		[
			'intermediate-event-id',
			(database, runId) => {
				const row = database
					.prepare(
						`
							SELECT event_id, event_json FROM events
							WHERE run_id = ? AND event_type <> 'PROJECTION_WRITTEN'
							ORDER BY runtime_revision LIMIT 1 OFFSET 1
						`,
					)
					.get(runId);
				const event = JSON.parse(row.event_json);
				event.eventId = 'corrupted-event-id';
				database
					.prepare('UPDATE events SET event_json = ? WHERE event_id = ?')
					.run(JSON.stringify(event), row.event_id);
			},
		],
		[
			'projection-event-log-hash',
			(database, runId) => {
				const row = database
					.prepare(
						`
							SELECT runtime_revision, status_json FROM projection_outbox
							WHERE run_id = ? AND status_json IS NOT NULL
							ORDER BY runtime_revision DESC LIMIT 1
						`,
					)
					.get(runId);
				const status = JSON.parse(row.status_json);
				status.orchestration.eventLogHash = '0'.repeat(64);
				status.orchestration.projectionHash = sha256({
					...status,
					orchestration: {
						...status.orchestration,
						projectionHash: null,
					},
				});
				database
					.prepare(
						`
							UPDATE projection_outbox SET status_json = ?
							WHERE run_id = ? AND runtime_revision = ?
						`,
					)
					.run(canonicalJson(status), runId, row.runtime_revision);
			},
		],
		[
			'latest-transition',
			(database, runId) =>
				database
					.prepare(
						`
						DELETE FROM events WHERE event_id = (
							SELECT event_id FROM events
							WHERE run_id = ? AND event_type <> 'PROJECTION_WRITTEN'
							ORDER BY runtime_revision DESC LIMIT 1
						)
					`,
					)
					.run(runId),
		],
		[
			'pending-interrupt',
			(database, runId) =>
				database
					.prepare(
						`
						UPDATE interrupts SET interrupt_id = interrupt_id || '-other'
						WHERE run_id = ? AND status = 'PENDING'
					`,
					)
					.run(runId),
		],
		[
			'checkpoint',
			(database, runId) =>
				database
					.prepare(
						`
						DELETE FROM checkpoints
						WHERE thread_id = (SELECT thread_id FROM runs WHERE run_id = ?)
					`,
					)
					.run(runId),
		],
		[
			'artifact',
			(database, runId) => {
				const state = JSON.parse(
					database.prepare('SELECT state_json FROM runs WHERE run_id = ?').get(runId).state_json,
				);
				return database.prepare('DELETE FROM artifacts WHERE hash = ?').run(state.draftArtifact);
			},
		],
		[
			'model-operation',
			(database, runId) =>
				database.prepare('DELETE FROM model_operations WHERE run_id = ?').run(runId),
		],
		[
			'projection-outbox',
			(database, runId) =>
				database
					.prepare(
						`
						DELETE FROM projection_outbox
						WHERE run_id = ? AND runtime_revision = (
							SELECT runtime_revision FROM runs WHERE run_id = ?
						)
					`,
					)
					.run(runId, runId),
		],
	];
	for (const [label, corrupt] of corruptions) {
		await t.test(label, async () => {
			const testSlug = `sdlc-reconcile-${label}-${trackTestRun(crypto.randomUUID().slice(0, 8))}`;
			const governor = new FakeModelGovernor([completeProposal()]);
			let runId;
			try {
				const started = await runCli(
					['start', '--slug', testSlug, '--goal', 'Reconcile every canonical record'],
					{ rootDir: REPOSITORY_ROOT, governor },
				);
				runId = started.result.runId;
				const database = new DatabaseSync(
					path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
				);
				try {
					corrupt(database, runId);
				} finally {
					database.close();
				}
				const result = await runCli(['status', '--run', runId], {
					rootDir: REPOSITORY_ROOT,
					governor,
				});
				assert.equal(result.exitCode, 70);
				assert.ok(
					['STORE_RECONCILIATION_FAILED', 'ARTIFACT_CORRUPT'].includes(result.result.error.code),
				);
			} finally {
				if (runId) cleanupRun(runId);
			}
		});
	}
});

test('atomic cancellation transaction boundary rolls back completely on mid-transaction fault', async () => {
	const testSlug = `sdlc-atomic-cancel-${trackTestRun(crypto.randomUUID().slice(0, 8))}`;
	const governor = new FakeModelGovernor([completeProposal()]);
	let runId;
	try {
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Atomic cancellation transaction safety'],
			{ rootDir: REPOSITORY_ROOT, governor },
		);
		runId = started.result.runId;
		const initialInterruptId = started.result.pendingInterrupt.interruptId;

		const dbPath = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite');
		const store = new RuntimeStore(dbPath);
		try {
			const oldState = store.getRun(runId);
			assert.equal(oldState.state, 'WAITING_FOR_ANSWERS');
			assert.equal(oldState.pendingInterruptId, initialInterruptId);
			assert.equal(store.getInterrupt(initialInterruptId).status, 'PENDING');

			// queueProjection runs inside the open transaction, so a throw must roll back interrupt + state together.
			const originalQueueProjection = store.queueProjection.bind(store);
			store.queueProjection = () => {
				throw new Error('simulated transaction crash during atomic cancellation');
			};

			const nextState = {
				...oldState,
				state: 'CANCELLED',
				runtimeRevision: oldState.runtimeRevision + 1,
				pendingInterruptId: null,
				blockedReason: 'RUN_CANCELLED',
				updatedAt: new Date().toISOString(),
			};
			const cancelEvent = createEvent({
				eventType: 'RUN_CANCELLED',
				runId,
				runtimeRevision: nextState.runtimeRevision,
				state: nextState,
				input: oldState,
				output: { reason: 'RUN_CANCELLED' },
				causalId: `cancel-${oldState.runtimeRevision}`,
				payload: { reason: 'RUN_CANCELLED' },
			});

			assert.throws(
				() =>
					store.saveTransition(
						oldState.runtimeRevision,
						nextState,
						cancelEvent,
						{ cancelInterruptId: initialInterruptId },
					),
				/simulated transaction crash during atomic cancellation/,
			);

			store.queueProjection = originalQueueProjection;

			const rolledBackState = store.getRun(runId);
			assert.equal(rolledBackState.state, 'WAITING_FOR_ANSWERS');
			assert.equal(rolledBackState.runtimeRevision, oldState.runtimeRevision);
			assert.equal(rolledBackState.pendingInterruptId, initialInterruptId);
			const interrupt = store.getInterrupt(initialInterruptId);
			assert.equal(interrupt.status, 'PENDING');
			assert.equal(interrupt.resolvedAt, null);

			const reconciled = store.reconcile(runId);
			assert.equal(reconciled.state.state, 'WAITING_FOR_ANSWERS');
			assert.equal(reconciled.state.pendingInterruptId, initialInterruptId);
		} finally {
			store.close();
		}

		const preStatus = await runCli(['status', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor,
		});
		assert.equal(preStatus.result.state, 'WAITING_FOR_ANSWERS');
		assert.equal(preStatus.result.pendingInterrupt.interruptId, initialInterruptId);

		const cancelled = await runCli(['cancel', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor,
		});
		assert.equal(cancelled.result.state, 'CANCELLED');

		const reopenedStore = new RuntimeStore(dbPath);
		try {
			const finalState = reopenedStore.getRun(runId);
			assert.equal(finalState.state, 'CANCELLED');
			assert.equal(finalState.pendingInterruptId, null);
			const resolvedInterrupt = reopenedStore.getInterrupt(initialInterruptId);
			assert.equal(resolvedInterrupt.status, 'RESOLVED');
			assert.ok(resolvedInterrupt.resolvedAt);

			const reconciled = reopenedStore.reconcile(runId);
			assert.equal(reconciled.state.state, 'CANCELLED');
		} finally {
			reopenedStore.close();
		}

		// Restart CLI status observes entirely cancelled state
		const postStatus = await runCli(['status', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor,
		});
		assert.equal(postStatus.result.state, 'CANCELLED');
	} finally {
		if (runId) cleanupRun(runId);
	}
});
