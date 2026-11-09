import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../cli.ts';
import { validatePendingResponse } from '../hitl.ts';
import { taskQualityFixture } from '../../testing/task-quality-fixture.ts';
import { SdlcWorkflowRuntime } from '../../workflow/graph.ts';
import { approvedInputHash, parseSpecification } from '../../workflow/specification.ts';
import { SdlcError } from '../../policy/errors.ts';

const H = 'a'.repeat(64);
const answer = {
	schemaVersion: '1.0.0', answerId: 'answer-a', interruptId: 'interrupt-a',
	bindingHash: H, action: 'confirm', findingIds: ['finding-a'], evidenceHashes: [],
	rationale: 'The finding is confirmed.', correction: null,
};

async function fixture(t, allowedActions = ['confirm'], requestMetadata = {}) {
	const f = taskQualityFixture(t);
	const runtime = new SdlcWorkflowRuntime({
		runtimeStore: f.store, artifactStore: f.artifacts, registry: f.runtime.registry,
		governor: f.runtime.governor, gitCli: f.runtime.gitCli, execCli: f.runtime.execCli,
	});
	const draft = parseSpecification('Expose a visible value');
	const draftArtifact = f.artifacts.writeJson('cli-draft', draft);
	const updates = {
		...f.snapshot, ...f.runtime.registry.load().hashes, state: 'BLOCKED',
		pendingInterruptId: answer.interruptId, blockedReason: 'QUALITY_REVIEW_BLOCKED',
		qualityPolicy: f.plan.qualityPolicy, qualityCheckpointId: 'vertical',
		qualityCheckpointKind: 'slice', qualityCheckpointTreeSha: f.tree,
		qualityCheckpointSliceId: 'vertical',
		qualityCheckpointBindingHash: H,
		goalArtifact: f.artifacts.writeText('goal', 'Expose a visible value'),
		draftArtifact, draftHash: approvedInputHash(draft),
	};
	const state = runtime.transition(f.store.getRun(f.runId), {
		to: 'BLOCKED', eventType: 'RUN_BLOCKED', causalId: 'fixture-quality-block',
		updates, payload: {},
	});
	const request = { kind: 'quality_review', stateHash: H,
		expectedResponse: { interruptId: answer.interruptId }, bindingHash: H,
		allowedActions, findings: [{ findingId: 'finding-a' }], ...requestMetadata };
	f.store.createInterrupt({
		runId: f.runId, interruptId: answer.interruptId, kind: 'quality_review',
		stateHash: H, requestArtifact: f.artifacts.writeJson('quality-review', request),
		createdAt: new Date().toISOString(),
	});
	f.store.quality.bindInterrupt({
		runId: f.runId, interruptId: answer.interruptId, bindingHash: H,
		findingIds: typeof request.failureId === 'string' ? [request.failureId] : answer.findingIds,
		expectedRevisions: [], affectedTaskIds: [],
	});
	await runtime.start(state);
	return { ...f, runtime, request, state };
}

test('CLI confirms a failed-correction candidate and manual resume cannot dispatch or change counters', async t => {
	const failureId = 'failure-correction-conflict';
	const f = await fixture(t, ['confirm'], {
		schemaVersion: '1.0.0', interruptId: answer.interruptId,
		checkpointId: 'failed-correction-correction-a', checkpointKind: 'slice',
		status: 'CORRECTION_FAILED', reason: "Closure delta conflict for 'consumer-task'",
		failureId, findings: [], failedCorrectionId: 'correction-a',
		failedCandidate: { correctionId: 'correction-a', originalBindingHash: 'b'.repeat(64),
			failedCheckpointBindingHash: H, stagedRevisions: [], integrationObservation: null, failedClosures: [] },
		resolution: 'Confirm acknowledges the halted correction; it does not accept edits or authorize a new correction.',
	});
	const options = { rootDir: f.rootDir, governor: f.runtime.governor,
		gitCli: f.runtime.gitCli, execCli: f.runtime.execCli, continueAfterAnswerRecord: true };
	const acknowledgement = { ...answer, findingIds: [failureId] };
	const filename = path.join(f.rootDir, 'failed-correction-answer.json');
	fs.writeFileSync(filename, JSON.stringify(acknowledgement));
	const budget = f.store.quality.getBudget(f.runId);
	const calls = f.runtime.governor.calls.length, commands = f.commandCount();
	const answered = await runCli(['answer', '--run', f.runId, '--interrupt', answer.interruptId,
		'--response-file', filename], options);
	assert.equal(answered.result.blockedReason, 'QUALITY_CONFIRMED', JSON.stringify(answered));
	assert.equal(f.store.getRun(f.runId).pendingInterruptId, null);
	assert.equal(f.store.getRun(f.runId).lastError.metadata.qualityRecoveryAllowed, false);
	const status = await runCli(['status', '--run', f.runId], options);
	assert.deepEqual(status.result.continuation, { action: 'stop', reason: 'HALTED' });
	const beforeResume = f.store.getRun(f.runId);
	for (let attempt = 0; attempt < 2; attempt++) {
		const resumed = await runCli(['resume', '--run', f.runId], options);
		assert.deepEqual(resumed.result.continuation, { action: 'stop', reason: 'HALTED' });
	}
	assert.deepEqual(f.store.getRun(f.runId), beforeResume);
	assert.equal(f.runtime.governor.calls.length, calls);
	assert.equal(f.commandCount(), commands);
	assert.deepEqual(f.store.quality.getBudget(f.runId), budget);
	assert.deepEqual(f.artifacts.readJson(f.store.getInterrupt(answer.interruptId).responseArtifact), acknowledgement);
});

test('a stale correction budget is rejected before recording and does not lock the interrupt', async t => {
	const f = await fixture(t, ['confirm', 'approve-correction']);
	const filename = path.join(f.rootDir, 'answer.json');
	const options = { rootDir: f.rootDir, governor: f.runtime.governor,
		gitCli: f.runtime.gitCli, execCli: f.runtime.execCli, continueAfterAnswerRecord: true };
	const args = ['answer', '--run', f.runId, '--interrupt', answer.interruptId, '--response-file', filename];
	fs.writeFileSync(filename, JSON.stringify({
		...answer, action: 'approve-correction', correction: {
			owners: [{ taskId: 'vertical-task', expectedRevision: 0, editPaths: ['src/a.ts'] }],
			rerunObligationIds: ['visible'], maxSourceEditIterations: 1, expectedBudgetLedgerHash: H,
		},
	}));
	const result = await runCli(args, options);
	assert.match(result.result.error.message, /stale budget/);
	assert.equal(f.store.getPendingInterrupt(f.runId).status, 'PENDING');
	fs.writeFileSync(filename, JSON.stringify(answer));
	assert.equal((await runCli(args, options)).result.blockedReason, 'QUALITY_CONFIRMED');
});

for (const command of ['answer', 'resume']) {
	test(`CLI ${command} accepts a strict quality answer and consumes it through the graph`, async t => {
		const f = await fixture(t);
		const filename = path.join(f.rootDir, 'answer.json');
		fs.writeFileSync(filename, JSON.stringify(answer));
		const args = command === 'answer'
			? ['answer', '--run', f.runId, '--interrupt', answer.interruptId, '--response-file', filename]
			: ['resume', '--run', f.runId, '--response-file', filename];
		const result = await runCli(args, {
			rootDir: f.rootDir, governor: f.runtime.governor, continueAfterAnswerRecord: true,
			gitCli: f.runtime.gitCli, execCli: f.runtime.execCli,
		});
		assert.equal(result.result.blockedReason, 'QUALITY_CONFIRMED', JSON.stringify(result));
		assert.equal(f.store.getPendingInterrupt(f.runId), null);
		const stored = f.store.getInterrupt(answer.interruptId);
		assert.deepEqual(f.artifacts.readJson(stored.responseArtifact), answer);
	});
}

test('quality CLI validation rejects stale bindings, null payloads and unapproved actions', async t => {
	const f = await fixture(t);
	const interrupt = f.store.getPendingInterrupt(f.runId);
	const validate = response => validatePendingResponse({
		state: f.state, interrupt, request: f.request, response,
	});
	assert.deepEqual(validate(answer).response, answer);
	for (const response of [null, {}, { ...answer, interruptId: 'stale' },
		{ ...answer, bindingHash: 'b'.repeat(64) }, { ...answer, action: 'refute', evidenceHashes: [H] }]) {
		assert.throws(() => validate(response));
	}
});

test('CLI resume recovers an answer consumed before a crash without another operator answer', async t => {
	const f = await fixture(t);
	const options = { rootDir: f.rootDir, governor: f.runtime.governor,
		gitCli: f.runtime.gitCli, execCli: f.runtime.execCli };
	const failed = await runCli(['resume', '--run', f.runId, '--response', JSON.stringify(answer)], {
		...options, onBoundary(name) {
			if (name === 'quality-answer-consumed') throw new Error('injected consumed-answer crash');
		},
	});
	assert.match(failed.result.error.message, /injected consumed-answer crash/);
	assert.equal(f.store.getPendingInterrupt(f.runId), null);
	assert.equal(f.store.getRun(f.runId).pendingInterruptId, answer.interruptId);
	const status = await runCli(['status', '--run', f.runId], options);
	assert.equal(status.result.continuation.action, 'resume', JSON.stringify(status));
	assert.equal(status.result.hostInvocation.executable, true);
	const recovered = await runCli(['resume', '--run', f.runId], options);
	assert.equal(recovered.result.blockedReason, 'QUALITY_CONFIRMED', JSON.stringify(recovered));
	assert.equal(f.store.getRun(f.runId).pendingInterruptId, null);
});

test('foreign finding ids are rejected before durable recording and a corrected answer remains usable', async t => {
	const f = await fixture(t);
	const filename = path.join(f.rootDir, 'answer.json');
	const options = { rootDir: f.rootDir, governor: f.runtime.governor,
		gitCli: f.runtime.gitCli, execCli: f.runtime.execCli, continueAfterAnswerRecord: true };
	const args = ['answer', '--run', f.runId, '--interrupt', answer.interruptId, '--response-file', filename];
	fs.writeFileSync(filename, JSON.stringify({ ...answer, findingIds: ['foreign'] }));
	const rejected = await runCli(args, options);
	assert.equal(rejected.result.error.code, 'INVALID_INPUT');
	assert.equal(f.store.getPendingInterrupt(f.runId).status, 'PENDING');
	fs.writeFileSync(filename, JSON.stringify(answer));
	assert.equal((await runCli(args, options)).result.blockedReason, 'QUALITY_CONFIRMED');
});

for (const deterministic of [false, true]) {
	test(`consumed-answer ${deterministic ? 'deterministic' : 'repeated transient'} failure halts bounded CLI recovery`, async t => {
		const f = await fixture(t);
		let calls = 0;
		const options = { rootDir: f.rootDir, governor: f.runtime.governor,
			gitCli: f.runtime.gitCli, execCli: f.runtime.execCli, onBoundary(name) {
				if (name !== 'quality-answer-consumed') return;
				calls++;
				if (deterministic) throw new SdlcError('INVALID_CONTRACT', 'Unrepairable checkpoint provenance');
				throw new Error('persistent infrastructure failure');
			} };
		const args = ['resume', '--run', f.runId];
		await runCli([...args, '--response', JSON.stringify(answer)], options);
		if (!deterministic) for (let n = 0; n < 2; n++) await runCli(args, options);
		assert.equal(calls, deterministic ? 1 : 3);
		const status = await runCli(['status', '--run', f.runId], options);
		assert.deepEqual(status.result.continuation, { action: 'stop', reason: 'HALTED' });
		await runCli(args, options);
		assert.equal(calls, deterministic ? 1 : 3);
		assert.equal(f.store.getRun(f.runId).lastError.metadata.qualityRecoveryAllowed, false);
	});
}
