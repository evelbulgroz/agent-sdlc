import '../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';
import { canonicalJson, sha256 } from '../policy/contracts.ts';
import { adapterBindingHash, qualityPolicyHash } from '../policy/contracts/quality-schema.ts';
import { createMockExecCli, makeFixture } from '../testing/test-support.mjs';
import { executePreflightForSnapshot } from './preflight-gate.ts';
import { commandRegistrationFixture } from '../testing/command-registration-fixture.ts';

function persistRuntimeSnapshot(fixture, snapshot) {
	fixture.store.database
		.prepare('UPDATE runs SET state = ?, state_json = ?, state_hash = ? WHERE run_id = ?')
		.run(snapshot.state, canonicalJson(snapshot), sha256(snapshot), fixture.runId);
}

function prepareVerifierSnapshot(fixture, state) {
	const approvedSpecHash = 'a'.repeat(64);
	const baseCommitSha = 'b'.repeat(40);
	const targetTreeSha = 'c'.repeat(40);
	const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'Retire autonomous repair' });
	const snapshot = {
		...initial,
		state,
		approvedSpecHash,
		worktreePath: fixture.runtimeDir,
		integrationWorktreePath: fixture.runtimeDir,
		targetTreeSha,
		activeGeneration: 0,
	};
	persistRuntimeSnapshot(fixture, snapshot);
	fixture.store.saveAuthorization(createDefaultAuthorizationEnvelope({
		runId: fixture.runId,
		approvedSpecHash,
		baseCommitSha,
		allowedPackages: ['services/billing'],
		allowedPathPrefixes: ['services/billing'],
	}));
	return { snapshot, baseCommitSha, targetTreeSha };
}

test('an invalidated final binding does not hide a preflight failure', async () => {
	const fixture = makeFixture('preflight-fail-invalidated-final', []);
	try {
		const { snapshot, baseCommitSha } = prepareVerifierSnapshot(fixture, 'VERIFYING_PREFLIGHT');
		const policy = {
			schemaVersion: '1.0.0', policyId: 'checkpoint-evidence-v1', additionalCandidateReviews: 0, followUpDispatches: 0,
			testRetryPolicy: 'clean-success',
			retrieval: { maxPacketBytes: 24_576, maxPacketLines: 1_000, maxTotalBytesPerCandidate: 49_152, maxTotalLinesPerCandidate: 2_000 },
			execution: { maxInvocations: 2, maxTotalDurationMs: 10_000 },
			review: { maxLogicalDispatches: 2, maxPhysicalCalls: 2, maxInputTokens: 1_000, maxOutputTokens: 1_000 },
		};
		const adapter = commandRegistrationFixture({ adapterId: 'unit-adapter', limits: { timeoutMs: 5_000, maxReportBytes: 20_000, maxArtifactBytes: 10_000, maxArtifacts: 4 } });
		const taskPlanHash = 'd'.repeat(64);
		const binding = {
			runId: fixture.runId, approvedSpecHash: snapshot.approvedSpecHash, taskPlanHash,
			qualityPolicyHash: qualityPolicyHash(policy), checkpointId: 'final-stale', checkpointKind: 'final', ownerId: null,
			candidateRevision: 0, baseCommitSha, treeSha: snapshot.targetTreeSha, revisionSetHash: '1'.repeat(64), preparationHash: '2'.repeat(64),
		};
		fixture.store.saveTaskPlan({
			schemaVersion: '2.0.0', runId: fixture.runId, planPolicyHash: 'a'.repeat(64), baseCommitSha,
			slices: [{ sliceId: 'slice-one', kind: 'vertical', goal: 'Feature', acceptanceCriteria: ['AC-01'], dependsOn: [] }],
			tasks: [{
				taskId: 'task-one', title: 'Feature', targetPackage: 'services/billing', pathPrefixes: ['services/billing'],
				dependsOn: [], integrationOrder: 0, sliceId: 'slice-one', authoredPaths: ['services/billing/src/main.ts'],
				generatedOutputs: [], deliveryLayers: ['application'], dependencyMutations: [],
				shadowPaths: { unhappy: 'error', timeout: 'timeout', empty: 'empty', boundary: 'edge' },
				verificationCommand: ['pnpm', 'run', 'test:unit'], generatorCommand: null, acceptanceCriteria: ['AC-01'],
			}],
			integrationOrder: ['task-one'], isParallel: false, createdAt: new Date().toISOString(),
			qualityPolicy: policy, qualityPolicyHash: qualityPolicyHash(policy), adapterBindings: [adapter],
			evidenceObligations: [{
				obligationId: 'obligation-one', criterionId: 'AC-01', caseId: 'AC-01.1', owner: { kind: 'task', id: 'task-one' },
				observableOutcome: 'A visible result is shown.', setupAction: 'Open the screen.', expectedResult: 'The result appears.',
				layer: 'unit', requiredCapabilities: [], implementationPaths: ['services/billing/src/main.ts'],
				testCases: [{ file: 'services/billing/src/main.spec.ts', caseKey: 'case-one' }],
				adapterBindingHash: adapterBindingHash(adapter), profileId: 'unit',
			}],
		});
		fixture.store.quality.listClosures = () => [{
			binding, registryId: 'final-stale', selectedRevisions: [{ taskId: 'task-one', executionRevision: 0, patchHash: '5'.repeat(64) }],
			status: 'invalidated', receiptHashes: ['4'.repeat(64)],
		}];
		fixture.store.quality.getTaskRevision = () => null;
		fixture.store.quality.getCorrection = () => null;
		fixture.store.quality.hasIncompleteCorrection = () => false;
		fixture.store.quality.getWorktree = () => ({
			registryId: 'final-stale', kind: 'final', ownerId: null, relativePath: '.', bindingHash: sha256(binding),
		});
		const bound = {
			...snapshot, approvedPlanPolicyHash: fixture.store.getAuthorization(fixture.runId).approvedPlanPolicyHash, taskPlanHash, taskPlanFrozen: true, qualityPolicy: policy, qualityCheckpointId: 'final-stale',
			qualityCheckpointKind: 'final', qualityCheckpointTreeSha: snapshot.targetTreeSha,
			qualityCheckpointBindingHash: sha256(binding),
		};
		persistRuntimeSnapshot(fixture, bound);
		fixture.runtime.execCli = createMockExecCli({ preflightStatus: 'FAIL' });
		const result = await executePreflightForSnapshot(fixture.runtime, bound);
		assert.equal(result.snapshot.state, 'ESCALATED');
		assert.equal(result.snapshot.blockedReason, 'AUTONOMOUS_REPAIR_RETIRED');
	} finally {
		fixture.close();
	}
});
