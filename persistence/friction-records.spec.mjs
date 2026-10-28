import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeStore } from './runtime-store.ts';
import { createRunLedger } from './run-ledger.ts';
import { createFrictionRecords } from './friction-records.ts';
import { makeFixture } from '../testing/test-support.mjs';
import { createEvent } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';

test('RuntimeStore persists, updates, and lists prompt friction findings idempotently', () => {
	const fixture = makeFixture('friction-findings', []);
	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Test prompt friction findings',
		});
		const finding = {
			findingId: 'find-test-1',
			runId: fixture.runId,
			roleId: 'repairer',
			signalType: 'churn_failure',
			category: 'typeorm-runner-leak',
			findingKey: '[repairer] churn_failure:typeorm-runner-leak',
			status: 'PROVISIONAL',
			attributionLayer: 'layer3',
			evidence: { repairAttempts: 2 },
			proposedDiff: null,
		};

		const inserted = fixture.store.insertPromptFrictionFinding(finding);
		assert.equal(inserted.findingId, 'find-test-1');
		assert.equal(inserted.runId, fixture.runId);
		assert.equal(inserted.status, 'PROVISIONAL');
		assert.equal(inserted.attributionLayer, 'layer3');

		const fetched = fixture.store.getPromptFrictionFinding(fixture.runId, finding.findingKey);
		assert.equal(fetched.findingKey, finding.findingKey);

		// Idempotent upsert: update status and proposed diff on conflict
		const updated = fixture.store.insertPromptFrictionFinding({
			...finding,
			status: 'RECOMMENDED',
			proposedDiff: 'diff --git a/test.md b/test.md',
		});
		assert.equal(updated.status, 'RECOMMENDED');
		assert.ok(updated.proposedDiffJson.includes('diff --git'));

		const all = fixture.store.listPromptFrictionFindings(fixture.runId);
		assert.equal(all.length, 1);
		assert.equal(all[0].status, 'RECOMMENDED');
	} finally {
		fixture.close();
	}
});

test('hasUnreviewedFriction and recordFrictionAnalyzed manage run friction lifecycle without revision bump', () => {
	const fixture = makeFixture('friction-lifecycle', []);
	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Test prompt friction lifecycle',
		});
		assert.equal(fixture.store.hasUnreviewedFriction(fixture.runId), false);

		// Append PROMPT_FRICTION_DETECTED event
		fixture.store.appendEvent(
			createEvent({
				eventType: 'PROMPT_FRICTION_DETECTED',
				runId: fixture.runId,
				runtimeRevision: fixture.store.getRun(fixture.runId).runtimeRevision,
				causalId: 'friction:1',
				payload: { repairs: 2, toolFailures: 1 },
			}),
		);
		assert.equal(fixture.store.hasUnreviewedFriction(fixture.runId), true);

		const beforeRev = fixture.store.getRun(fixture.runId).runtimeRevision;

		// Record friction analyzed
		const result = fixture.store.recordFrictionAnalyzed({
			runId: fixture.runId,
			findings: [
				{
					findingId: 'find-analyzed-1',
					roleId: 'implementer',
					signalType: 'tool_failure',
					category: 'script-missing',
					findingKey: '[implementer] tool_failure:script-missing',
					status: 'PROVISIONAL',
					attributionLayer: 'layer1',
					evidence: { script: 'test:unit' },
				},
			],
		});

		assert.equal(result.findings.length, 1);
		assert.equal(result.event.eventType, 'PROMPT_FRICTION_ANALYZED');
		assert.equal(fixture.store.hasUnreviewedFriction(fixture.runId), false);

		// Verify runtime revision is untouched (LangGraph checkpoint preserved)
		const afterRev = fixture.store.getRun(fixture.runId).runtimeRevision;
		assert.equal(afterRev, beforeRev);

		// Non-existent run throws RUN_NOT_FOUND (not TypeError)
		assert.throws(
			() => fixture.store.recordFrictionAnalyzed({ runId: 'non-existent-run', findings: [] }),
			(err) => err instanceof SdlcError && err.code === 'RUN_NOT_FOUND',
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

test('friction records leave the runtime revision unchanged when analysis is recorded directly', () => {
	const fixture = makeFixture('friction-direct');
	try {
		fixture.runtime.initialize({ runId: fixture.runId, goal: 'direct friction records' });
		const context = recordContext(fixture.store);
		const records = createFrictionRecords(context, createRunLedger(context));
		assert.equal(records.hasUnreviewedFriction(fixture.runId), false);
		const before = fixture.store.getRun(fixture.runId).runtimeRevision;
		records.recordFrictionAnalyzed({ runId: fixture.runId, findings: [] });
		assert.equal(fixture.store.getRun(fixture.runId).runtimeRevision, before);
		assert.equal(records.hasUnreviewedFriction(fixture.runId), false);
	} finally {
		fixture.close();
	}
});
