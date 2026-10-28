import assert from 'node:assert/strict';
import test from 'node:test';
import { makeFixture } from '../../testing/test-support.mjs';
import {
	createCheckCompletenessNode,
	createPrepareModelRequestNode,
	createExecuteConfiguredRoleNode,
	createApplyModelPatchNode,
} from './spec-draft.ts';

test('createCheckCompletenessNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createCheckCompletenessNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createCheckCompletenessNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createCheckCompletenessNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});

test('createPrepareModelRequestNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createPrepareModelRequestNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createPrepareModelRequestNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createPrepareModelRequestNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});

test('createExecuteConfiguredRoleNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createExecuteConfiguredRoleNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createExecuteConfiguredRoleNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createExecuteConfiguredRoleNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});

test('createApplyModelPatchNode returns the stored snapshot when the run already advanced', async () => {
	const fixture = makeFixture('createApplyModelPatchNode');
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'createApplyModelPatchNode' });
		assert.ok(initial.runtimeRevision > 0);
		const result = await createApplyModelPatchNode(fixture.runtime)({
			snapshot: { ...initial, runtimeRevision: 0 },
		});
		assert.equal(result.snapshot.runId, fixture.runId);
		assert.equal(result.snapshot.state, initial.state);
		assert.ok(result.snapshot.runtimeRevision > 0);
	} finally {
		fixture.close();
	}
});

test('createApplyModelPatchNode preserves task-manifest bound AC-NN IDs when model proposal appends extra AC IDs', async () => {
	const fixture = makeFixture('createApplyModelPatchNode-bound-ac');
	try {
		const initial = fixture.runtime.initialize({
			runId: fixture.runId,
			goal: '# Intent\n\n## Goal\nClamp meters.\n\n## Non-goals\n- None.\n\n## Owning context\napps/services/conditioning\n\n## Touched surfaces\n- apps/services/conditioning/src/foo.ts\n\n## Invariants and constraints\n- Pure helper.\n\n## Public contract impact\nNone.\n\n## Acceptance criteria\n1. AC-01: Negative clamps to 0. Given -1. Then returns 0.\n2. AC-02: Positive unchanged. Given 2. Then returns 2.\n\n## Failure defenses\n- Throw TypeError on NaN.\n\n## Verification plan\n- Unit tests.\n',
			taskManifest: {
				schemaVersion: '1.0.0',
				slices: [
					{
						sliceId: 's1',
						kind: 'vertical',
						goal: 'Clamp meters',
						acceptanceCriteria: ['AC-01', 'AC-02'],
						dependsOn: [],
					},
				],
				tasks: [
					{
						taskId: 't1',
						sliceId: 's1',
						targetPackage: 'apps/services/conditioning',
						deliveryLayers: ['domain'],
						pathPrefixes: ['apps/services/conditioning/src/foo.ts'],
						authoredPaths: ['apps/services/conditioning/src/foo.ts'],
						dependsOn: [],
						verificationCommand: ['pnpm', '--filter', '@fitness-app/conditioning-service', 'test'],
						generatorCommand: null,
						generatedOutputs: [],
						dependencyMutations: [],
						shadowPaths: {
							unhappy: 'NaN throws',
							empty: 'null throws',
							timeout: 'sync',
							boundary: '0 returns 0',
						},
					},
				],
			},
		});
		const proposalArtifact = fixture.runtime.artifactStore.writeJson('proposal', {
			patch: [
				{
					field: 'acceptanceCriteria',
					operation: 'append',
					value: ['AC-03: NaN throws. Given NaN. Then throws TypeError.'],
				},
			],
			questions: [],
		});
		const withProposal = { ...initial, activeProposalArtifact: proposalArtifact };
		const result = await createApplyModelPatchNode(fixture.runtime)({ snapshot: withProposal });
		const revised = fixture.runtime.artifactStore.readJson(result.snapshot.draftArtifact);
		assert.equal(revised.acceptanceCriteria.length, 2);
		assert.ok(revised.acceptanceCriteria[0].startsWith('AC-01:'));
		assert.ok(revised.acceptanceCriteria[1].startsWith('AC-02:'));
	} finally {
		fixture.close();
	}
});
