import assert from 'node:assert/strict';
import test from 'node:test';

import { createGenerationRecords } from './generation-records.ts';
import { makeFixture } from '../testing/test-support.mjs';

test('runtime store persists and retrieves authorizations, generations, tool executions, and repair counts', () => {
	const fixture = makeFixture('store-v3', []);
	try {
		const initial = fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Slice 2 store test',
		});
		assert.equal(initial.state, 'SPEC_DRAFTING');

		// 1. Authorization
		assert.equal(fixture.store.hasAuthorization(fixture.runId), false);
		assert.equal(fixture.store.getAuthorization(fixture.runId), null);

		const auth = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			approvedSpecHash: 'a'.repeat(64),
			approvedPlanPolicyHash: 'b'.repeat(64),
			repositoryId: 'agent-sdlc',
			baseCommitSha: 'c'.repeat(40),
			allowedPackages: ['apps/services/conditioning'],
			allowedPathPrefixes: ['apps/services/conditioning/src/'],
			allowedOperations: {
				editIsolatedWorktree: true,
				runAllowlistedCommands: true,
				createDetachedWorktree: true,
				createBranch: false,
				createLocalCommits: false,
				push: false,
			},
			maxSemanticRepairs: 2,
			modelUsageProfile: 'agent-sdlc-default',
			expiresAt: new Date(Date.now() + 86400000).toISOString(),
			approvedAt: new Date().toISOString(),
			approvalMethod: 'cli_prompt',
		};

		fixture.store.saveAuthorization(auth);
		assert.equal(fixture.store.hasAuthorization(fixture.runId), true);
		const savedAuth = fixture.store.getAuthorization(fixture.runId);
		assert.equal(savedAuth.runId, fixture.runId);
		assert.equal(savedAuth.maxSemanticRepairs, 2);
		assert.deepEqual(savedAuth.allowedPackages, ['apps/services/conditioning']);

		// 2. Generations
		assert.equal(fixture.store.getGeneration(fixture.runId, 0), null);
		assert.equal(fixture.store.getLatestGeneration(fixture.runId), null);

		const gen0 = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			generation: 0,
			baseCommitSha: 'c'.repeat(40),
			targetTreeSha: 'd'.repeat(40),
			scopeFingerprints: { 'apps/services/conditioning': 'e'.repeat(64) },
			taskOwnedPaths: ['apps/services/conditioning/**'],
			materializedAt: new Date().toISOString(),
		};
		fixture.store.saveGeneration(gen0);

		const fetchedGen0 = fixture.store.getGeneration(fixture.runId, 0);
		assert.equal(fetchedGen0.generation, 0);
		assert.equal(fetchedGen0.targetTreeSha, 'd'.repeat(40));
		assert.equal(fixture.store.getLatestGeneration(fixture.runId).generation, 0);

		const gen1 = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			generation: 1,
			baseCommitSha: 'c'.repeat(40),
			targetTreeSha: 'f'.repeat(40),
			scopeFingerprints: { 'apps/services/conditioning': '1'.repeat(64) },
			taskOwnedPaths: ['apps/services/conditioning/**'],
			materializedAt: new Date().toISOString(),
		};
		fixture.store.saveGeneration(gen1);
		assert.equal(fixture.store.getLatestGeneration(fixture.runId).generation, 1);
		assert.equal(fixture.store.listGenerations(fixture.runId).length, 2);

		// 3. Tool executions
		const tool1 = {
			schemaVersion: '1.0.0',
			executionId: 'exec-1',
			runId: fixture.runId,
			roleId: 'implementer',
			generation: 0,
			stepIndex: 0,
			toolName: 'read_file',
			inputHash: '2'.repeat(64),
			outputArtifact: null,
			exitCode: 0,
			createdAt: new Date().toISOString(),
		};
		fixture.store.recordToolExecution(tool1);
		const fetchedTool = fixture.store.getToolExecution('exec-1');
		assert.equal(fetchedTool.toolName, 'read_file');
		assert.equal(fixture.store.listToolExecutions(fixture.runId).length, 1);
		assert.equal(fixture.store.listToolExecutions(fixture.runId, 0).length, 1);
		assert.equal(fixture.store.listToolExecutions(fixture.runId, 1).length, 0);

		// 4. Semantic repair counts
		assert.equal(fixture.store.getSemanticRepairsCount(fixture.runId), 0);
		const newCount = fixture.store.incrementSemanticRepairs(fixture.runId);
		assert.equal(newCount, 1);
		assert.equal(fixture.store.getSemanticRepairsCount(fixture.runId), 1);
		fixture.store.incrementSemanticRepairs(fixture.runId);
		assert.equal(fixture.store.getSemanticRepairsCount(fixture.runId), 2);
	} finally {
		fixture.close();
	}
});

test('getMaxRecordedGeneration returns highest generation across tables or -1 when empty', () => {
	const fixture = makeFixture('store-max-gen', []);
	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Test max generation',
		});

		// Empty store returns -1
		assert.equal(fixture.store.getMaxRecordedGeneration(fixture.runId), -1);

		// Record tool execution at generation 1
		fixture.store.recordToolExecution({
			schemaVersion: '1.0.0',
			executionId: 'exec-1',
			runId: fixture.runId,
			taskId: 'task-0',
			roleId: 'implementer',
			generation: 1,
			stepIndex: 0,
			toolName: 'write_file',
			inputHash: '0'.repeat(64),
			outputArtifact: null,
			exitCode: 0,
			createdAt: new Date().toISOString(),
		});
		assert.equal(fixture.store.getMaxRecordedGeneration(fixture.runId), 1);

		// Record tool execution at generation 3
		fixture.store.recordToolExecution({
			schemaVersion: '1.0.0',
			executionId: 'exec-2',
			runId: fixture.runId,
			taskId: 'task-0',
			roleId: 'repairer',
			generation: 3,
			stepIndex: 1,
			toolName: 'replace_in_file',
			inputHash: '1'.repeat(64),
			outputArtifact: null,
			exitCode: 0,
			createdAt: new Date().toISOString(),
		});
		assert.equal(fixture.store.getMaxRecordedGeneration(fixture.runId), 3);
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

test('generation records read an empty history directly', () => {
	const fixture = makeFixture('generation-direct');
	try {
		fixture.runtime.initialize({ runId: fixture.runId, goal: 'direct generation records' });
		const records = createGenerationRecords(recordContext(fixture.store));
		assert.equal(records.getMaxRecordedGeneration(fixture.runId), -1);
		assert.equal(records.getGeneration(fixture.runId, 0), null);
		assert.deepEqual(records.listGenerations(fixture.runId), []);
	} finally {
		fixture.close();
	}
});
