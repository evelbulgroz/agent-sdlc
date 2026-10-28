import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ArtifactStore } from '../persistence/artifacts.ts';
import {
	createRuntimeDirectory,
	REPOSITORY_ROOT,
	resolveRunPaths,
} from '../persistence/run-paths.ts';
import { RuntimeStore } from '../persistence/runtime-store.ts';
import {
	canonicalJson,
	createEvent,
	emptyDraft,
	RUNTIME_SCHEMA_VERSION,
	sha256,
} from '../policy/contracts.ts';
import { RoleRegistry } from '../roles/role-registry.ts';
import { SdlcWorkflowRuntime } from '../workflow/graph.ts';
import { specificationHash } from '../workflow/specification.ts';
import { FakeModelGovernor } from './fake-model-governor.mjs';
import { removeTestRunArtifacts, trackTestRun } from './test-support.mjs';

export async function advanceSeed(fixture, { to, eventType, updates, payload }) {
	const current = fixture.store.getRun(fixture.runId);
	const next = fixture.runtime.transition(current, {
		to,
		eventType,
		causalId: `seed-${eventType}-${current.runtimeRevision}`,
		updates,
		payload,
	});
	await checkpointState(fixture.runtime, next);
	return next;
}

export function sampleEnvelope(runId, approvedSpecHash, baseCommitSha, allowedPathPrefixes) {
	return {
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		runId,
		approvedSpecHash,
		approvedPlanPolicyHash: 'b'.repeat(64),
		repositoryId: 'agent-sdlc',
		baseCommitSha,
		allowedPackages: ['packages/ddd-base'],
		allowedPathPrefixes,
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
	};
}

export function slug(label) {
	return `sdlc-cont-${label}-${trackTestRun(crypto.randomUUID().slice(0, 8))}`;
}

export function writeResponse(runId, name, value) {
	const filename = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, `${name}.json`);
	fs.writeFileSync(filename, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	return filename;
}

export function cleanupRun(runId) {
	removeTestRunArtifacts(runId);
}

let checkpointSequence = 0;

export async function checkpointState(runtime, state) {
	const tuple = await runtime.checkpointer.getTuple(runtime.configFor(state));
	checkpointSequence += 1;
	await runtime.checkpointer.put(
		tuple?.config ?? runtime.configFor(state),
		{
			...(tuple?.checkpoint ?? {
				v: 1,
				ts: new Date().toISOString(),
				channel_versions: {},
				versions_seen: {},
				pending_sends: [],
			}),
			id: `0${String(checkpointSequence).padStart(8, '0')}`,
			channel_values: {
				...(tuple?.checkpoint?.channel_values ?? {}),
				snapshot: state,
			},
		},
		tuple?.metadata ?? {},
	);
}

export async function createSeedRun({
	label,
	stateName = 'WAITING_FOR_APPROVAL',
	semanticRepairsCount = 0,
	blockedReason = null,
	lastError = null,
	activeGeneration = 0,
}) {
	const testSlug = slug(label);
	const runId = `${new Date().toISOString().slice(0, 10)}-${testSlug}`;
	fs.mkdirSync(path.join(REPOSITORY_ROOT, 'docs/specs/runs', runId), { recursive: true });
	createRuntimeDirectory(runId, REPOSITORY_ROOT);
	const paths = resolveRunPaths(runId, REPOSITORY_ROOT);
	const store = new RuntimeStore(paths.databasePath);
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

	const draft = {
		...emptyDraft('Continuation fixture task specification'),
		acceptanceCriteria: ['AC-01: System resumes properly. Given a state. Then it continues.'],
	};
	const draftHash = specificationHash(draft);
	const draftArtifact = artifacts.writeJson('specification-draft', draft);

	const initial = runtime.initialize({
		runId,
		goal: 'Continuation fixture task execution',
	});

	const currentState = {
		...initial,
		state: stateName,
		draftHash,
		draftArtifact,
		semanticRepairsCount,
		blockedReason,
		lastError,
		activeGeneration,
		runtimeRevision: initial.runtimeRevision + 1,
		updatedAt: new Date().toISOString(),
	};

	store.database
		.prepare(
			`
			UPDATE runs SET
				runtime_revision = ?, state = ?, state_hash = ?, state_json = ?,
				semantic_repairs_count = ?, updated_at = ?
			WHERE run_id = ?
		`,
		)
		.run(
			currentState.runtimeRevision,
			currentState.state,
			sha256(currentState),
			canonicalJson(currentState),
			currentState.semanticRepairsCount ?? 0,
			currentState.updatedAt,
			currentState.runId,
		);

	store.insertEvent(
		createEvent({
			eventType: 'RUN_INITIALIZED',
			runId,
			runtimeRevision: currentState.runtimeRevision,
			state: currentState,
			input: initial,
			output: { stateName },
			causalId: `${runId}:seed`,
			payload: { stateName },
		}),
	);

	store.queueProjection(currentState.runId, currentState.runtimeRevision);
	await checkpointState(runtime, currentState);

	return {
		runId,
		paths,
		store,
		registry,
		artifacts,
		governor,
		runtime,
		draft,
		draftHash,
		draftArtifact,
		currentState,
	};
}
