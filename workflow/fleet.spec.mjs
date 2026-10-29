import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { RuntimeStore } from '../persistence/runtime-store.ts';
import { createEvent } from '../policy/contracts.ts';
import { readFleetFrictionSummary } from './fleet.ts';

test('readFleetFrictionSummary calculates fleet-wide unreviewed friction and stale recommendations', () => {
	const tempRoot = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`fleet-summary-${crypto.randomUUID()}`,
	);
	fs.mkdirSync(path.join(tempRoot, '.agent-sdlc'), { recursive: true });
	fs.mkdirSync(path.join(tempRoot, '.agents/trace-findings'), { recursive: true });

	try {
		// Run 1: has friction, unanalyzed
		const run1Id = '2026-09-01-fleet-run-1';
		const run1Dir = path.join(tempRoot, '.agent-sdlc', run1Id);
		fs.mkdirSync(run1Dir, { recursive: true });
		const store1 = new RuntimeStore(path.join(run1Dir, 'runtime.sqlite'));
		store1.database.prepare(`
			INSERT INTO runs (
				run_id, thread_id, runtime_revision, state, state_hash,
				state_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			run1Id, 'thread-run-1', 1, 'READY_FOR_GIT_APPROVAL', 'hash1', '{}',
			new Date().toISOString(), new Date().toISOString()
		);
		store1.appendEvent(
			createEvent({
				eventType: 'PROMPT_FRICTION_DETECTED',
				runId: run1Id,
				runtimeRevision: 1,
				causalId: 'c1',
				payload: {},
			}),
		);
		store1.insertPromptFrictionFinding({
			runId: run1Id,
			roleId: 'repairer',
			signalType: 'churn_failure',
			category: 'typeorm-runner-leak',
			findingKey: '[repairer] churn_failure:typeorm-runner-leak',
			status: 'PROVISIONAL',
			attributionLayer: 'layer3',
			evidence: {},
		});
		store1.close();

		// Run 2: has friction, analyzed
		const run2Id = '2026-09-02-fleet-run-2';
		const run2Dir = path.join(tempRoot, '.agent-sdlc', run2Id);
		fs.mkdirSync(run2Dir, { recursive: true });
		const store2 = new RuntimeStore(path.join(run2Dir, 'runtime.sqlite'));
		store2.database.prepare(`
			INSERT INTO runs (
				run_id, thread_id, runtime_revision, state, state_hash,
				state_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			run2Id, 'thread-run-2', 1, 'READY_FOR_GIT_APPROVAL', 'hash2', '{}',
			new Date().toISOString(), new Date().toISOString()
		);
		store2.appendEvent(
			createEvent({
				eventType: 'PROMPT_FRICTION_DETECTED',
				runId: run2Id,
				runtimeRevision: 1,
				causalId: 'c2',
				payload: {},
			}),
		);
		store2.recordFrictionAnalyzed({
			runId: run2Id,
			findings: [
				{
					roleId: 'repairer',
					signalType: 'churn_failure',
					category: 'typeorm-runner-leak',
					findingKey: '[repairer] churn_failure:typeorm-runner-leak',
					status: 'PROVISIONAL',
					attributionLayer: 'layer3',
					evidence: {},
				},
			],
		});
		store2.close();

		// Committed artifact for Run 3: gives 3rd run for the key [repairer] churn_failure:typeorm-runner-leak
		const run3Id = '2026-09-03-fleet-run-3';
		fs.writeFileSync(
			path.join(tempRoot, `.agents/trace-findings/${run3Id}.json`),
			JSON.stringify({
				schemaVersion: '1.0.0',
				runId: run3Id,
				analyzedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days ago (stale!)
				findings: [
					{
						findingId: 'find-3',
						roleId: 'repairer',
						signalType: 'churn_failure',
						category: 'typeorm-runner-leak',
						findingKey: '[repairer] churn_failure:typeorm-runner-leak',
						status: 'PROVISIONAL',
						attributionLayer: 'layer3',
						evidence: {},
					},
				],
			}),
		);

		const summary = readFleetFrictionSummary({ rootDir: tempRoot });
		assert.equal(summary.unreviewedFrictionCount, 1);
		assert.deepEqual(summary.unreviewedRunIds, [run1Id]);
		assert.ok(summary.recommendedKeys.includes('[repairer] churn_failure:typeorm-runner-leak'));
		assert.equal(summary.staleRecommendationsCount, 1);
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});
