import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../cli.ts';
import { REPOSITORY_ROOT, createRuntimeDirectory, resolveRunPaths } from '../../persistence/run-paths.ts';
import { RuntimeStore } from '../../persistence/runtime-store.ts';
import { RoleRegistry } from '../../roles/role-registry.ts';
import { ArtifactStore } from '../../persistence/artifacts.ts';
import { SdlcWorkflowRuntime } from '../../workflow/graph.ts';
import { createEvent } from '../../policy/contracts.ts';
import { FakeModelGovernor } from '../../testing/fake-model-governor.mjs';
import { slug, cleanupRun, checkpointState } from '../../testing/cli-test-support.mjs';

test('CLI post-mortem command records candidate learning and drains outbox', async () => {
	const testSlug = slug('post-mortem');
	const runId = `${new Date().toISOString().slice(0, 10)}-${testSlug}`;
	fs.mkdirSync(path.join(REPOSITORY_ROOT, 'docs/specs/runs', runId), { recursive: true });
	createRuntimeDirectory(runId, REPOSITORY_ROOT);
	const paths = resolveRunPaths(runId, REPOSITORY_ROOT);
	const repoLearningsPath = path.join(REPOSITORY_ROOT, '.learnings.jsonl');
	const originalLearnings = fs.existsSync(repoLearningsPath)
		? fs.readFileSync(repoLearningsPath, 'utf8')
		: null;

	let store;
	try {
		fs.mkdirSync(paths.artifactsDir, { recursive: true });

		store = new RuntimeStore(paths.databasePath);
		const registry = new RoleRegistry({ rootDir: REPOSITORY_ROOT });
		const loaded = registry.load();
		const artifacts = new ArtifactStore({
			artifactsDir: paths.artifactsDir,
			runtimeStore: store,
			maxArtifactBytes: loaded.workflow.limits.maxArtifactBytes,
		});
		const governor = new FakeModelGovernor([]);
		const runtime = new SdlcWorkflowRuntime({
			runtimeStore: store,
			artifactStore: artifacts,
			registry,
			governor,
		});
		const initial = runtime.initialize({ runId, goal: 'Test post mortem' });
		const escalatedState = {
			...initial,
			state: 'ESCALATED',
			runtimeRevision: initial.runtimeRevision + 1,
			updatedAt: new Date().toISOString(),
		};
		store.saveTransition(
			initial.runtimeRevision,
			escalatedState,
			createEvent({
				eventType: 'RUN_BLOCKED',
				runId,
				runtimeRevision: escalatedState.runtimeRevision,
				state: escalatedState,
				input: initial,
				output: { reason: 'TEST_ESCALATION' },
				causalId: `${runId}:test-escalate`,
				payload: { reason: 'TEST_ESCALATION' },
			}),
		);
		await checkpointState(runtime, escalatedState);
		store.close();
		store = null;

		const result = await runCli(
			[
				'post-mortem',
				'--run',
				runId,
				'--learning-insight',
				'TypeORM rollback requires queryRunner release in finally block',
				'--learning-scope',
				'conditioning',
				'--json',
			],
			{ rootDir: REPOSITORY_ROOT },
		);

		assert.equal(result.exitCode, 0, JSON.stringify(result.result));
		assert.equal(result.result.ok, true);
		assert.match(result.result.learning.key, /^conditioning-/);
		assert.equal(result.result.learning.confidence, 9);

		const checkStore = new RuntimeStore(paths.databasePath);
		try {
			const candidates = checkStore.listCandidateLearnings(runId);
			assert.equal(candidates.length, 1);
			assert.equal(candidates[0].key, result.result.learning.key);
			const pending = checkStore.listPendingLearningOutbox(runId);
			assert.equal(pending.length, 0);
		} finally {
			checkStore.close();
		}
	} finally {
		if (store) store.close();
		cleanupRun(runId);
		if (originalLearnings !== null) {
			fs.writeFileSync(repoLearningsPath, originalLearnings, 'utf8');
		} else if (fs.existsSync(repoLearningsPath)) {
			fs.unlinkSync(repoLearningsPath);
		}
	}
});
