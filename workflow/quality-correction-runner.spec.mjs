import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { captureTaskDelta } from '../execution/task-tree-delta.ts';
import { eligibleParentTasks, materializeClosureTree } from '../execution/eligible-closure.ts';
import { liveRunRoot } from '../persistence/run-paths.ts';
import { RuntimeStore } from '../persistence/runtime-store.ts';
import { ArtifactStore } from '../persistence/artifacts.ts';
import { sha256 } from '../policy/contracts.ts';
import { executePreflightVerifier } from '../review/verifier.ts';
import { runCheckpointQaCritic } from '../review/qa-checkpoint.ts';
import { FakeModelGovernor } from '../testing/fake-model-governor.mjs';
import { taskQualityFixture } from '../testing/task-quality-fixture.mjs';
import { createSyntheticCommit } from './worktrees.ts';
import { prepareFinalQualityCheckpoint } from './final-quality-checkpoint.ts';
import { reconcileTasks } from './reconciliation.ts';
import { runApprovedQualityCorrection } from './quality-correction-runner.ts';
import { SdlcWorkflowRuntime } from './graph.ts';
import { routeFromStart } from './graph-topology.ts';
import { createAskQualityAnswerNode, createApplyQualityAnswerNode } from './nodes/quality-answer.ts';
import { computeContinuation } from '../cli/continuation.ts';

const weakTest = criterion => `import assert from 'node:assert/strict';\nimport test from 'node:test';\n` +
	`test('@ac ${criterion} @case ${criterion}.1 visible', () => { assert.equal(1, 1); });\n`;
const strongTest = `import assert from 'node:assert/strict';\nimport test from 'node:test';\n` +
	`import { value } from './a.ts';\ntest('@ac AC-01 @case AC-01.1 visible', () => { assert.equal(value, 2); });\n`;
const consumerSource = Buffer.concat([Buffer.from('export const consumer = true;\n// caf'), Buffer.from([0xe9, 0x0a])]);
const consumerBinary = Buffer.from([0, 0xff, 1, 0xfe, 2]);

async function completeTask(f, taskId, files = {}) {
	const plan = f.store.getTaskPlan(f.runId);
	const task = plan.tasks.find(entry => entry.taskId === taskId);
	const parentTreeSha = materializeClosureTree({ baseTreeSha: f.tree,
		tasks: eligibleParentTasks(plan, taskId), rootDir: f.rootDir, gitCli: execFileSync });
	const worktreeDir = path.join(liveRunRoot(f.rootDir), f.runId, 'worktrees', taskId);
	if (!fs.existsSync(worktreeDir)) {
		const commit = createSyntheticCommit({ parentTreeSha, baseCommitSha: f.base,
			message: 'fixture task parent', rootDir: f.rootDir, gitCli: execFileSync });
		execFileSync('git', ['worktree', 'add', '--quiet', '--detach', worktreeDir, commit], { cwd: f.rootDir });
	}
	for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(worktreeDir, file), content);
	const candidate = { ...task, parentTreeSha };
	Object.assign(candidate, captureTaskDelta({ task: candidate, worktreeDir, rootDir: f.rootDir,
		gitCli: execFileSync, rawPatchHash: true }));
	await f.session.hooks.verifyTask(candidate, worktreeDir);
}

function sliceSnapshot(f, closure) {
	return { ...f.snapshot, state: 'REVIEWING_QA', authorVendor: 'google',
		qualityPolicy: f.plan.qualityPolicy, qualityCheckpointId: closure.binding.checkpointId,
		qualityCheckpointKind: 'slice', qualityCheckpointSliceId: closure.binding.ownerId,
		qualityCheckpointTreeSha: closure.binding.treeSha, qualityCheckpointBindingHash: sha256(closure.binding) };
}

for (const interruption of ['none', 'consumer-conflict', 'completion', 'completion-route', 'task-parent', 'source-edit', 'source-edit-route', 'quality-correction-revision-captured',
	'corrected-final-reset-intent-recorded', 'corrected-final-reset',
	'corrected-final-checkout', 'corrected-final-ready', 'corrected-final-evidence', 'final-tamper']) test(
	`approved final correction reconstructs owning and consumer deltas after ${interruption}`,
	async t => {
	const f = taskQualityFixture(t, { withConsumer: true, overlappingConsumer: interruption === 'consumer-conflict' });
	await completeTask(f, 'enable-task');
	await f.session.prepareSlice('enable', f.store.getTaskPlan(f.runId));
	for (const [taskId, sliceId, files] of [
		['vertical-task', 'vertical', { 'src/a.spec.mjs': weakTest('AC-01') }],
		['consumer-task', 'consumer', { 'src/b.ts': consumerSource, 'src/b.bin': consumerBinary, 'src/b.spec.mjs': weakTest('AC-02'),
			...(interruption === 'consumer-conflict' ? { 'src/a.ts': 'export const value = 3;\n' } : {}) }],
	]) {
		await completeTask(f, taskId, files);
		const closure = await f.session.prepareSlice(sliceId, f.store.getTaskPlan(f.runId));
		const registration = f.store.quality.getWorktree(f.runId, closure.registryId);
		const result = await runCheckpointQaCritic({ runtime: f.runtime, snapshot: sliceSnapshot(f, closure),
			context: { plan: f.plan, policy: f.plan.qualityPolicy, closure,
				worktreeDir: path.join(liveRunRoot(f.rootDir), f.runId, registration.relativePath) } });
		assert.equal(result.status, 'PASS');
		f.store.quality.setClosureStatus(f.runId, closure.binding.checkpointId, 0, 'accepted');
	}
	const initial = await reconcileTasks({ runId: f.runId, taskPlan: f.store.getTaskPlan(f.runId),
		rootDir: f.rootDir, gitCli: execFileSync, taskPlanFrozen: true });
	assert.equal(initial.status, 'RECONCILIATION_COMPLETED');
	const preflight = await executePreflightVerifier({ runId: f.runId, worktreeDir: initial.integrationWorktreePath,
		rootDir: f.rootDir, baseCommitSha: f.base, targetTreeSha: initial.reconciledTreeSha,
		artifactStore: f.artifacts, execCli: f.runtime.execCli });
	assert.equal(preflight.status, 'PASS');
	let snapshot = { ...f.snapshot, state: 'REVIEWING_QA', authorVendor: 'google', targetTreeSha: initial.reconciledTreeSha,
		integrationWorktreePath: initial.integrationWorktreePath,
		preflightBindingArtifact: f.artifacts.writeJson('fixture-preflight', preflight.binding) };
	snapshot = { ...snapshot, ...await prepareFinalQualityCheckpoint(f.runtime, snapshot, initial.integrationWorktreePath) };
	const final = f.store.quality.listClosures(f.runId).find(closure => closure.binding.checkpointId === snapshot.qualityCheckpointId);
	f.runtime.governor = new FakeModelGovernor([{ __role: 'critic', status: 'FAIL', findings: [{
		findingId: 'weak-value', severity: 'P1', category: 'testing', file: 'src/a.spec.mjs', lineRange: [3, 3],
		evidence: "test('@ac AC-01 @case AC-01.1 visible', () => { assert.equal(1, 1); });",
		failureMechanism: 'The assertion does not exercise the value', remediation: 'Assert the required value',
	}] }]);
	const failed = await runCheckpointQaCritic({ runtime: f.runtime, snapshot,
		context: { plan: f.plan, policy: f.plan.qualityPolicy, closure: final, worktreeDir: initial.integrationWorktreePath } });
	assert.equal(failed.hasP1, true, JSON.stringify(failed));
	const interruptId = 'correction-interrupt';
	f.store.createInterrupt({ interruptId, runId: f.runId, kind: 'quality_review', stateHash: sha256(snapshot),
		requestArtifact: f.artifacts.writeJson('fixture-quality-request', {}), createdAt: f.runtime.now().toISOString() });
	f.store.quality.bindInterrupt({ runId: f.runId, interruptId, bindingHash: sha256(final.binding),
		findingIds: ['weak-value'], expectedRevisions: [
			{ taskId: 'vertical-task', executionRevision: 0 }, { taskId: 'consumer-task', executionRevision: 0 },
		], affectedTaskIds: ['vertical-task', 'consumer-task'] });
	const answer = {
		schemaVersion: '1.0.0', answerId: 'correct-value', interruptId, bindingHash: sha256(final.binding),
		action: 'approve-correction', findingIds: ['weak-value'], evidenceHashes: [], rationale: 'Assert the required value of two',
		correction: { owners: [{ taskId: 'vertical-task', expectedRevision: 0, editPaths: ['src/a.ts', 'src/a.spec.mjs'] }],
			rerunObligationIds: ['visible', 'consumer'], maxSourceEditIterations: 1,
			expectedBudgetLedgerHash: f.store.quality.budgetHash(f.runId) },
	};
	const correctionId = `correction-${sha256(answer).slice(0, 40)}`;
	f.store.quality.consumeAnswer({ runId: f.runId, answer, expectedBindingHash: answer.bindingHash,
		affectedTaskIds: ['vertical-task', 'consumer-task'], correctionId });
	assert.equal(f.store.quality.getCurrentTaskRevision(f.runId, 'vertical-task'), null);
	f.runtime.governor = new FakeModelGovernor([
		{ action: { kind: 'tool_call', toolName: 'write_file', parameters: { path: 'src/a.ts', content: 'export const value = 2;\n' } } },
		{ action: { kind: 'tool_call', toolName: 'write_file', parameters: { path: 'src/a.spec.mjs', content: strongTest } } },
		{ action: { kind: 'complete', summary: 'The value and regression assertion are corrected' } },
	]);
	const durableRoute = interruption.endsWith('-route') ||
		['final-tamper', 'source-edit', 'consumer-conflict', 'task-parent'].includes(interruption);
	if (durableRoute) f.runtime.transition = (current, options) =>
		SdlcWorkflowRuntime.prototype.transition.call(f.runtime, current, options);
	const interruptCompletion = interruption === 'completion' || interruption === 'completion-route';
	const sourceEditFailure = interruption === 'source-edit' || interruption === 'source-edit-route';
	if (interruption === 'consumer-conflict') {
		const failed = await runApprovedQualityCorrection({ runtime: f.runtime, snapshot, answer, correctionId });
		assert.equal(failed.lastError.code, 'RECONCILIATION_CONFLICT');
		assert.equal(f.store.quality.getCorrection(f.runId, correctionId).status, 'failed');
		const calls = f.runtime.governor.calls.length, commands = f.commandCount();
		const budget = f.store.quality.getBudget(f.runId);
		assert.notEqual(failed.pendingInterruptId, answer.interruptId);
		const pending = f.store.getPendingInterrupt(f.runId);
		assert.equal(computeContinuation(failed, { pendingInterrupt: pending }).action, 'answer');
		for (let attempt = 0; attempt < 2; attempt++) {
			assert.deepEqual(await runApprovedQualityCorrection({
				runtime: f.runtime, snapshot: failed, answer, correctionId,
			}), f.store.getRun(f.runId));
		}
		assert.equal(f.runtime.governor.calls.length, calls);
		assert.equal(f.commandCount(), commands);
		assert.deepEqual(f.store.quality.getBudget(f.runId), budget);
		const request = f.runtime.artifactStore.readJson(pending.requestArtifact);
		assert.deepEqual(f.store.quality.getInterruptBinding(f.runId, pending.interruptId).expectedRevisions, []);
		assert.equal(failed.lastError.metadata.qualityRecoveryAllowed, undefined);
		const confirmed = await createApplyQualityAnswerNode(f.runtime)({
			snapshot: failed, humanResponse: {
				schemaVersion: '1.0.0', answerId: 'acknowledge-delta-conflict', interruptId: pending.interruptId,
				bindingHash: request.bindingHash, action: 'confirm', findingIds: [request.failureId],
				evidenceHashes: [], correction: null, rationale: 'Confirm the deterministic conflict and halt',
			},
		});
		assert.deepEqual(computeContinuation(confirmed.snapshot), { action: 'stop', reason: 'HALTED' });
		assert.equal(confirmed.snapshot.pendingInterruptId, null);
		assert.equal(confirmed.snapshot.lastError.metadata.qualityRecoveryAllowed, false);
		assert.deepEqual(await createApplyQualityAnswerNode(f.runtime)({
			snapshot: confirmed.snapshot, humanResponse: answer,
		}), { snapshot: f.store.getRun(f.runId) });
		assert.equal(f.store.quality.getCurrentTaskRevision(f.runId, 'vertical-task'), null);
		assert.deepEqual(await runApprovedQualityCorrection({
			runtime: f.runtime, snapshot: confirmed.snapshot, answer, correctionId,
		}), f.store.getRun(f.runId));
		assert.equal(f.runtime.governor.calls.length, calls);
		assert.equal(f.commandCount(), commands);
		assert.deepEqual(f.store.quality.getBudget(f.runId), budget);
		return;
	}
	let recoveryBudget = null;
	if (interruption !== 'none') {
		const complete = f.store.quality.completeCorrection;
		let interrupted = false;
		if (sourceEditFailure) f.runtime.governor.script.splice(1, 0, () => {
			interrupted = true;
			throw new Error('simulated interruption');
		});
		if (interruptCompletion) f.store.quality.completeCorrection = input => {
			if (!interrupted) { interrupted = true; throw new Error('simulated interruption'); }
			return complete(input);
		};
		if (interruption === 'task-parent') f.runtime.gitCli = (command, args, options) => {
			const result = execFileSync(command, args, options);
			if (!interrupted && args[0] === 'worktree' && args[1] === 'add' &&
				args.includes(path.join(liveRunRoot(f.rootDir), f.runId, 'worktrees', 'vertical-task-r1'))) {
				interrupted = true;
				throw new Error('simulated interruption');
			}
			return result;
		};
		f.runtime.onBoundary = async boundary => {
			if (!interrupted && (boundary === interruption ||
				(interruption === 'final-tamper' && boundary === 'corrected-final-ready'))) {
				interrupted = true;
				throw new Error('simulated interruption');
			}
		};
		if (sourceEditFailure || interruption === 'task-parent') {
			const halted = await runApprovedQualityCorrection({ runtime: f.runtime, snapshot, answer, correctionId });
			assert.equal(halted.state, 'BLOCKED');
		} else await assert.rejects(runApprovedQualityCorrection({ runtime: f.runtime, snapshot, answer, correctionId }),
			/simulated interruption/);
		assert.equal(interrupted, true);
		assert.equal(f.store.quality.getCurrentTaskRevision(f.runId, 'vertical-task'), null);
		if (durableRoute) {
			snapshot = f.store.getRun(f.runId);
			assert.equal(snapshot.state, 'BLOCKED');
			if (sourceEditFailure || interruption === 'task-parent') assert.notEqual(snapshot.pendingInterruptId, answer.interruptId);
			else assert.equal(snapshot.pendingInterruptId, answer.interruptId);
			assert.equal(snapshot.blockedReason, 'QUALITY_REVIEW_BLOCKED');
			assert.equal(routeFromStart({ snapshot }), 'ask_quality_answer');
			assert.equal(snapshot.lastError.metadata.recovery,
				sourceEditFailure || interruption === 'task-parent' ? 'operator-adjudication-required' : 'resume-persisted-correction');
			assert.equal(snapshot.lastError.metadata.qualityRecoveryAllowed,
				sourceEditFailure || interruption === 'task-parent' ? undefined : true);
			assert.equal(f.store.getInterrupt(answer.interruptId).status, 'RESOLVED');
		}
		const budget = f.store.quality.getBudget(f.runId);
		recoveryBudget = budget;
		const intent = f.store.quality.getFinalMaterialization(f.runId, correctionId);
		f.store.close();
		f.store = new RuntimeStore(path.join(liveRunRoot(f.rootDir), f.runId, 'runtime.sqlite'));
		t.after(() => f.store.close());
		f.store.getAuthorization = () => f.auth;
		f.runtime.runtimeStore = f.store;
		f.runtime.artifactStore = new ArtifactStore({ artifactsDir: f.artifacts.artifactsDir, runtimeStore: f.store });
		f.runtime.gitCli = execFileSync;
		f.runtime.onBoundary = async () => {};
		assert.deepEqual(f.store.quality.getBudget(f.runId), budget);
		assert.deepEqual(f.store.quality.getFinalMaterialization(f.runId, correctionId), intent);
		if (intent) {
			assert.throws(() => f.store.quality.beginFinalMaterialization({
				...intent.intent, binding: { ...intent.intent.binding, candidateRevision: 2 },
			}), /changed contents/);
			assert.throws(() => f.store.quality.beginFinalMaterialization(null));
			assert.throws(() => f.store.quality.beginFinalMaterialization({}));
		}
		if (durableRoute && !sourceEditFailure && interruption !== 'task-parent') {
			const replay = await createAskQualityAnswerNode(f.runtime)({ snapshot });
			assert.deepEqual(replay.humanResponse, answer);
		}
		if (interruption === 'final-tamper' || sourceEditFailure || interruption === 'task-parent') {
			if (interruption === 'final-tamper') fs.writeFileSync(
				path.join(initial.integrationWorktreePath, 'src/a.ts'), 'export const value = 99;\n');
			const calls = f.runtime.governor.calls.length;
			const halted = await (durableRoute
				? createApplyQualityAnswerNode(f.runtime)({ snapshot, humanResponse: answer })
				: runApprovedQualityCorrection({ runtime: f.runtime, snapshot, answer, correctionId }));
			assert.equal((halted.snapshot ?? halted).state, 'BLOCKED');
			assert.equal(f.runtime.governor.calls.length, calls);
			assert.deepEqual(f.store.quality.getBudget(f.runId), budget);
			assert.equal(f.store.quality.getTaskRevision(f.runId, 'vertical-task', 2), null);
			if (durableRoute) {
				assert.notEqual(f.store.getRun(f.runId).pendingInterruptId, answer.interruptId);
				assert.match(f.store.getRun(f.runId).lastError.message, /operator adjudication/);
				assert.equal(f.store.getRun(f.runId).lastError.metadata.recovery, 'operator-adjudication-required');
				assert.equal(f.store.getRun(f.runId).lastError.metadata.qualityRecoveryAllowed, undefined);
				const pending = f.store.getPendingInterrupt(f.runId);
				const request = f.runtime.artifactStore.readJson(pending.requestArtifact);
				assert.equal(request.failedCorrectionId, correctionId);
				assert.deepEqual(request.allowedActions, ['confirm']);
				assert.notEqual(request.bindingHash, answer.bindingHash);
				assert.ok(request.failedCandidate.stagedRevisions.length);
				const confirmed = await createApplyQualityAnswerNode(f.runtime)({
					snapshot: f.store.getRun(f.runId), humanResponse: {
						schemaVersion: '1.0.0', answerId: 'acknowledge-failed-candidate', interruptId: pending.interruptId,
						bindingHash: request.bindingHash, action: 'confirm', findingIds: [request.failureId],
						evidenceHashes: [], correction: null, rationale: 'Acknowledge this failed candidate; stop without accepting edits',
					},
				});
				assert.equal(confirmed.snapshot.blockedReason, 'QUALITY_CONFIRMED');
				assert.equal(confirmed.snapshot.pendingInterruptId, null);
				assert.equal(f.store.quality.getCurrentTaskRevision(f.runId, 'vertical-task'), null);
				assert.deepEqual(f.store.quality.getBudget(f.runId), budget);
			}
			return;
		}
	}
	const callsBeforeRecovery = f.runtime.governor.calls.length;
	const next = durableRoute
		? (await createApplyQualityAnswerNode(f.runtime)({ snapshot, humanResponse: answer })).snapshot
		: await runApprovedQualityCorrection({ runtime: f.runtime, snapshot, answer, correctionId });
	if (interruptCompletion) assert.equal(f.runtime.governor.calls.length, callsBeforeRecovery);
	if (interruption === 'corrected-final-evidence') {
		const budget = f.store.quality.getBudget(f.runId);
		assert.equal(budget.counters.executionInvocations, recoveryBudget.counters.executionInvocations);
		assert.equal(budget.counters.executionDurationMs, recoveryBudget.counters.executionDurationMs);
	}
	assert.equal(next.state, 'EXECUTING_IMPLEMENTATION');
	assert.equal(f.store.quality.getCorrection(f.runId, correctionId).status, 'completed');
	const current = f.store.quality.listCurrentTaskRevisions(f.runId);
	assert.deepEqual(current.map(({ taskId, executionRevision }) => [taskId, executionRevision]).sort(), [
		['consumer-task', 1], ['enable-task', 0], ['vertical-task', 1],
	]);
	const owner = current.find(revision => revision.taskId === 'vertical-task');
	const consumer = current.find(revision => revision.taskId === 'consumer-task');
	assert.equal(consumer.parentTreeSha, owner.targetTreeSha);
	const accepted = f.store.quality.listClosures(f.runId).find(closure =>
		closure.binding.checkpointKind === 'final' && closure.status === 'accepted');
	assert.ok(accepted);
	const reconstructed = await reconcileTasks({ runId: f.runId, taskPlan: f.store.getTaskPlan(f.runId),
		rootDir: f.rootDir, gitCli: execFileSync, taskPlanFrozen: true });
	assert.equal(reconstructed.reconciledTreeSha, accepted.binding.treeSha);
	assert.equal(fs.readFileSync(path.join(reconstructed.integrationWorktreePath, 'src/a.ts'), 'utf8'), 'export const value = 2;\n');
	assert.deepEqual(fs.readFileSync(path.join(reconstructed.integrationWorktreePath, 'src/b.ts')), consumerSource);
	assert.deepEqual(fs.readFileSync(path.join(reconstructed.integrationWorktreePath, 'src/b.bin')), consumerBinary);
	assert.equal(fs.readFileSync(path.join(reconstructed.integrationWorktreePath, 'src/a.spec.mjs'), 'utf8'), strongTest);
	const modelCalls = f.runtime.governor.calls.length, commandCalls = f.commandCount();
	await runApprovedQualityCorrection({ runtime: f.runtime, snapshot: durableRoute ? next : snapshot, answer, correctionId });
	assert.equal(f.runtime.governor.calls.length, modelCalls);
	assert.equal(f.commandCount(), commandCalls);
});
