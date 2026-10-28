import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeStore } from './runtime-store.ts';
import { makeFixture } from '../testing/test-support.mjs';
import { createEvent } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';

test('RuntimeStore executes saveResumeFromEscalation atomically', () => {
	const fixture = makeFixture('resume-escalation', []);
	try {
		const initial = fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'resume escalation test',
		});
		fixture.store.saveTransition(
			initial.runtimeRevision,
			{
				...initial,
				state: 'ESCALATED',
				runtimeRevision: initial.runtimeRevision + 1,
				updatedAt: new Date().toISOString(),
			},
			{
				eventId: 'evt-esc-1',
				eventType: 'RUN_BLOCKED',
				runId: fixture.runId,
				runtimeRevision: initial.runtimeRevision + 1,
				stateHash: null,
				inputHash: null,
				outputHash: null,
				timestamp: new Date().toISOString(),
				causalId: `${fixture.runId}:esc`,
				payload: { reason: 'TEST_ESCALATION' },
			},
		);

		const current = fixture.store.getRun(fixture.runId);
		assert.equal(current.state, 'ESCALATED');

		const nextState = {
			...current,
			state: 'SNAPSHOT_GENERATION',
			runtimeRevision: current.runtimeRevision + 1,
			activeGeneration: 1,
			updatedAt: new Date().toISOString(),
		};

		const event = {
			eventId: 'evt-resume-1',
			eventType: 'RESUME_FROM_ESCALATION',
			runId: fixture.runId,
			runtimeRevision: nextState.runtimeRevision,
			stateHash: null,
			inputHash: null,
			outputHash: null,
			timestamp: new Date().toISOString(),
			causalId: `${fixture.runId}:operator:resume`,
			payload: {
				resumedBy: 'operator',
				priorGeneration: 0,
				newGeneration: 1,
			},
		};

		const candidateLearning = {
			runId: fixture.runId,
			generation: 1,
			stage: 'operator.post_mortem',
			sourceRole: 'operator',
			type: 'pitfall',
			key: 'operator-fix-rule',
			scope: 'conditioning',
			query: 'human fix rule',
			insight: 'Human operator intervention fixed schema conflict.',
			confidence: 10,
		};

		const result = fixture.store.saveResumeFromEscalation({
			expectedRevision: current.runtimeRevision,
			nextState,
			event,
			candidateLearning,
		});

		assert.equal(result.state, 'SNAPSHOT_GENERATION');
		assert.equal(result.runtimeRevision, current.runtimeRevision + 1);

		// Verify candidate learning was recorded
		const learnings = fixture.store.listCandidateLearnings(fixture.runId);
		assert.equal(learnings.length, 1);
		assert.equal(learnings[0].key, 'operator-fix-rule');

		// Verify learning outbox was enqueued
		const outbox = fixture.store.listPendingLearningOutbox(fixture.runId);
		assert.equal(outbox.length, 1);
		const parsedOutbox = JSON.parse(outbox[0].learningJson);
		assert.equal(parsedOutbox.key, 'operator-fix-rule');
	} finally {
		fixture.close();
	}
});

test('saveResumeFromEscalation rolls back transition, candidate, and outbox together', () => {
	const fixture = makeFixture('resume-escalation-rollback', []);
	try {
		const initial = fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'resume rollback test',
		});
		const escalated = {
			...initial,
			state: 'ESCALATED',
			runtimeRevision: initial.runtimeRevision + 1,
			updatedAt: new Date().toISOString(),
		};
		fixture.store.saveTransition(initial.runtimeRevision, escalated, {
			eventId: 'evt-rollback-escalated',
			eventType: 'RUN_BLOCKED',
			runId: fixture.runId,
			runtimeRevision: escalated.runtimeRevision,
			stateHash: null,
			inputHash: null,
			outputHash: null,
			timestamp: new Date().toISOString(),
			causalId: `${fixture.runId}:rollback`,
			payload: {},
		});
		const originalInsert = fixture.store.insertLearningOutboxRow;
		fixture.store.insertLearningOutboxRow = () => {
			throw new Error('injected outbox failure');
		};
		assert.throws(
			() =>
				fixture.store.saveResumeFromEscalation({
					expectedRevision: escalated.runtimeRevision,
					nextState: {
						...escalated,
						state: 'SNAPSHOT_GENERATION',
						runtimeRevision: escalated.runtimeRevision + 1,
						activeGeneration: 1,
						updatedAt: new Date().toISOString(),
					},
					event: {
						eventId: 'evt-rollback-resume',
						eventType: 'RESUME_FROM_ESCALATION',
						runId: fixture.runId,
						runtimeRevision: escalated.runtimeRevision + 1,
						stateHash: null,
						inputHash: null,
						outputHash: null,
						timestamp: new Date().toISOString(),
						causalId: `${fixture.runId}:resume`,
						payload: {},
					},
					candidateLearning: {
						runId: fixture.runId,
						generation: 1,
						stage: 'operator.post_mortem',
						sourceRole: 'operator',
						type: 'pitfall',
						key: 'rollback-learning',
						scope: 'repo',
						query: 'rollback',
						insight: 'This should roll back.',
						confidence: 10,
					},
				}),
			/injected outbox failure/,
		);
		fixture.store.insertLearningOutboxRow = originalInsert;
		assert.equal(fixture.store.getRun(fixture.runId).state, 'ESCALATED');
		assert.equal(fixture.store.listCandidateLearnings(fixture.runId).length, 0);
		assert.equal(fixture.store.listPendingLearningOutbox(fixture.runId).length, 0);
		assert.equal(
			fixture.store.listEvents(fixture.runId).some((event) => event.eventId === 'evt-rollback-resume'),
			false,
		);
	} finally {
		fixture.close();
	}
});

test('fresh store records schema version 13 and rolls a failed transaction back', () => {
	const fixture = makeFixture('schema-rollback');
	try {
		assert.equal(fixture.store.database.prepare('SELECT max(version) AS version FROM schema_migrations').get().version, 13);
		fixture.runtime.initialize({ runId: fixture.runId, goal: 'rollback marker' });
		const event = createEvent({
			eventType: 'RUN_BLOCKED',
			runId: fixture.runId,
			runtimeRevision: 0,
			causalId: 'rollback-marker',
			payload: { marker: true },
		});
		const before = fixture.store.database.prepare('SELECT count(*) AS count FROM events').get().count;
		assert.throws(() => fixture.store.transaction(() => {
			fixture.store.insertEvent(event);
			throw new Error('rollback marker');
		}), /rollback marker/);
		assert.equal(fixture.store.database.prepare('SELECT count(*) AS count FROM events').get().count, before);
		assert.equal(fixture.store.getEvent(event.eventId), null);
	} finally {
		fixture.close();
	}
});

test('@ac AC-04 @case AC-04.1 resolving a still-pending interrupt rolls the transition back', () => {
	const fixture = makeFixture('stale-resolve');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'stale resolve' });
		fixture.store.createInterrupt({
			interruptId: 'interrupt-pending',
			runId: fixture.runId,
			kind: 'approval',
			stateHash: 'pending-state',
			requestArtifact: initial.goalArtifact,
			createdAt: new Date().toISOString(),
		});
		const revision = fixture.store.getRun(fixture.runId).runtimeRevision;
		const eventsBefore = fixture.store.database.prepare('SELECT count(*) AS count FROM events').get().count;
		const outboxBefore = fixture.store.database.prepare('SELECT count(*) AS count FROM projection_outbox').get().count;
		assert.throws(
			() => fixture.store.saveTransition(
				revision,
				{ ...initial, runtimeRevision: revision + 1, updatedAt: new Date().toISOString() },
				createEvent({
					eventType: 'RUN_BLOCKED',
					runId: fixture.runId,
					runtimeRevision: revision + 1,
					causalId: 'stale-resolve',
					payload: {},
				}),
				{ resolveInterruptId: 'interrupt-pending' },
			),
			(error) => error instanceof SdlcError
				&& error.code === 'STALE_RESPONSE'
				&& error.message === 'Interrupt response was not durably recorded',
		);
		assert.equal(fixture.store.getRun(fixture.runId).runtimeRevision, revision);
		assert.equal(fixture.store.database.prepare('SELECT count(*) AS count FROM events').get().count, eventsBefore);
		assert.equal(fixture.store.database.prepare('SELECT count(*) AS count FROM projection_outbox').get().count, outboxBefore);
	} finally {
		fixture.close();
	}
});

test('@ac AC-04 @case AC-04.2 a rejected candidate learning leaves the resume unwritten', () => {
	const fixture = makeFixture('resume-invalid-candidate');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'invalid candidate' });
		const escalated = fixture.store.saveTransition(initial.runtimeRevision, {
			...initial,
			state: 'ESCALATED',
			runtimeRevision: initial.runtimeRevision + 1,
			updatedAt: new Date().toISOString(),
		}, createEvent({
			eventType: 'RUN_BLOCKED',
			runId: fixture.runId,
			runtimeRevision: initial.runtimeRevision + 1,
			causalId: 'escalate-invalid',
			payload: {},
		}));
		const eventsBefore = fixture.store.database.prepare('SELECT count(*) AS count FROM events').get().count;
		const candidatesBefore = fixture.store.database.prepare('SELECT count(*) AS count FROM candidate_learnings').get().count;
		const outboxBefore = fixture.store.database.prepare('SELECT count(*) AS count FROM learning_outbox').get().count;
		assert.throws(() => fixture.store.saveResumeFromEscalation({
			expectedRevision: escalated.runtimeRevision,
			nextState: {
				...escalated,
				state: 'SNAPSHOT_GENERATION',
				runtimeRevision: escalated.runtimeRevision + 1,
				activeGeneration: 1,
				updatedAt: new Date().toISOString(),
			},
			event: createEvent({
				eventType: 'RESUME_FROM_ESCALATION',
				runId: fixture.runId,
				runtimeRevision: escalated.runtimeRevision + 1,
				causalId: 'resume-invalid',
				payload: {},
			}),
			candidateLearning: {
				runId: fixture.runId,
				generation: 1,
				stage: 'operator.post_mortem',
				sourceRole: 'operator',
				type: 'pitfall',
				key: 'null-insight',
				scope: 'repo',
				query: 'null insight',
				insight: null,
				confidence: 10,
			},
		}));
		assert.equal(fixture.store.getRun(fixture.runId).state, 'ESCALATED');
		assert.equal(fixture.store.database.prepare('SELECT count(*) AS count FROM events').get().count, eventsBefore);
		assert.equal(fixture.store.database.prepare('SELECT count(*) AS count FROM candidate_learnings').get().count, candidatesBefore);
		assert.equal(fixture.store.database.prepare('SELECT count(*) AS count FROM learning_outbox').get().count, outboxBefore);
	} finally {
		fixture.close();
	}
});

test('@ac AC-04 @case AC-04.3 initializing an existing run leaves events and the projection outbox unchanged', () => {
	const fixture = makeFixture('duplicate-initialize');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'duplicate initialize' });
		const eventsBefore = fixture.store.database.prepare('SELECT count(*) AS count FROM events').get().count;
		const outboxBefore = fixture.store.database.prepare('SELECT count(*) AS count FROM projection_outbox').get().count;
		assert.throws(() => fixture.store.initializeRun(
			{ ...initial, runtimeRevision: 0 },
			createEvent({
				eventType: 'RUN_BLOCKED',
				runId: fixture.runId,
				runtimeRevision: 0,
				causalId: 'duplicate-initialize',
				payload: {},
			}),
		));
		assert.equal(fixture.store.database.prepare('SELECT count(*) AS count FROM events').get().count, eventsBefore);
		assert.equal(fixture.store.database.prepare('SELECT count(*) AS count FROM projection_outbox').get().count, outboxBefore);
	} finally {
		fixture.close();
	}
});
