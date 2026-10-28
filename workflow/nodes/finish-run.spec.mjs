import assert from 'node:assert/strict';
import test from 'node:test';
import {
	canonicalJson,
	sha256,
} from '../../policy/contracts.ts';
import { makeFixture } from '../../testing/test-support.mjs';
import { createFinalizeRunNode, createRepairFailureNode } from './finish-run.ts';

test('createRepairFailureNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('finish-repair-advanced');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'Repair short circuit' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createRepairFailureNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});

test('createFinalizeRunNode returns the snapshot unchanged outside a terminal state', async () => {
	const fixture = makeFixture('finish-finalize-early');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'Finalize early' });
		const snapshot = { ...initial, state: 'SPEC_DRAFTING' };
		const result = await createFinalizeRunNode(fixture.runtime)({ snapshot });
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, 'SPEC_DRAFTING');
	} finally {
		fixture.close();
	}
});

test('finalize_run ignores clean run and records zero friction events (AC-01)', async () => {
	const fixture = makeFixture('clean-finalize', []);
	try {
		const initial = fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Clean run',
		});
		const qaState = { ...initial, state: 'REVIEWING_QA' };
		fixture.store.database
			.prepare('UPDATE runs SET state = ?, state_json = ?, state_hash = ? WHERE run_id = ?')
			.run('REVIEWING_QA', canonicalJson(qaState), sha256(qaState), fixture.runId);

		const terminal = fixture.runtime.transition(qaState, {
			to: 'READY_FOR_GIT_APPROVAL',
			eventType: 'RUN_READY_FOR_GIT_APPROVAL',
			causalId: 'test-ready',
			updates: {},
			payload: {},
		});

		const result = await fixture.runtime.graph.invoke(
			{ snapshot: terminal },
			{ configurable: { thread_id: fixture.runId } },
		);

		assert.equal(result.snapshot.state, 'READY_FOR_GIT_APPROVAL');
		assert.equal(result.snapshot.runtimeRevision, terminal.runtimeRevision);
		const frictionEvents = fixture.store
			.listEvents(fixture.runId)
			.filter((e) => e.eventType === 'PROMPT_FRICTION_DETECTED');
		assert.equal(frictionEvents.length, 0);
		assert.equal(fixture.store.hasUnreviewedFriction(fixture.runId), false);
	} finally {
		fixture.close();
	}
});

test('finalize_run records PROMPT_FRICTION_DETECTED event on terminal self-edge when friction detected (AC-02)', async () => {
	const fixture = makeFixture('friction-finalize', []);
	try {
		const initial = fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Friction run',
		});
		const qaState = { ...initial, state: 'REVIEWING_QA' };
		fixture.store.database
			.prepare('UPDATE runs SET state = ?, state_json = ?, state_hash = ? WHERE run_id = ?')
			.run('REVIEWING_QA', canonicalJson(qaState), sha256(qaState), fixture.runId);

		fixture.store.recordToolExecution({
			schemaVersion: '1.0.0',
			executionId: 'exec-fail-1',
			runId: fixture.runId,
			roleId: 'implementer',
			generation: 0,
			stepIndex: 0,
			toolName: 'run_allowlisted_command',
			inputHash: '1'.repeat(64),
			outputArtifact: null,
			exitCode: 1,
			createdAt: new Date().toISOString(),
		});
		fixture.store.incrementSemanticRepairs(fixture.runId);

		const terminal = fixture.runtime.transition(qaState, {
			to: 'READY_FOR_GIT_APPROVAL',
			eventType: 'RUN_READY_FOR_GIT_APPROVAL',
			causalId: 'test-ready-friction',
			updates: { semanticRepairsCount: 1 },
			payload: {},
		});

		const result = await fixture.runtime.graph.invoke(
			{ snapshot: terminal },
			{ configurable: { thread_id: fixture.runId } },
		);

		assert.equal(result.snapshot.state, 'READY_FOR_GIT_APPROVAL');
		assert.equal(result.snapshot.runtimeRevision, terminal.runtimeRevision + 1);
		const frictionEvents = fixture.store
			.listEvents(fixture.runId)
			.filter((e) => e.eventType === 'PROMPT_FRICTION_DETECTED');
		assert.equal(frictionEvents.length, 1);
		assert.equal(frictionEvents[0].payload.repairs, 1);
		assert.equal(frictionEvents[0].payload.toolFailures, 1);
		assert.ok(frictionEvents[0].payload.advisory.includes('Trace friction detected'));
		assert.equal(fixture.store.hasUnreviewedFriction(fixture.runId), true);
	} finally {
		fixture.close();
	}
});

test('finalize_run ignores QA review with P1 OVERSPEC when no GAP or DIVERGENT exists', async () => {
	const fixture = makeFixture('overspec-finalize', []);
	try {
		const initial = fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Overspec QA run',
		});
		const qaState = { ...initial, state: 'REVIEWING_QA' };
		fixture.store.database
			.prepare('UPDATE runs SET state = ?, state_json = ?, state_hash = ? WHERE run_id = ?')
			.run('REVIEWING_QA', canonicalJson(qaState), sha256(qaState), fixture.runId);

		// Insert a QA critic review that has has_p1 = true, but findings are strictly OVERSPEC
		fixture.store.database
			.prepare(
				`INSERT INTO critic_reviews (
					review_id, run_id, generation, phase, artifact_hash, attempt_key,
					reviewer_vendor, reviewer_model, manifest_path, findings_count, has_p1, reviewed_at,
					findings_json, report_artifact
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				'rev-overspec-1',
				fixture.runId,
				0,
				'qa',
				'hash-overspec-1',
				'attempt-1',
				'google-gemini',
				'gemini-2.5-flash',
				'manifest.json',
				1,
				1,
				new Date().toISOString(),
				JSON.stringify([
					{
						severity: 'P1',
						ruleId: 'QA_SPEC',
						message: 'Asserts forbidden field',
						evidence: 'OVERSPEC: test.spec.ts:30',
					},
				]),
				null,
			);

		const terminal = fixture.runtime.transition(qaState, {
			to: 'READY_FOR_GIT_APPROVAL',
			eventType: 'RUN_READY_FOR_GIT_APPROVAL',
			causalId: 'test-ready-overspec',
			updates: {},
			payload: {},
		});

		const result = await fixture.runtime.graph.invoke(
			{ snapshot: terminal },
			{ configurable: { thread_id: fixture.runId } },
		);

		assert.equal(result.snapshot.state, 'READY_FOR_GIT_APPROVAL');
		assert.equal(result.snapshot.runtimeRevision, terminal.runtimeRevision);
		const frictionEvents = fixture.store
			.listEvents(fixture.runId)
			.filter((e) => e.eventType === 'PROMPT_FRICTION_DETECTED');
		// Must NOT record friction for P1 OVERSPEC
		assert.equal(frictionEvents.length, 0);
		assert.equal(fixture.store.hasUnreviewedFriction(fixture.runId), false);
	} finally {
		fixture.close();
	}
});
