import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT, createRuntimeDirectory, resolveRunPaths } from '../../persistence/run-paths.ts';
import { RuntimeStore } from '../../persistence/runtime-store.ts';
import { RoleRegistry } from '../../roles/role-registry.ts';
import { ArtifactStore } from '../../persistence/artifacts.ts';
import { SdlcWorkflowRuntime } from '../../workflow/graph.ts';
import { readBoundTaskManifest } from '../../workflow/nodes/planning.ts';
import { planTaskDag } from '../../policy/task-planner.ts';
import { approvedInputHash, taskManifestHash } from '../../workflow/specification.ts';
import { FakeModelGovernor } from '../../testing/fake-model-governor.mjs';
import { cleanupRun, completeSpecJson } from '../../testing/cli-test-support.mjs';

test('@ac AC-03 manifest initialization persists immutable hash-bound input', () => {
	const runId = `${new Date().toISOString().slice(0, 10)}-manifest-binding-${crypto.randomUUID().slice(0, 8)}`;
	fs.mkdirSync(path.join(REPOSITORY_ROOT, 'docs/specs/runs', runId), { recursive: true });
	let store;
	try {
		createRuntimeDirectory(runId, REPOSITORY_ROOT);
		const paths = resolveRunPaths(runId, REPOSITORY_ROOT);
		store = new RuntimeStore(paths.databasePath);
		const registry = new RoleRegistry({ rootDir: REPOSITORY_ROOT });
		const artifacts = new ArtifactStore({
			artifactsDir: paths.artifactsDir,
			runtimeStore: store,
			maxArtifactBytes: registry.load().workflow.limits.maxArtifactBytes,
		});
		const runtime = new SdlcWorkflowRuntime({
			runtimeStore: store,
			artifactStore: artifacts,
			registry,
			governor: new FakeModelGovernor([]),
		});
		const draft = completeSpecJson();
		const manifest = {
			schemaVersion: '1.0.0',
			slices: [
				{
					sliceId: 'behavior',
					kind: 'vertical',
					goal: 'Ship the slice',
					acceptanceCriteria: ['AC-01'],
					dependsOn: [],
				},
			],
			tasks: [
				{
					taskId: 'behavior-task',
					sliceId: 'behavior',
					targetPackage: 'tools',
					authoredPaths: ['tools/agent-sdlc/cli/cli.mjs'],
					pathPrefixes: ['tools/agent-sdlc/cli/cli.mjs'],
					generatedOutputs: [],
					dependsOn: [],
					deliveryLayers: ['tooling'],
					dependencyMutations: [],
					shadowPaths: {
						unhappy: 'invalid input',
						timeout: 'deadline exceeded',
						empty: 'no delta',
						boundary: 'scope escape',
					},
					verificationCommand: ['pnpm', 'run', 'agent:test-sdlc'],
					generatorCommand: null,
				},
			],
		};
		const manifestHash = taskManifestHash(manifest);
		const state = runtime.initialize({
			runId,
			goal: JSON.stringify(draft),
			taskManifest: manifest,
			expectedTaskManifestHash: manifestHash,
		});
		assert.equal(state.taskManifestHash, manifestHash);
		assert.deepEqual(artifacts.readJson(state.taskManifestArtifact), manifest);
		assert.equal(state.draftHash, approvedInputHash(draft, manifestHash));
		const plan = planTaskDag({
			draft,
			taskManifest: manifest,
			authorization: {
				runId,
				baseCommitSha: 'a'.repeat(40),
				taskManifestHash: manifestHash,
				allowedPackages: ['tools'],
				allowedPathPrefixes: ['tools/agent-sdlc/cli/cli.mjs'],
			},
			now: () => '2026-09-29T00:00:00.000Z',
		});
		assert.equal(plan.taskManifestHash, manifestHash);
		assert.throws(
			() =>
				runtime.initialize({
					runId: `${runId}-stale`,
					goal: JSON.stringify(draft),
					taskManifest: manifest,
					expectedTaskManifestHash: 'a'.repeat(64),
				}),
			(error) => error.code === 'INVALID_CONTRACT',
		);

		const artifactPath = path.join(
			paths.artifactsDir,
			`${state.taskManifestArtifact}.json`,
		);
		fs.writeFileSync(artifactPath, `${JSON.stringify({ ...manifest, tasks: [] })}\n`);
		assert.throws(
			() => readBoundTaskManifest(runtime, state),
			(error) =>
				error.code === 'INVALID_CONTRACT' &&
				/Persisted task manifest bytes/.test(error.message),
		);
	} finally {
		store?.close();
		cleanupRun(runId);
	}
});
