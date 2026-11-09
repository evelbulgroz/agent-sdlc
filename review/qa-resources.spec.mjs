import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { validateOperationRequest } from '@evelbulgroz/model-usage-govenor/policy';
import { sha256 } from '../policy/contracts.ts';
import { makeFixture } from '../testing/test-support.mjs';
import { policy as baseline } from '../testing/quality-test-support.ts';
import { runCheckpointQaCritic } from './qa-checkpoint.ts';

function fixture(t, options = {}) {
	const f = makeFixture('qa-resources');
	t.after(() => f.close());
	const initial = f.runtime.initialize({ runId: f.runId, goal: 'Bound governed QA usage' });
	const worktreeDir = path.join(f.runtimeDir, 'candidate');
	fs.mkdirSync(path.join(worktreeDir, 'src'), { recursive: true });
	fs.writeFileSync(path.join(worktreeDir, 'src/code.ts'), 'export const ready = true;\n');
	fs.writeFileSync(path.join(worktreeDir, 'src/code.spec.ts'), 'assert.equal(ready, true);\n');
	const policy = { ...baseline, followUpDispatches: 0,
		review: { maxLogicalDispatches: 8, maxPhysicalCalls: 3,
			maxInputTokens: options.reviewInputTokens ?? 30_000, maxOutputTokens: 2_000 },
		...options.policy };
	f.store.quality.initializeBudget({
		schemaVersion: '1.0.0', runId: f.runId, qualityPolicyHash: sha256(policy), revision: 0,
		counters: { executionInvocations: 0, executionDurationMs: 0, logicalDispatches: 0,
			physicalCalls: 0, inputTokens: 0, outputTokens: 0 }, reservations: [],
	}, policy);
	const binding = { runId: f.runId, approvedSpecHash: 'a'.repeat(64), taskPlanHash: 'b'.repeat(64),
		qualityPolicyHash: sha256(policy), checkpointId: 'slice-one', checkpointKind: 'slice', ownerId: 'slice-one',
		candidateRevision: 0, baseCommitSha: 'c'.repeat(40), treeSha: 'd'.repeat(40),
		revisionSetHash: 'e'.repeat(64), preparationHash: 'f'.repeat(64) };
	const obligation = { obligationId: 'visible', criterionId: 'AC-01', caseId: 'AC-01.1',
		owner: { kind: 'slice', id: 'slice-one' }, observableOutcome: 'Ready is visible',
		setupAction: 'Read ready', expectedResult: 'Ready is true', layer: 'unit', requiredCapabilities: [],
		implementationPaths: ['src/code.ts'], testCases: [{ file: 'src/code.spec.ts', caseKey: 'ready' }],
		adapterBindingHash: '1'.repeat(64), profileId: 'unit' };
	f.store.quality.getEvidenceCompletionByReceiptHash = () => ({
		receipt: { status: 'passed', dischargedObligationIds: ['visible'] },
		invocation: { status: 'completed' },
		report: { cases: [{ file: 'src/code.spec.ts', caseKey: 'ready', obligationIds: ['visible'],
			outcome: 'passed', exercisedCapabilities: [], attempts: [{ index: 0, outcome: 'passed', durationMs: 1 }] }] },
	});
	const calls = [], attempts = [], operations = {};
	const governor = {
		synthetic: options.synthetic ?? false,
		getRunOperations: () => ({}),
		getRunUsageLedger: () => options.accounting === undefined ? { runId: f.runId, operations, attempts, reservations: [] }
			: options.accounting,
		async execute(request) {
			validateOperationRequest(request);
			calls.push(request);
			const charge = options.charge ?? { promptTokens: 123, completionTokens: 45, totalTokens: 168,
				physicalCalls: 1, costMicrousd: 0, premiumRequestUnits: 0 };
			const usageRecordIds = options.synthetic ? [] : (options.charges ?? [charge]).map((entry, index) => {
				const usageRecordId = `usage-${calls.length}-${index}`;
				attempts.push({ operationId: request.operationId, usageRecordId, charge: entry });
				return usageRecordId;
			});
			operations[request.operationId] = {
				state: options.error ? 'failed' : 'succeeded', usageRecordIds,
			};
			if (options.error) throw options.error;
			return { operationId: request.operationId, usageRecordIds,
				output: options.followUp && calls.length === 1 ? {
					status: 'FAIL', findings: [{
						severity: 'P1', category: 'correctness', file: 'src/code.ts', lineRange: [1, 1],
						evidence: 'The result is hardcoded.', impact: 'Inputs cannot affect the result.', remediation: 'Use input.',
					}],
				} : { status: 'PASS', findings: [] }, route: { canonicalVendor: 'openai', model: 'offline' } };
		},
	};
	const context = { policy, worktreeDir,
		plan: { schemaVersion: '2.0.0', tasks: [{ taskId: 'task-one', sliceId: 'slice-one' }],
			evidenceObligations: [obligation] },
		closure: { binding, receiptHashes: ['2'.repeat(64)] } };
	const snapshot = { ...initial, state: 'REVIEWING_QA', authorVendor: 'google', taskPlanFrozen: true,
		approvedSpecHash: binding.approvedSpecHash, taskPlanHash: binding.taskPlanHash,
		qualityCheckpointKind: 'slice', qualityCheckpointBindingHash: sha256(binding) };
	const registry = options.maxPhysicalAttempts ? {
		rootDir: f.registry.rootDir, loadRole(id) {
			const loaded = f.registry.loadRole(id);
			return { ...loaded, role: { ...loaded.role, requestedLimits: {
				...loaded.role?.requestedLimits, maxPhysicalAttempts: options.maxPhysicalAttempts,
			} } };
		},
	} : f.registry;
	const request = { runtime: { runtimeStore: f.store, artifactStore: f.artifacts, registry, governor },
		snapshot, context };
	return { ...f, calls, request, policy, budget: () => f.store.quality.getBudget(f.runId),
		run: () => runCheckpointQaCritic(request) };
}

test('checkpoint QA charges governed physical/input/output usage exactly and replay is free', async t => {
	const f = fixture(t);
	const result = await f.run();
	assert.equal(result.status, 'PASS');
	assert.equal(f.budget().counters.inputTokens, 123);
	assert.equal(f.budget().counters.outputTokens, 45);
	assert.equal(f.budget().counters.physicalCalls, 1);
	const limits = f.calls[0].requestedLimits;
	assert.ok(limits.maxPhysicalAttempts <= 3);
	assert.ok(limits.maxPromptTokens * limits.maxPhysicalAttempts <= 30_000);
	assert.ok(limits.maxCompletionTokens * limits.maxPhysicalAttempts <= 2_000);
	const before = f.budget();
	assert.equal((await f.run()).status, 'SKIP');
	assert.equal(f.calls.length, 1);
	assert.deepEqual(f.budget(), before);
});

for (const dimension of ['maxPhysicalCalls', 'maxInputTokens', 'maxOutputTokens']) {
	test(`checkpoint QA refuses dispatch at the exact ${dimension} ceiling`, async t => {
		const f = fixture(t);
		const key = { maxPhysicalCalls: 'physicalCalls', maxInputTokens: 'inputTokens', maxOutputTokens: 'outputTokens' }[dimension];
		f.store.quality.reserveBudget(f.runId, {
			operationId: 'prior-dispatch', kind: 'review', checkpointId: 'other-slice', candidateRevision: 0, status: 'reserved',
		});
		f.store.quality.chargeBudget(f.runId, 'prior-dispatch', { [key]: f.policy.review[dimension] });
		const result = await f.run();
		assert.equal(result.status, 'BUDGET_EXHAUSTED');
		assert.equal(f.calls.length, 0);
	});
}

for (const accounting of [null, {}, { attempts: [], operations: {}, reservations: [] }]) {
	test(`non-synthetic QA rejects ${JSON.stringify(accounting)} accounting and consumes an interrupt budget`, async t => {
		const f = fixture(t, { accounting });
		await assert.rejects(f.run(), /accounting/i);
		assert.equal(f.budget().reservations[0].status, 'interrupted');
		assert.ok(f.budget().counters.physicalCalls > 0);
		assert.ok(f.budget().counters.inputTokens > 0);
		assert.ok(f.budget().counters.outputTokens > 0);
		assert.equal(f.store.listCriticReviews(f.runId).length, 0);
		const before = f.budget();
		assert.equal((await f.run()).status, 'BUDGET_EXHAUSTED');
		assert.equal(f.calls.length, 1);
		assert.deepEqual(f.budget(), before);
	});
}

test('failed governed QA charges reconciled usage before preserving its error', async t => {
	const f = fixture(t, { error: new Error('offline timeout') });
	await assert.rejects(f.run(), /offline timeout/);
	assert.equal(f.budget().counters.inputTokens, 123);
	assert.equal(f.budget().counters.outputTokens, 45);
	assert.equal(f.budget().counters.physicalCalls, 1);
	assert.equal(f.budget().reservations[0].status, 'interrupted');
});

test('interrupted accounted QA uses a fresh charged slot and replays its successful retry for free', async t => {
	const options = { error: new Error('offline timeout') };
	const f = fixture(t, options);
	await assert.rejects(f.run(), /offline timeout/);
	delete options.error;
	const retried = await f.run();
	assert.equal(retried.status, 'PASS');
	assert.equal(f.calls.length, 2);
	assert.notEqual(f.calls[0].operationId, f.calls[1].operationId);
	assert.deepEqual(f.budget().reservations.map(entry => entry.status), ['interrupted', 'consumed']);
	assert.equal(f.budget().counters.logicalDispatches, 2);
	const before = f.budget();
	assert.equal((await f.run()).status, 'PASS');
	assert.equal(f.calls.length, 2);
	assert.deepEqual(f.budget(), before);
});

test('malformed token totals fail closed instead of silently charging zero', async t => {
	const f = fixture(t, { charge: { promptTokens: 2, completionTokens: 3, totalTokens: 4,
		physicalCalls: 1, costMicrousd: 0, premiumRequestUnits: 0 } });
	await assert.rejects(f.run(), /accounting/i);
	assert.equal(f.budget().reservations[0].status, 'interrupted');
	assert.equal(f.store.listCriticReviews(f.runId).length, 0);
});

test('QA charges every reconciled failed and successful physical attempt', async t => {
	const f = fixture(t, { charges: [
		{ promptTokens: 40, completionTokens: 0, totalTokens: 40, physicalCalls: 1 },
		{ promptTokens: 60, completionTokens: 20, totalTokens: 80, physicalCalls: 1 },
	] });
	assert.equal((await f.run()).status, 'PASS');
	assert.equal(f.budget().counters.physicalCalls, 2);
	assert.equal(f.budget().counters.inputTokens, 100);
	assert.equal(f.budget().counters.outputTokens, 20);
});

test('follow-up resource limits use freshly charged remaining budget and replay does not recharge', async t => {
	const f = fixture(t, { followUp: true, policy: { followUpDispatches: 1 } });
	assert.equal((await f.run()).status, 'PASS');
	assert.equal(f.calls.length, 2);
	assert.deepEqual(f.calls[0].requestedLimits, {
		maxPromptTokens: 10000, maxCompletionTokens: 666, maxPhysicalAttempts: 3, maxRetriesPerRoute: 2, maxFailovers: 0,
	});
	assert.deepEqual(f.calls[1].requestedLimits, {
		maxPromptTokens: 14938, maxCompletionTokens: 977, maxPhysicalAttempts: 2, maxRetriesPerRoute: 1, maxFailovers: 0,
	});
	assert.equal(f.budget().counters.inputTokens, 246);
	assert.equal(f.budget().counters.outputTokens, 90);
	assert.equal(f.budget().counters.physicalCalls, 2);
	const before = f.budget();
	assert.equal((await f.run()).status, 'PASS');
	assert.equal(f.calls.length, 2);
	assert.deepEqual(f.budget(), before);
});

test('synthetic provider-free QA still cannot exceed logical dispatch capacity', async t => {
	const f = fixture(t, { synthetic: true, maxPhysicalAttempts: 1, policy: {
		review: { maxLogicalDispatches: 1, maxPhysicalCalls: 3, maxInputTokens: 10_000, maxOutputTokens: 2_000 },
	} });
	assert.equal((await f.run()).status, 'PASS');
	assert.equal(f.budget().counters.logicalDispatches, 1);
	assert.equal(f.budget().counters.physicalCalls, 0);
	assert.equal(f.budget().counters.inputTokens, 0);
	assert.equal(f.budget().counters.outputTokens, 0);
	const next = { ...f.request, context: { ...f.request.context, closure: {
		...f.request.context.closure, binding: { ...f.request.context.closure.binding,
			checkpointId: 'slice-two', ownerId: 'slice-two', treeSha: '3'.repeat(40) },
	} } };
	next.context.plan = { ...next.context.plan,
		evidenceObligations: next.context.plan.evidenceObligations.map(entry => ({
			...entry, owner: { kind: 'slice', id: 'slice-two' },
		})) };
	assert.equal((await runCheckpointQaCritic(next)).status, 'BUDGET_EXHAUSTED');
	assert.equal(f.calls.length, 1);
});

test('an old reservation without a durable ceiling halts explicitly without spending on a different candidate', async t => {
	const f = fixture(t);
	f.store.quality.reserveBudget(f.runId, {
		operationId: 'lost-dispatch', kind: 'review', checkpointId: 'other-slice', candidateRevision: 0, status: 'reserved',
	});
	await assert.rejects(f.run(), /lacks durable dispatch limits; operator reconciliation required/);
	assert.equal(f.calls.length, 0);
});

test('hard-crash QA reservations are conservatively charged once and a fresh slot may run', async t => {
	const f = fixture(t, { reviewInputTokens: 20_000 });
	const loadRole = f.request.runtime.registry.loadRole.bind(f.request.runtime.registry);
	f.request.runtime.registry = { ...f.request.runtime.registry,
		rootDir: f.request.runtime.registry.rootDir,
		loadRole: id => ({ ...loadRole(id), role: {
			requestedLimits: { maxPhysicalAttempts: 1, maxPromptTokens: 6_000, maxCompletionTokens: 500 },
		} }),
	};
	const reserve = f.store.quality.reserveBudget;
	let crash = true;
	f.store.quality.reserveBudget = (...args) => {
		const result = reserve(...args);
		if (crash) { crash = false; throw new Error('injected crash after durable reservation'); }
		return result;
	};
	await assert.rejects(f.run(), /injected crash/);
	assert.equal(f.calls.length, 0);
	assert.equal((await f.run()).status, 'PASS');
	assert.deepEqual(f.budget().reservations.map(entry => entry.status), ['interrupted', 'consumed']);
	assert.equal(f.budget().counters.physicalCalls, 2);
	assert.equal(f.budget().counters.inputTokens, 6_123);
	assert.equal(f.budget().counters.outputTokens, 545);
	const charged = f.budget();
	assert.equal((await f.run()).status, 'PASS');
	assert.deepEqual(f.budget(), charged);
	assert.equal(f.calls.length, 1);
});

test('provider overrun remains charged but cannot produce a passing review', async t => {
	const f = fixture(t, { reviewInputTokens: 10_000, maxPhysicalAttempts: 1,
		charge: { promptTokens: 10_001, completionTokens: 45, totalTokens: 10_046,
		physicalCalls: 1, costMicrousd: 0, premiumRequestUnits: 0 } });
	await assert.rejects(f.run(), /exceeded.*resource limits/i);
	assert.equal(f.budget().counters.inputTokens, 10_001);
	assert.equal(f.store.listCriticReviews(f.runId).length, 0);
	assert.equal((await f.run()).status, 'BUDGET_EXHAUSTED');
	assert.equal(f.calls.length, 1);
});

test('a budget too small for complete QA context fails before any provider dispatch', async t => {
	const f = fixture(t, { reviewInputTokens: 1_000 });
	await assert.rejects(f.run(), error => error.code === 'INPUT_OVERSIZED');
	assert.equal(f.calls.length, 0);
	assert.equal(f.store.listCriticReviews(f.runId).length, 0);
	assert.equal(f.budget().counters.physicalCalls, 0);
});

test('real replay cannot reuse PASS when its exact governed accounting is no longer provable', async t => {
	const f = fixture(t);
	assert.equal((await f.run()).status, 'PASS');
	f.request.runtime.governor.getRunUsageLedger = () => null;
	assert.equal((await f.run()).status, 'BUDGET_EXHAUSTED');
	assert.equal(f.calls.length, 1);
});
