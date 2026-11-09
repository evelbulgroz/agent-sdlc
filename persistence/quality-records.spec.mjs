import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sha256 } from '../policy/contracts.ts';
import { RuntimeStore } from './runtime-store.ts';
import { hasRunWorktrees } from './run-retention.ts';
import { cleanMergedRunWorktrees } from './run-cleanup.ts';
import { isCheckpointWorktree } from './quality-worktree-reader.ts';
import { compactRunDatabase } from './run-compaction.ts';
import { createEvidenceRecordStore } from '../host/evidence-store.ts';
import { hashTaskPlanProjection } from '../policy/contracts/dag-schema.ts';
import { H, T, TIME, policy, makeFixture, initialize, binding } from '../testing/quality-test-support.mjs';
import { commandRegistrationFixture } from '../testing/command-registration-fixture.mjs';
function completion(fixture, id, candidate = binding(fixture)) {
	const q = fixture.store.quality;
	q.registerWorktree({ runId: fixture.runId, registryId: `registry-${id}`, kind: 'slice', ownerId: 'slice-a',
		relativePath: `worktrees/checkpoints/${id}`, bindingHash: sha256(candidate), sourceHash: H });
	const invocation = {
		schemaVersion: '1.0.0', operationId: id, requestHash: H, bindingHash: sha256(candidate),
		adapterBindingHash: H, observedArgv: ['offline-runner'], worktreeRegistryId: `registry-${id}`,
		startedAt: TIME, finishedAt: null, exitCode: null, reportHash: null, artifactManifestHash: null,
		status: 'reserved', retryOf: null, failureReason: null,
	};
	q.reserveBudget(fixture.runId, { operationId: id, kind: 'execution', checkpointId: candidate.checkpointId,
		candidateRevision: candidate.candidateRevision, status: 'reserved' });
	q.reserveInvocation(fixture.runId, invocation);
	q.startInvocation(fixture.runId, { ...invocation, status: 'running' });
	const final = { ...invocation, finishedAt: TIME, exitCode: 0, reportHash: H, artifactManifestHash: H, status: 'completed' };
	const receipt = {
		schemaVersion: '1.0.0', operationId: id, requestHash: H, bindingHash: sha256(candidate),
		adapterBindingHash: H, invocationRecordHash: sha256(final), reportHash: H, artifactManifestHash: H,
		dischargedObligationIds: ['obligation-a'], status: 'passed',
	};
	q.completeInvocation(fixture.runId, { invocation: final, receipt,
		report: { schemaVersion: '1.0.0', operationId: id, requestHash: H,
			adapterBindingHash: H, profileId: 'unit', cases: [], artifacts: [] },
		observations: { before: null, after: null, signal: null, durationMs: 1 },
	});
	return { invocation, receipt };
}
function revision(fixture, receipt, executionRevision = 0, correctionId = null, taskId = 'task-a') {
	return { schemaVersion: '1.0.0', runId: fixture.runId, taskPlanHash: H, taskId, executionRevision,
		correctionId, parentTreeSha: T, targetTreeSha: T, patchHash: H, parentRevisionSetHash: H,
		status: 'completed', receiptHashes: [sha256(receipt)] };
}
function closure(fixture, receipt, candidateRevision = 0, executionRevision = 0, status = 'accepted') {
	return { schemaVersion: '1.0.0', binding: binding(fixture, candidateRevision),
		selectedRevisions: [{ taskId: 'task-a', executionRevision, patchHash: H }],
		registryId: `registry-op-${candidateRevision}`, status, receiptHashes: [sha256(receipt)], reviewOperationIds: [] };
}
function approve(fixture) {
	const q = fixture.store.quality;
	const artifact = fixture.artifacts.writeJson('quality-interrupt', { pending: true });
	fixture.store.createInterrupt({ interruptId: 'interrupt-a', runId: fixture.runId, kind: 'QUALITY_REVIEW',
		stateHash: H, requestArtifact: artifact, createdAt: TIME });
	q.bindInterrupt({ runId: fixture.runId, interruptId: 'interrupt-a', bindingHash: sha256(binding(fixture)),
		findingIds: ['finding-a'], expectedRevisions: [{ taskId: 'task-a', executionRevision: 0 }],
		affectedTaskIds: ['task-a'] });
	return { runId: fixture.runId, expectedBindingHash: sha256(binding(fixture)),
		affectedTaskIds: ['task-a'], correctionId: 'correction-a', answer: {
			schemaVersion: '1.0.0', answerId: 'answer-a', interruptId: 'interrupt-a',
			bindingHash: sha256(binding(fixture)), findingIds: ['finding-a'], action: 'approve-correction',
			rationale: 'Fix approved owning source', evidenceHashes: [],
			correction: { owners: [{ taskId: 'task-a', expectedRevision: 0, editPaths: ['src/a.ts'] }],
				rerunObligationIds: ['obligation-a'], maxSourceEditIterations: 1, expectedBudgetLedgerHash: q.budgetHash(fixture.runId) },
		} };
}
test('durable immutable revisions require receipts, survive reopen, and reject changed identity', () => {
	const fixture = makeFixture('quality-revisions');
	try {
		initialize(fixture);
		const q = fixture.store.quality;
		assert.throws(() => q.saveTaskRevision(null));
		assert.throws(() => q.saveTaskRevision({}));
		const { receipt } = completion(fixture, 'op-0');
		const record = revision(fixture, receipt);
		q.saveTaskRevision(record);
		q.selectTaskRevision(fixture.runId, 'task-a', 0);
		assert.deepEqual(q.saveTaskRevision(record), record);
		assert.throws(() => q.saveTaskRevision({ ...record, patchHash: 'c'.repeat(64) }), /changed contents/);
		assert.throws(() => q.saveTaskRevision({ ...record, extra: true }));
		fixture.store.close();
		const reopened = new RuntimeStore(path.join(fixture.runtimeDir, 'runtime.sqlite'));
		try { assert.deepEqual(reopened.quality.getCurrentTaskRevision(fixture.runId, 'task-a'), record); }
		finally { reopened.close(); }
	} finally { fixture.close(); }
});
test('answer CAS stages selections until atomic correction completion', () => {
	const fixture = makeFixture('quality-correction');
	try {
		initialize(fixture);
		const q = fixture.store.quality;
		const { receipt } = completion(fixture, 'op-0');
		q.saveTaskRevision(revision(fixture, receipt));
		q.selectTaskRevision(fixture.runId, 'task-a', 0);
		q.saveClosure(closure(fixture, receipt));
		const input = approve(fixture);
		assert.throws(() => q.consumeAnswer({ ...input, expectedBindingHash: H }), /Stale/);
		assert.equal(q.getCurrentTaskRevision(fixture.runId, 'task-a').executionRevision, 0);
		const result = q.consumeAnswer(input);
		assert.deepEqual(q.consumeAnswer(input), result);
		assert.throws(() => q.consumeAnswer({ ...input, answer: { ...input.answer, rationale: 'changed' } }), /collision/);
		assert.equal(q.getCurrentTaskRevision(fixture.runId, 'task-a'), null);
		assert.equal(q.getReceipt(fixture.runId, 'op-0'), null);
		assert.equal(q.getClosure(fixture.runId, 'slice-a', 0).status, 'invalidated');
		assert.equal(q.getTaskRevision(fixture.runId, 'task-a', 0).status, 'completed');
		assert.equal(q.getBudget(fixture.runId).counters.executionInvocations, 1);
		const freshBinding = { ...binding(fixture, 1), checkpointId: 'slice-a-fresh-tree' };
		const fresh = completion(fixture, 'op-1', freshBinding);
		q.saveTaskRevision(revision(fixture, fresh.receipt, 1, 'correction-a'));
		assert.throws(() => q.selectTaskRevision(fixture.runId, 'task-a', 1), /not selectable/);
		const rebuilt = { ...closure(fixture, fresh.receipt, 1, 1, 'reviewing'), binding: freshBinding };
		q.saveStagedClosure('correction-a', rebuilt);
		for (const status of ['materializing', 'failed', 'materializing', 'executing', 'verifying', 'rebuilding']) {
			q.setCorrectionStatus(fixture.runId, 'correction-a', status);
		}
		const commit = { runId: fixture.runId, correctionId: 'correction-a',
			expectedBudgetLedgerHash: q.budgetHash(fixture.runId),
			stagedRevisions: [{ taskId: 'task-a', executionRevision: 1 }], closures: [{ checkpointId: freshBinding.checkpointId, candidateRevision: 1 }] };
		assert.throws(() => q.completeCorrection(commit), /lacks completed verification or adequacy/);
		assert.throws(() => q.saveStagedClosure('correction-a', { ...rebuilt, status: 'accepted', selectedRevisions: [] }),
			/changed contents/);
		q.saveStagedClosure('correction-a', { ...rebuilt, status: 'accepted' });
		q.saveStagedClosure('correction-a', { ...rebuilt, status: 'accepted' });
		assert.throws(() => q.saveStagedClosure('correction-a', rebuilt), /Invalid staged closure transition/);
		assert.equal(q.getClosure(fixture.runId, freshBinding.checkpointId, 1).status, 'reviewing');
		assert.throws(() => q.completeCorrection({ ...commit, closures: [] }), /omitted affected/);
		assert.equal(q.getCurrentTaskRevision(fixture.runId, 'task-a'), null);
		assert.equal(q.completeCorrection(commit).status, 'completed');
		assert.deepEqual(q.completeCorrection(commit), q.getCorrection(fixture.runId, 'correction-a'));
		assert.equal(q.getCurrentTaskRevision(fixture.runId, 'task-a').executionRevision, 1);
		assert.equal(q.getClosure(fixture.runId, freshBinding.checkpointId, 1).status, 'accepted');
		const later = completion(fixture, 'op-2', binding(fixture, 2));
		q.saveClosure(closure(fixture, later.receipt, 2, 1, 'reviewing'));
		assert.equal(q.setClosureStatus(fixture.runId, 'slice-a', 2, 'accepted').status, 'accepted');
		assert.equal(q.getCurrentTaskRevision(fixture.runId, 'task-a').correctionId, 'correction-a');
	} finally { fixture.close(); }
});
test('checkpoint worktrees are individually cleaned and excluded from task patches', () => {
	const fixture = makeFixture('quality-worktrees');
	try {
		initialize(fixture);
		const q = fixture.store.quality;
		assert.throws(() => q.registerWorktree(null));
		const record = { runId: fixture.runId, registryId: 'registry-a', kind: 'final', ownerId: null,
			relativePath: 'checkpoint-worktrees/final-a', bindingHash: H, sourceHash: H };
		assert.throws(() => q.registerWorktree({ ...record, relativePath: '../outside' }), /Unsafe/);
		assert.throws(() => q.registerWorktree({ ...record, relativePath: '' }), /Unsafe/);
		fs.mkdirSync(path.join(fixture.runtimeDir, 'worktrees'), { recursive: true });
		fs.symlinkSync(fixture.runtimeDir, path.join(fixture.runtimeDir, 'worktrees', 'link'));
		assert.throws(() => q.registerWorktree({ ...record, relativePath: 'worktrees/link/final' }), /symlink/);
		fs.unlinkSync(path.join(fixture.runtimeDir, 'worktrees', 'link'));
		q.registerWorktree(record);
		const checkpointDir = path.join(fixture.runtimeDir, record.relativePath);
		fs.mkdirSync(checkpointDir, { recursive: true });
		assert.equal(hasRunWorktrees(fixture.runtimeDir), true);
		assert.equal(isCheckpointWorktree(fixture.runtimeDir, checkpointDir), true);
		const removals = [];
		const gitCli = (_command, args) => {
			if (args.includes('remove')) { const dir = args.at(-1); removals.push(dir); fs.rmSync(dir, { recursive: true }); }
			return '';
		};
		const cleaned = cleanMergedRunWorktrees(fixture.runId, { rootDir: fixture.runtimeDir, runDir: fixture.runtimeDir, gitCli });
		assert.equal(cleaned.ok, true);
		assert.deepEqual(removals, [checkpointDir]);
		assert.equal(hasRunWorktrees(fixture.runtimeDir), false);
		const compacted = path.join(fixture.runtimeDir, 'compacted.sqlite');
		const result = compactRunDatabase(path.join(fixture.runtimeDir, 'runtime.sqlite'), compacted);
		assert.equal(result.rowCounts.quality_records > 0, true);
	} finally { fixture.close(); }
});
test('real evidence adapter persists atomic completion and reuses a complete matching invocation', async () => {
	const fixture = makeFixture('quality-adapter');
	try {
		initialize(fixture);
		const { invocation } = completion(fixture, 'op-adapter');
		const completionRecord = fixture.store.quality.getEvidenceCompletion(fixture.runId, 'op-adapter');
		const port = createEvidenceRecordStore(fixture.store, {
			operationId: 'op-adapter', binding: binding(fixture),
		});
		const replay = await port.reserve({ ...invocation, startedAt: '2026-11-02T00:00:00.000Z' });
		assert.equal(replay.kind, 'existing');
		assert.deepEqual(replay.completion, completionRecord);
		await port.complete(completionRecord);
		await port.complete(completionRecord);
		assert.equal(fixture.store.quality.getBudget(fixture.runId).counters.executionInvocations, 1);
		assert.equal(fixture.store.quality.getBudget(fixture.runId).counters.executionDurationMs, 1);
		await assert.rejects(() => port.reserve({ ...invocation, requestHash: 'c'.repeat(64) }), /changed contents/);
		assert.equal(fixture.store.quality.getBudget(fixture.runId).counters.executionInvocations, 1);
	} finally { fixture.close(); }
});
test('unfinished dispatch reconciliation is charged interrupted evidence, never a successful receipt', () => {
	const fixture = makeFixture('quality-interrupted');
	try {
		initialize(fixture);
		const q = fixture.store.quality;
		const { invocation } = completion(fixture, 'op-complete');
		q.reserveBudget(fixture.runId, { operationId: 'op-crash', kind: 'execution', checkpointId: 'slice-a',
			candidateRevision: 0, status: 'reserved' });
		q.reserveInvocation(fixture.runId, { ...invocation, operationId: 'op-crash' });
		q.startInvocation(fixture.runId, { ...invocation, operationId: 'op-crash', status: 'running' });
		assert.equal(q.interruptInvocations(fixture.runId), 1);
		assert.equal(q.interruptInvocations(fixture.runId), 0);
		assert.throws(() => q.startInvocation(fixture.runId, {
			...invocation, operationId: 'op-crash', status: 'running' }), /mismatches/);
		assert.equal(q.getInvocation(fixture.runId, 'op-crash').status, 'interrupted');
		assert.equal(q.getReceipt(fixture.runId, 'op-crash'), null);
		assert.equal(q.getBudget(fixture.runId).counters.executionInvocations, 2);
		assert.equal(q.getBudget(fixture.runId).reservations.find(r => r.operationId === 'op-crash').status, 'interrupted');
	} finally { fixture.close(); }
});
test('v14 upgrade preserves exact legacy state and event hash projections while adding quality tables', () => {
	const fixture = makeFixture('quality-v14-upgrade');
	try {
		initialize(fixture);
		const before = fixture.store.database.prepare('SELECT state_hash,state_json FROM runs WHERE run_id=?').get(fixture.runId);
		const events = fixture.store.database.prepare('SELECT event_json FROM events WHERE run_id=?').all(fixture.runId);
		fixture.store.database.exec(`DROP TABLE quality_current_revisions; DROP TABLE quality_invalidations;
			DROP TABLE quality_budgets; DROP TABLE quality_records; UPDATE schema_migrations SET version=14 WHERE version=15;`);
		fixture.store.close();
		const upgraded = new RuntimeStore(path.join(fixture.runtimeDir, 'runtime.sqlite'));
		try {
			assert.deepEqual(upgraded.database.prepare('SELECT state_hash,state_json FROM runs WHERE run_id=?').get(fixture.runId), before);
			assert.deepEqual(upgraded.database.prepare('SELECT event_json FROM events WHERE run_id=?').all(fixture.runId), events);
			assert.deepEqual(upgraded.quality.listTaskRevisions(fixture.runId), []);
			assert.equal(upgraded.database.prepare('SELECT max(version) AS version FROM schema_migrations').get().version, 15);
		} finally { upgraded.close(); }
	} finally { fixture.close(); }
});
test('v2 plans retain policy and hydrate eligible revisions', () => {
	const fixture = makeFixture('quality-plan');
	try {
		initialize(fixture);
		const adapter = commandRegistrationFixture({ adapterId: 'offline', limits: { timeoutMs: 100, maxReportBytes: 1000, maxArtifactBytes: 1000, maxArtifacts: 1 } });
		const plan = {
			schemaVersion: '2.0.0', runId: fixture.runId, planPolicyHash: H, baseCommitSha: T,
			slices: [{ sliceId: 'slice-a', kind: 'vertical', goal: 'Prepare boundary', acceptanceCriteria: ['AC-01'], dependsOn: [] }],
			tasks: [{ taskId: 'task-a', title: 'Prepare boundary', targetPackage: 'packages/example',
				pathPrefixes: ['src'], dependsOn: [], integrationOrder: 0, sliceId: 'slice-a' }],
			integrationOrder: ['task-a'], isParallel: false, createdAt: TIME, qualityPolicy: policy,
			qualityPolicyHash: sha256(policy), adapterBindings: [adapter], evidenceObligations: [{
				obligationId: 'obligation-a', criterionId: 'AC-01', caseId: null, owner: { kind: 'task', id: 'task-a' },
				observableOutcome: 'Boundary visible', setupAction: 'Exercise boundary', expectedResult: 'Boundary passes',
				layer: 'unit', requiredCapabilities: [], implementationPaths: ['src/a.ts'],
				testCases: [{ file: 'src/a.spec.mjs', caseKey: 'case-a' }], adapterBindingHash: sha256(adapter), profileId: 'unit',
			}],
		};
		const saved = fixture.store.saveTaskPlan(plan);
		assert.equal(saved.schemaVersion, '2.0.0');
		const immutableHash = hashTaskPlanProjection(plan);
		const { receipt } = completion(fixture, 'op-plan');
		fixture.store.quality.saveTaskRevision(revision(fixture, receipt));
		fixture.store.quality.selectTaskRevision(fixture.runId, 'task-a', 0);
		const current = fixture.store.getTaskPlan(fixture.runId);
		assert.equal(current.tasks[0].status, 'completed');
		assert.equal(current.tasks[0].targetTreeSha, T);
		assert.equal(current.qualityPolicyHash, sha256(policy));
		assert.equal(hashTaskPlanProjection(current), immutableHash);
		assert.deepEqual(fixture.store.taskPlans.getImmutableTaskPlan(fixture.runId), plan);
		assert.throws(() => fixture.store.saveTaskPlan({ ...plan, createdAt: '2026-11-02T00:00:00.000Z' }), /changed contents/);
		fixture.store.saveTaskPlan(current);
		assert.equal(fixture.store.getTaskPlan(fixture.runId).tasks[0].status, 'completed');

		const policyHashA = 'c'.repeat(64);
		const policyHashB = 'd'.repeat(64);
		fixture.store.saveTaskPlan(plan, policyHashA);
		const planB = { ...plan, createdAt: '2026-11-02T00:00:00.000Z' };
		fixture.store.saveTaskPlan(planB, policyHashB);
		assert.deepEqual(fixture.store.taskPlans.getImmutableTaskPlan(fixture.runId, policyHashA), plan);
		assert.deepEqual(fixture.store.taskPlans.getImmutableTaskPlan(fixture.runId, policyHashB), planB);
		assert.equal(
			hashTaskPlanProjection(fixture.store.taskPlans.getTaskPlanForPolicy(fixture.runId, policyHashA)),
			immutableHash,
		);
		assert.throws(
			() => fixture.store.saveTaskPlan({ ...planB, createdAt: '2026-11-03T00:00:00.000Z' }, policyHashB),
			/changed contents/,
		);
		assert.deepEqual(fixture.store.taskPlans.getImmutableTaskPlan(fixture.runId, policyHashA), plan);
	} finally { fixture.close(); }
});
test('ordinary deterministic verification requires intact artifacts and exact revision/tree binding', () => {
	const fixture = makeFixture('quality-ordinary-verification');
	try {
		initialize(fixture);
		const q = fixture.store.quality;
		const artifactHash = fixture.artifacts.writeJson('deterministic-verification', { command: ['pnpm', 'test'], exitCode: 0 });
		const receipt = { schemaVersion: '1.0.0', runId: fixture.runId, taskId: 'task-a',
			executionRevision: 0, treeSha: T, command: ['pnpm', 'test'], artifactHash, exitCode: 0, status: 'passed' };
		assert.throws(() => q.saveVerificationReceipt({ ...receipt, artifactHash: H }), /missing or corrupt/);
		const hash = q.saveVerificationReceipt(receipt);
		q.saveTaskRevision({ ...revision(fixture, {}), receiptHashes: [hash] });
		q.selectTaskRevision(fixture.runId, 'task-a', 0);
		q.saveTaskRevision({ ...revision(fixture, {}, 1), receiptHashes: [hash] });
		assert.throws(() => q.selectTaskRevision(fixture.runId, 'task-a', 1), /revision binding mismatch/);
		assert.equal(q.getCurrentTaskRevision(fixture.runId, 'task-a').executionRevision, 0);
	} finally { fixture.close(); }
});
test('R=0 remains exhausted when a changed tree uses a different checkpoint worktree identity', () => {
	const fixture = makeFixture('quality-stable-review-key');
	try {
		const frozen = { ...policy, additionalCandidateReviews: 0 };
		initialize(fixture, frozen);
		const q = fixture.store.quality;
		for (const [index, checkpointId] of ['snapshot-a', 'snapshot-b'].entries()) {
			const candidate = { ...binding(fixture, index), qualityPolicyHash: sha256(frozen), checkpointId };
			q.registerWorktree({ runId: fixture.runId, registryId: `registry-${index}`, kind: 'slice', ownerId: 'slice-a',
				relativePath: `checkpoint-worktrees/${checkpointId}`, bindingHash: sha256(candidate), sourceHash: H });
			q.saveClosure({ schemaVersion: '1.0.0', binding: candidate, selectedRevisions: [],
				registryId: `registry-${index}`, status: 'building', receiptHashes: [], reviewOperationIds: [] });
			const reserve = () => q.reserveBudget(fixture.runId, {
				operationId: `review-${index}`, kind: 'review', checkpointId, candidateRevision: index, status: 'reserved' });
			if (index === 0) reserve();
			else assert.throws(reserve, /candidate review budget exhausted/);
		}
		assert.equal(q.getBudget(fixture.runId).counters.logicalDispatches, 1);
	} finally { fixture.close(); }
});
