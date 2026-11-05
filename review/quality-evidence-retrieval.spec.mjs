import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { sha256 } from '../policy/contracts.ts';
import { makeFixture } from '../testing/test-support.mjs';
import { runCheckpointQaCritic } from './qa-checkpoint.ts';
import { makeQualityRetrievalRequest, retrieveQualitySource } from './quality-evidence-retrieval.ts';

const policy = {
	retrieval: {
		maxPacketBytes: 24_576,
		maxPacketLines: 80,
		maxTotalBytesPerCandidate: 49_152,
		maxTotalLinesPerCandidate: 2_000,
	},
};
const obligations = [{
	obligationId: 'obligation-one',
	implementationPaths: ['review/critic-budget.ts'],
}];

test('retrieval rejects a symlinked parent directory even when the final file is regular', t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-retrieval-path-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, 'candidate'));
	fs.mkdirSync(path.join(root, 'outside'));
	fs.writeFileSync(path.join(root, 'outside/critic-budget.ts'), 'outside source\n');
	fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'candidate/review'));
	const request = makeQualityRetrievalRequest({
		findings: [{ file: 'review/critic-budget.ts', lineRange: [1, 1] }], obligations,
		bindingHash: 'a'.repeat(64), reviewOperationId: 'qa-operation-one',
	});
	const result = retrieveQualitySource({
		worktreeDir: path.join(root, 'candidate'), request, policy,
		alreadyRetrievedBytes: 0, alreadyRetrievedLines: 0,
	});
	assert.equal(result.response.outcome, 'unavailable');
	assert.deepEqual(result.files, []);
});

test('retrieves only a reviewer-cited, declared production range and returns bounded provenance', () => {
	const request = makeQualityRetrievalRequest({
		findings: [{
			file: 'review/critic-budget.ts',
			lineRange: [1, 3],
		}],
		obligations,
		bindingHash: 'a'.repeat(64),
		reviewOperationId: 'qa-operation-one',
	});
	assert.ok(request);
	assert.deepEqual(request.selector, { kind: 'lines', start: 1, end: 3 });
	const result = retrieveQualitySource({
		worktreeDir: process.cwd(),
		request,
		policy,
		alreadyRetrievedBytes: 1_000,
		alreadyRetrievedLines: 10,
	});
	assert.equal(result.response.outcome, 'complete');
	assert.equal(result.response.ranges[0].start, 1);
	assert.equal(result.response.ranges[0].end, 3);
	assert.equal(result.files[0].content.split('\n').length, 3);
	assert.equal(result.response.fileHash, crypto.createHash('sha256')
		.update(fs.readFileSync(path.join(process.cwd(), request.file))).digest('hex'));
});

test('does not form retrieval requests for undeclared sources, missing ranges, or empty findings', () => {
	for (const findings of [
		[],
		[{ file: 'review/foreign.ts', lineRange: [1, 2] }],
		[{ file: 'review/critic-budget.ts' }],
	]) {
		assert.equal(makeQualityRetrievalRequest({
			findings,
			obligations,
			bindingHash: 'a'.repeat(64),
			reviewOperationId: 'qa-operation-one',
		}), null);
	}
});

test('bounds retrieval by remaining candidate bytes and rejects empty retrieval requests', () => {
	const request = makeQualityRetrievalRequest({
		findings: [{ file: 'review/critic-budget.ts', lineRange: [1, 2] }],
		obligations,
		bindingHash: 'a'.repeat(64),
		reviewOperationId: 'qa-operation-one',
	});
	assert.ok(request);
	const exhausted = retrieveQualitySource({
		worktreeDir: process.cwd(),
		request,
		policy,
		alreadyRetrievedBytes: policy.retrieval.maxTotalBytesPerCandidate,
		alreadyRetrievedLines: 0,
	});
	assert.equal(exhausted.response.outcome, 'unavailable');
	assert.deepEqual(exhausted.files, []);
	assert.throws(() => makeQualityRetrievalRequest({
		findings: [{ file: '../outside.ts', lineRange: [1, 1] }],
		obligations: [{ obligationId: 'bad-path', implementationPaths: ['../outside.ts'] }],
		bindingHash: 'a'.repeat(64),
		reviewOperationId: 'qa-operation-one',
	}));
});

test('checkpoint QA persists one bounded production follow-up and lets it discharge a P1', async () => {
	const fixture = makeFixture('qa-follow-up-retrieval', [
		{
			__role: 'critic',
			status: 'FAIL',
			findings: [{
				severity: 'P1',
				category: 'correctness',
				file: 'src/production.ts',
				lineRange: [2, 3],
				evidence: 'The result branch is not validated.',
				impact: 'Invalid results can reach the caller.',
				remediation: 'Validate the branch.',
			}],
		},
		{ __role: 'critic', status: 'PASS', findings: [] },
	]);
	try {
		const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'Review production evidence' });
		const worktreeDir = path.join(fixture.runtimeDir, 'checkpoint');
		fs.mkdirSync(path.join(worktreeDir, 'src'), { recursive: true });
		fs.writeFileSync(path.join(worktreeDir, 'src/production.ts'), 'export function run() {\n  return true;\n}\n');
		fs.writeFileSync(path.join(worktreeDir, 'src/production.spec.ts'), 'assert.equal(run(), true);\n');
		const policy = {
			schemaVersion: '1.0.0',
			policyId: 'checkpoint-evidence-v1',
			additionalCandidateReviews: 0,
			followUpDispatches: 1,
			testRetryPolicy: 'clean-success',
			retrieval: {
				maxPacketBytes: 24_576,
				maxPacketLines: 1_000,
				maxTotalBytesPerCandidate: 49_152,
				maxTotalLinesPerCandidate: 2_000,
			},
			execution: { maxInvocations: 2, maxTotalDurationMs: 10_000 },
			review: { maxLogicalDispatches: 2, maxPhysicalCalls: 2, maxInputTokens: 16_000, maxOutputTokens: 2_000 },
		};
		const policyHash = sha256(policy);
		fixture.store.quality.initializeBudget({
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			qualityPolicyHash: policyHash,
			revision: 0,
			counters: {
				executionInvocations: 0,
				executionDurationMs: 0,
				logicalDispatches: 0,
				physicalCalls: 0,
				inputTokens: 0,
				outputTokens: 0,
			},
			reservations: [],
		}, policy);
		const binding = {
			runId: fixture.runId,
			approvedSpecHash: 'b'.repeat(64),
			taskPlanHash: 'c'.repeat(64),
			qualityPolicyHash: policyHash,
			checkpointId: 'slice-one',
			checkpointKind: 'slice',
			ownerId: 'slice-one',
			candidateRevision: 0,
			baseCommitSha: 'd'.repeat(40),
			treeSha: 'e'.repeat(40),
			revisionSetHash: 'f'.repeat(64),
			preparationHash: '1'.repeat(64),
		};
		const obligation = {
			obligationId: 'obligation-one',
			criterionId: 'AC-01',
			caseId: 'AC-01.1',
			owner: { kind: 'slice', id: 'slice-one' },
			observableOutcome: 'The user-visible result is validated.',
			setupAction: 'Invoke the operation with a valid input.',
			expectedResult: 'The validated result is returned.',
			layer: 'unit',
			requiredCapabilities: [],
			implementationPaths: ['src/production.ts'],
			testCases: [{ file: 'src/production.spec.ts', caseKey: 'case-one' }],
			adapterBindingHash: '2'.repeat(64),
			profileId: 'unit',
		};
		const receiptHash = '3'.repeat(64);
		fixture.store.quality.getEvidenceCompletionByReceiptHash = () => ({
			receipt: { status: 'passed', dischargedObligationIds: ['obligation-one'] },
			invocation: { status: 'completed', reportHash: '4'.repeat(64) },
			report: {
				cases: [{
					file: 'src/production.spec.ts',
					caseKey: 'case-one',
					obligationIds: ['obligation-one'],
					outcome: 'passed',
					exercisedCapabilities: [],
					attempts: [{ index: 0, outcome: 'passed', durationMs: 1 }],
				}],
			},
		});
		const snapshot = {
			...initial,
			state: 'REVIEWING_QA',
			runId: fixture.runId,
			approvedSpecHash: binding.approvedSpecHash,
			taskPlanHash: binding.taskPlanHash,
			activeGeneration: 0,
			qualityCheckpointKind: 'slice',
			qualityCheckpointBindingHash: '5'.repeat(64),
		};
		const reviewOptions = {
			runtime: {
				runtimeStore: fixture.store,
				registry: fixture.registry,
				governor: fixture.governor,
				artifactStore: fixture.artifacts,
			},
			snapshot,
			context: {
				plan: {
					schemaVersion: '2.0.0',
					slices: [{ sliceId: 'slice-one' }],
					tasks: [{ taskId: 'task-one', sliceId: 'slice-one' }],
					evidenceObligations: [obligation],
				},
				policy,
				closure: { binding, receiptHashes: [receiptHash] },
				worktreeDir,
			},
		};
		const result = await runCheckpointQaCritic(reviewOptions);

		assert.equal(result.status, 'PASS');
		assert.equal(result.hasP1, false);
		assert.equal(result.retrievalArtifacts.length, 1);
		const [artifacts] = result.retrievalArtifacts;
		const request = fixture.artifacts.readJson(artifacts.requestArtifact);
		const response = fixture.artifacts.readJson(artifacts.responseArtifact);
		assert.equal(request.file, 'src/production.ts');
		assert.deepEqual(request.selector, { kind: 'lines', start: 2, end: 3 });
		assert.equal(response.outcome, 'complete');
		assert.match(response.ranges[0].text, /return true/);
		const budget = fixture.store.quality.getBudget(fixture.runId);
		assert.equal(budget.counters.logicalDispatches, 2);
		assert.deepEqual(budget.reservations.map((entry) => entry.kind), ['review', 'follow-up']);
		const [reviewReservation, followUpReservation] = budget.reservations;
		assert.equal(request.reviewOperationId, reviewReservation.operationId);
		assert.equal(request.operationId, followUpReservation.operationId);
		assert.equal(request.bindingHash, sha256(binding));
		assert.equal(response.requestHash, sha256(request));
		for (const reservation of budget.reservations) {
			assert.equal(reservation.checkpointId, 'slice-one');
			assert.equal(reservation.candidateRevision, 0);
			assert.equal(reservation.status, 'consumed');
		}
		assert.equal(fixture.store.listCriticReviews(fixture.runId).filter((entry) => entry.phase === 'qa').length, 2);
		const dispatched = fixture.governor.calls.length;
		const replay = await runCheckpointQaCritic(reviewOptions);
		assert.equal(replay.status, 'PASS');
		assert.equal(replay.hasP1, false);
		assert.equal(replay.artifactHash, result.artifactHash);
		assert.equal(fixture.governor.calls.length, dispatched);
		assert.deepEqual(fixture.store.quality.getBudget(fixture.runId), budget);
		assert.throws(() => fixture.store.quality.reserveBudget(fixture.runId, {
			operationId: 'unapproved-second-follow-up',
			kind: 'follow-up',
			checkpointId: 'slice-one',
			candidateRevision: 0,
			status: 'reserved',
		}), /follow-up budget exhausted/);
		const changedCandidate = await runCheckpointQaCritic({
			...reviewOptions,
			context: {
				...reviewOptions.context,
				closure: {
					...reviewOptions.context.closure,
					binding: { ...binding, candidateRevision: 1, treeSha: '6'.repeat(40) },
				},
			},
		});
		assert.equal(changedCandidate.status, 'BUDGET_EXHAUSTED');
		assert.equal(fixture.governor.calls.length, dispatched);
		assert.deepEqual(fixture.store.quality.getBudget(fixture.runId), budget);
	} finally {
		fixture.close();
	}
});
