import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../cli.ts';
import { REPOSITORY_ROOT, createRuntimeDirectory, resolveRunPaths } from '../../persistence/run-paths.ts';
import { RuntimeStore } from '../../persistence/runtime-store.ts';
import { RoleRegistry } from '../../roles/role-registry.ts';
import { ArtifactStore } from '../../persistence/artifacts.ts';
import { SdlcWorkflowRuntime } from '../../workflow/graph.ts';
import { createEvent, emptyDraft } from '../../policy/contracts.ts';
import { specificationHash } from '../../workflow/specification.ts';
import { estimatePromptTokens } from '@evelbulgroz/model-usage-govenor/tokenizer';
import { SdlcError } from '../../policy/errors.ts';
import { FakeModelGovernor } from '../../testing/fake-model-governor.mjs';
import { slug, cleanupRun, checkpointState } from '../../testing/cli-test-support.mjs';

test('CLI resumes a reviewer prompt-budget denial from the next materialized generation', async () => {
	const testSlug = slug('resume-reviewer-budget');
	const runId = `${new Date().toISOString().slice(0, 10)}-${testSlug}`;
	fs.mkdirSync(path.join(REPOSITORY_ROOT, 'docs/specs/runs', runId), { recursive: true });
	createRuntimeDirectory(runId, REPOSITORY_ROOT);
	const paths = resolveRunPaths(runId, REPOSITORY_ROOT);
	const worktreeDir = path.join(paths.runtimeDir, 'worktrees/integration');
	const baseCommitSha = '1'.repeat(40);
	const targetTreeSha = '2'.repeat(40);
	const draft = {
		...emptyDraft('Add a ValueObject base class.'),
		acceptanceCriteria: ['AC-01: Equal primitive props compare equal.'],
	};
	const approvedSpecHash = specificationHash(draft);

	let store;
	try {
		fs.mkdirSync(paths.artifactsDir, { recursive: true });
		fs.mkdirSync(path.join(worktreeDir, 'packages/ddd-base'), { recursive: true });
		store = new RuntimeStore(paths.databasePath);
		const registry = new RoleRegistry({ rootDir: REPOSITORY_ROOT });
		const loaded = registry.load();
		const artifacts = new ArtifactStore({
			artifactsDir: paths.artifactsDir,
			runtimeStore: store,
			maxArtifactBytes: loaded.workflow.limits.maxArtifactBytes,
		});
		const denied = new SdlcError(
			'GOVERNOR_BUDGET_DENIED',
			'Prompt exceeds the reviewer token limit',
			{
				dimension: 'maxPromptTokens',
				operationId: `${runId}:reviewer:g2`,
			},
		);
		const governor = new FakeModelGovernor([denied]);
		const runtime = new SdlcWorkflowRuntime({
			runtimeStore: store,
			artifactStore: artifacts,
			registry,
			governor,
		});
		const initial = runtime.initialize({ runId, goal: 'Test reviewer prompt-budget recovery' });
		const draftArtifact = artifacts.writeJson('draft', draft);
		const failedState = {
			...initial,
			state: 'FAILED',
			runtimeRevision: initial.runtimeRevision + 1,
			lastError: { code: 'GOVERNOR_BUDGET_DENIED', message: 'Reviewer prompt denied' },
			updatedAt: new Date().toISOString(),
		};
		store.saveTransition(
			initial.runtimeRevision,
			failedState,
			createEvent({
				eventType: 'RUN_FAILED',
				runId,
				runtimeRevision: failedState.runtimeRevision,
				state: failedState,
				input: initial,
				output: { reason: 'GOVERNOR_BUDGET_DENIED' },
				causalId: `${runId}:seed-failed`,
				payload: { reason: 'GOVERNOR_BUDGET_DENIED' },
			}),
		);
		const budgetState = {
			...failedState,
			state: 'BUDGET_EXHAUSTED',
			runtimeRevision: failedState.runtimeRevision + 1,
			activeGeneration: 1,
			approvedSpecHash,
			draftHash: approvedSpecHash,
			draftArtifact,
			taskPlanHash: 'a'.repeat(64),
			taskPlanFrozen: true,
			targetTreeSha,
			integrationWorktreePath: worktreeDir,
			blockedReason: 'GOVERNOR_BUDGET_DENIED',
			lastError: {
				code: 'GOVERNOR_BUDGET_DENIED',
				message: 'Reviewer prompt exceeds budget',
				metadata: {
					dimension: 'maxPromptTokens',
					operationId: `${runId}:reviewer:g1`,
				},
			},
			updatedAt: new Date().toISOString(),
		};
		store.saveTransition(
			failedState.runtimeRevision,
			budgetState,
			createEvent({
				eventType: 'RUN_BLOCKED',
				runId,
				runtimeRevision: budgetState.runtimeRevision,
				state: budgetState,
				input: failedState,
				output: { reason: 'GOVERNOR_BUDGET_DENIED' },
				causalId: `${runId}:seed-budget-exhausted`,
				payload: { reason: 'GOVERNOR_BUDGET_DENIED' },
			}),
		);
		await checkpointState(runtime, budgetState);

		store.saveAuthorization({
			schemaVersion: '1.0.0',
			runId,
			approvedSpecHash,
			approvedPlanPolicyHash: 'c'.repeat(64),
			repositoryId: 'agent-sdlc',
			baseCommitSha,
			allowedPackages: ['packages/ddd-base'],
			allowedPathPrefixes: ['packages/ddd-base/'],
			allowedOperations: {
				editIsolatedWorktree: true,
				runAllowlistedCommands: true,
				createDetachedWorktree: true,
				createBranch: false,
				createLocalCommits: false,
				push: false,
				openPullRequest: false,
			},
			maxSemanticRepairs: 2,
			modelUsageProfile: 'agent-sdlc-default',
			approvedAt: new Date().toISOString(),
			approvalMethod: 'cli_prompt',
			expiresAt: new Date(Date.now() + 86400000).toISOString(),
		});
		store.saveTaskPlan({
			schemaVersion: '1.0.0',
			runId,
			createdAt: new Date().toISOString(),
			planPolicyHash: 'a'.repeat(64),
			baseCommitSha,
			integrationOrder: ['ddd-base'],
			isParallel: false,
			tasks: [
				{
					taskId: 'ddd-base',
					title: 'ValueObject base',
					targetPackage: 'packages/ddd-base',
					pathPrefixes: ['packages/ddd-base/'],
					dependsOn: [],
					status: 'completed',
					targetTreeSha,
					integrationOrder: 0,
					worktreeSubdir: 'worktrees/ddd-base',
					baseCommitSha,
				},
			],
		});
		store.saveGeneration({
			schemaVersion: '1.0.0',
			runId,
			generation: 1,
			baseCommitSha,
			targetTreeSha,
			scopeFingerprints: { 'packages/ddd-base': 'd'.repeat(64) },
			taskOwnedPaths: ['packages/ddd-base/**'],
			materializedAt: new Date().toISOString(),
		});
		store.close();
		store = null;

		const mockGit = (cmd, args, opts) => {
			if (args[0] === 'read-tree' || args[0] === 'add') return '';
			if (args[0] === 'write-tree') return targetTreeSha;
			if (args[0] === 'diff-tree' || args[0] === 'status' || args[0] === 'diff') return '';
			return execFileSync(cmd, args, opts);
		};
		const resumed = await runCli(['resume', '--run', runId, '--json'], {
			rootDir: REPOSITORY_ROOT,
			governor,
			gitCli: mockGit,
		});
		const checkStore = new RuntimeStore(paths.databasePath);
		try {
			assert.equal(
				resumed.exitCode,
				3,
				JSON.stringify(resumed.result),
			);
			assert.equal(governor.calls.length, 1);
			assert.equal(governor.calls[0].operationId, `${runId}:reviewer:g2`);
			assert.ok(
				estimatePromptTokens({
					prompt: governor.calls[0].prompt,
					structuredOutputSchema: governor.calls[0].structuredOutputSchema,
					routeFraming: '',
				}).promptTokens <= 12000,
			);
			assert.equal(checkStore.getRun(runId).state, 'BUDGET_EXHAUSTED');
			assert.equal(checkStore.getRun(runId).activeGeneration, 2);
			assert.deepEqual(
				checkStore.getTaskPlan(runId).tasks.map((task) => task.status),
				['completed'],
			);
			assert.deepEqual(
				checkStore.reconcile(runId).generations.map((generation) => generation.generation),
				[1, 2],
			);
		} finally {
			checkStore.close();
		}
	} finally {
		if (store) store.close();
		cleanupRun(runId);
	}
});
