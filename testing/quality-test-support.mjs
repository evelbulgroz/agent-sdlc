import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createEvent, sha256 } from '../policy/contracts.ts';
import { ArtifactStore } from '../persistence/artifacts.ts';
import { RuntimeStore } from '../persistence/runtime-store.ts';

export const H = 'a'.repeat(64), T = 'b'.repeat(40), TIME = '2026-11-01T12:00:00.000Z';
export const policy = {
	schemaVersion: '1.0.0', policyId: 'checkpoint-evidence-v1', additionalCandidateReviews: 1,
	followUpDispatches: 1, testRetryPolicy: 'clean-success',
	retrieval: { maxPacketBytes: 24576, maxPacketLines: 1000, maxTotalBytesPerCandidate: 49152, maxTotalLinesPerCandidate: 2000 },
	execution: { maxInvocations: 10, maxTotalDurationMs: 100 },
	review: { maxLogicalDispatches: 8, maxPhysicalCalls: 10, maxInputTokens: 1000, maxOutputTokens: 1000 },
};
export function makeFixture(label) {
	const runId = `2026-11-01-${label}-${crypto.randomUUID().slice(0, 8)}`;
	const runtimeDir = path.resolve('tools/.agent-sdlc/test-fixtures', runId);
	fs.mkdirSync(runtimeDir, { recursive: true });
	let store;
	try { store = new RuntimeStore(path.join(runtimeDir, 'runtime.sqlite')); }
	catch (error) { fs.rmSync(runtimeDir, { recursive: true, force: true }); throw error; }
	const artifacts = new ArtifactStore({ artifactsDir: path.join(runtimeDir, 'artifacts'), runtimeStore: store });
	return { runId, runtimeDir, store, artifacts,
		close() { store.close(); fs.rmSync(runtimeDir, { recursive: true, force: true }); } };
}
export function initialize(fixture, frozen = policy) {
	const state = {
		schemaVersion: '1.0.0', runId: fixture.runId, threadId: 'thread-a', runtimeRevision: 0,
		state: 'INITIALIZING', goalArtifact: H, draftArtifact: null, draftHash: null,
		taskManifestArtifact: null, taskManifestHash: null,
		completeness: { complete: false, missingFields: [], ambiguousFields: [] },
		pendingInterruptId: null, approvedSpecHash: null, modelOperations: [],
		workflowHash: H, roleHash: H, promptPolicyHash: H, capabilitySetHash: H, evaluatorSetHash: H,
		completenessHash: null, activeModelOperationId: null, activeProposalArtifact: null,
		interviewRound: 0, specApprovalAttempt: 0, specCriticRepairPending: false, taskPlanFrozen: false,
		createdAt: TIME, updatedAt: TIME,
	};
	fixture.store.initializeRun(state, createEvent({ eventType: 'RUN_INITIALIZED', runId: fixture.runId,
		runtimeRevision: 0, state, causalId: 'initialize',
		input: { goalArtifact: state.goalArtifact }, output: { draftArtifact: state.draftArtifact },
		payload: { goalArtifact: state.goalArtifact, draftArtifact: state.draftArtifact }, now: new Date(TIME) }));
	fixture.store.quality.initializeBudget({
		schemaVersion: '1.0.0', runId: fixture.runId, qualityPolicyHash: sha256(frozen), revision: 0,
		counters: { executionInvocations: 0, executionDurationMs: 0, logicalDispatches: 0,
			physicalCalls: 0, inputTokens: 0, outputTokens: 0 }, reservations: [],
	}, frozen);
}
export function binding(fixture, revision = 0) {
	return {
		runId: fixture.runId, approvedSpecHash: H, taskPlanHash: H, qualityPolicyHash: sha256(policy),
		checkpointId: 'slice-a', checkpointKind: 'slice', ownerId: 'slice-a', candidateRevision: revision,
		baseCommitSha: T, treeSha: T, revisionSetHash: H, preparationHash: H,
	};
}
