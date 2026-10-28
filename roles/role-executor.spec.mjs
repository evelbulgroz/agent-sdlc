import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FakeModelAdapter } from '@evelbulgroz/model-usage-govenor/adapters/fake';
import { ModelUsageError } from '@evelbulgroz/model-usage-govenor/errors';
import { executeOperation } from '@evelbulgroz/model-usage-govenor';
import {
	cleanupTestRoot,
	enabledFakePolicy,
	makeTestRoot,
	writePolicy,
} from '@evelbulgroz/model-usage-govenor/test-support';
import { selectRoutes } from '@evelbulgroz/model-usage-govenor/routing';
import { validatePolicy } from '@evelbulgroz/model-usage-govenor/policy';
import { RepositoryModelGovernor } from '../adapters/model-governor.ts';
import { SdlcError } from '../policy/errors.ts';
import { RoleExecutor } from './role-executor.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { completeProposal, makeFixture } from '../testing/test-support.mjs';

test('generic role executor validates synthetic output and reuses the operation ID', async () => {
	const fixture = makeFixture('role-success', [completeProposal()]);
	try {
		const state = fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Build the workflow',
		});
		const loaded = fixture.registry.load();
		const executor = new RoleExecutor({
			governor: fixture.governor,
			runtimeStore: fixture.store,
			artifactStore: fixture.artifacts,
		});
		const input = {
			runId: fixture.runId,
			role: loaded.role,
			roleHash: loaded.hashes.roleHash,
			promptPolicy: loaded.promptPolicy,
			draft: fixture.artifacts.readJson(state.draftArtifact),
			completeness: state.completeness,
			generation: 1,
			maxQuestions: loaded.workflow.limits.maxQuestionsPerBatch,
		};
		const first = await executor.execute(input);
		const replay = await executor.execute(input);
		assert.equal(first.synthetic, true);
		assert.equal(replay.replayed, true);
		assert.equal(fixture.governor.calls.length, 1);
		assert.equal(first.proposal.questions.length, 3);
	} finally {
		fixture.close();
	}
});

test('generic role executor permits questions targeting fields unresolved in incoming draft even if patched', async () => {
	const proposalWithBoth = {
		patch: [
			...completeProposal().patch,
			{
				field: 'acceptanceCriteria',
				operation: 'set',
				value: ['AC-01: An outcome. Given input. Then output.'],
			},
		],
		questions: [
			{
				questionId: 'q-ac',
				targets: ['acceptanceCriteria'],
				prompt: 'Are there any additional criteria?',
				responseKind: 'text',
				options: [],
				required: true,
				rationale: 'Clarify criteria',
			},
		],
	};
	const fixture = makeFixture('role-both-patch-and-question', [proposalWithBoth]);
	try {
		const state = fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Build the workflow',
		});
		const loaded = fixture.registry.load();
		const executor = new RoleExecutor({
			governor: fixture.governor,
			runtimeStore: fixture.store,
			artifactStore: fixture.artifacts,
		});
		const input = {
			runId: fixture.runId,
			role: loaded.role,
			roleHash: loaded.hashes.roleHash,
			promptPolicy: loaded.promptPolicy,
			draft: fixture.artifacts.readJson(state.draftArtifact),
			completeness: state.completeness,
			generation: 1,
			maxQuestions: loaded.workflow.limits.maxQuestionsPerBatch,
		};
		const result = await executor.execute(input);
		assert.equal(result.proposal.questions.length, 1);
		assert.equal(result.proposal.questions[0].targets[0], 'acceptanceCriteria');
	} finally {
		fixture.close();
	}
});

test('generic role executor allows empty questions when patch resolves all missing fields', async () => {
	const fullyResolvingProposal = {
		patch: [
			{ field: 'owningContext', operation: 'set', value: 'Tooling' },
			{ field: 'touchedSurfaces', operation: 'set', value: ['tools/foo.mjs'] },
			{ field: 'invariantsAndConstraints', operation: 'set', value: ['Invariant'] },
			{ field: 'publicContractImpact', operation: 'set', value: 'none' },
			{ field: 'acceptanceCriteria', operation: 'set', value: ['AC-01: A. Given B. Then C.'] },
			{ field: 'failureDefenses', operation: 'set', value: ['Defense'] },
			{ field: 'verificationPlan', operation: 'set', value: ['Plan'] },
			{ field: 'nonGoals', operation: 'set', value: ['NonGoal'] },
		],
		questions: [],
	};
	const fixture = makeFixture('role-fully-resolving-patch', [fullyResolvingProposal]);
	try {
		const state = fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Build the workflow',
		});
		const loaded = fixture.registry.load();
		const executor = new RoleExecutor({
			governor: fixture.governor,
			runtimeStore: fixture.store,
			artifactStore: fixture.artifacts,
		});
		const input = {
			runId: fixture.runId,
			role: loaded.role,
			roleHash: loaded.hashes.roleHash,
			promptPolicy: loaded.promptPolicy,
			draft: fixture.artifacts.readJson(state.draftArtifact),
			completeness: state.completeness,
			generation: 1,
			maxQuestions: loaded.workflow.limits.maxQuestionsPerBatch,
		};
		const result = await executor.execute(input);
		assert.equal(result.proposal.questions.length, 0);
	} finally {
		fixture.close();
	}
});

test('generic role executor rejects malformed output', async () => {
	const malformed = makeFixture('role-malformed', [{ patch: [], questions: [] }]);
	try {
		const state = malformed.runtime.initialize({
			runId: malformed.runId,
			goal: 'Build the workflow',
		});
		const loaded = malformed.registry.load();
		const executor = new RoleExecutor({
			governor: malformed.governor,
			runtimeStore: malformed.store,
			artifactStore: malformed.artifacts,
		});
		await assert.rejects(
			executor.execute({
				runId: malformed.runId,
				role: loaded.role,
				roleHash: loaded.hashes.roleHash,
				promptPolicy: loaded.promptPolicy,
				draft: malformed.artifacts.readJson(state.draftArtifact),
				completeness: state.completeness,
				generation: 1,
				maxQuestions: 5,
			}),
			/1-5 questions/,
		);
	} finally {
		malformed.close();
	}
});

test('generic role executor rejects incompatible patches and question targets before success', async () => {
	const cases = [
		{
			label: 'scalar-append',
			proposal: {
				...completeProposal(),
				patch: [{ field: 'owningContext', operation: 'append', value: 'Tooling' }],
			},
		},
		{
			label: 'resolved-target',
			proposal: {
				...completeProposal(),
				questions: completeProposal().questions.map((question, index) =>
					index === 0 ? { ...question, targets: ['acceptanceCriteria', 'goal'] } : question,
				),
			},
		},
		{
			label: 'response-kind',
			proposal: {
				...completeProposal(),
				patch: completeProposal().patch.filter(
					(operation) => operation.field !== 'publicContractImpact',
				),
				questions: [
					...completeProposal().questions,
					{
						questionId: 'contract-impact',
						targets: ['publicContractImpact'],
						prompt: 'Which contract impacts apply?',
						responseKind: 'multi_select',
						options: ['None', 'Internal'],
						required: true,
						rationale: 'Public contract impact is missing.',
					},
				],
			},
		},
		{
			label: 'secret-output',
			proposal: {
				...completeProposal(),
				questions: completeProposal().questions.map((question, index) =>
					index === 0
						? {
								...question,
								prompt: `Use Authorization: Bearer ${'z'.repeat(24)}`,
							}
						: question,
				),
			},
		},
		{
			label: 'google-credential-output',
			proposal: {
				...completeProposal(),
				questions: completeProposal().questions.map((question, index) =>
					index === 0
						? {
								...question,
								prompt: `Never project ${'AI'}${'za'}${'J'.repeat(35)}`,
							}
						: question,
				),
			},
		},
	];
	for (const { label, proposal } of cases) {
		const fixture = makeFixture(`role-incompatible-${label}`, [proposal]);
		try {
			const state = fixture.runtime.initialize({
				runId: fixture.runId,
				goal: 'Build the workflow',
			});
			const loaded = fixture.registry.load();
			const executor = new RoleExecutor({
				governor: fixture.governor,
				runtimeStore: fixture.store,
				artifactStore: fixture.artifacts,
			});
			const operationId = `${fixture.runId}:role:${loaded.hashes.roleHash.slice(0, 16)}:g1`;
			await assert.rejects(
				executor.execute({
					runId: fixture.runId,
					role: loaded.role,
					roleHash: loaded.hashes.roleHash,
					promptPolicy: loaded.promptPolicy,
					draft: fixture.artifacts.readJson(state.draftArtifact),
					completeness: state.completeness,
					generation: 1,
					maxQuestions: 5,
				}),
				(error) => error.code === 'INVALID_CONTRACT' || error.code === 'MODEL_OUTPUT_INVALID',
			);
			assert.equal(fixture.store.getModelOperation(operationId).status, 'failed');
		} finally {
			fixture.close();
		}
	}
});

test('role executor allows empty questions when completeness missingFields is empty', async () => {
	const proposal = { patch: [], questions: [] };
	const fixture = makeFixture('role-empty-questions', [proposal]);
	try {
		const state = fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Complete draft testing',
		});
		const loaded = fixture.registry.load();
		const executor = new RoleExecutor({
			governor: fixture.governor,
			runtimeStore: fixture.store,
			artifactStore: fixture.artifacts,
		});
		const result = await executor.execute({
			runId: fixture.runId,
			role: loaded.role,
			roleHash: loaded.hashes.roleHash,
			promptPolicy: loaded.promptPolicy,
			draft: fixture.artifacts.readJson(state.draftArtifact),
			completeness: { complete: true, missingFields: [], ambiguousFields: [] },
			generation: 1,
			maxQuestions: 5,
		});
		assert.equal(result.proposal.questions.length, 0);
	} finally {
		fixture.close();
	}
});
