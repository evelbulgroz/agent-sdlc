import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { captureTaskDelta } from '../execution/task-tree-delta.ts';
import { liveRunRoot } from '../persistence/run-paths.ts';
import { sha256 } from '../policy/contracts.ts';
import { taskQualityFixture } from '../testing/task-quality-fixture.ts';
import { SdlcWorkflowRuntime } from './graph.ts';
import { materializeCorrectedFinal } from './corrected-final-materialization.ts';
import { blockFailedCorrection } from './quality-correction-failure.ts';

test('mixed corrected-final checkout fails closed and exposes the observed candidate for acknowledgement', async t => {
	const f = taskQualityFixture(t);
	await f.session.hooks.verifyTask(f.candidate, f.worktreeDir);
	const integration = path.join(liveRunRoot(f.rootDir), f.runId, 'worktrees/integration');
	f.runtime.gitCli('git', ['worktree', 'add', '--quiet', '--detach', integration, f.base], { cwd: f.rootDir });
	fs.writeFileSync(path.join(f.rootDir, 'src/a.ts'), 'export const value = 2;\n');
	fs.writeFileSync(path.join(f.rootDir, 'src/second.ts'), 'export const second = true;\n');
	const target = captureTaskDelta({ task: { taskId: 'target', parentTreeSha: f.tree, pathPrefixes: ['src'] },
		worktreeDir: f.rootDir, rootDir: f.rootDir, gitCli: f.runtime.gitCli, rawPatchHash: true });
	const binding = { runId: f.runId, approvedSpecHash: f.snapshot.approvedSpecHash,
		taskPlanHash: f.snapshot.taskPlanHash, qualityPolicyHash: f.plan.qualityPolicyHash,
		checkpointId: 'partial-final', checkpointKind: 'final', ownerId: null, candidateRevision: 1,
		baseCommitSha: f.base, treeSha: target.targetTreeSha, revisionSetHash: sha256([]), preparationHash: sha256({}) };
	const quality = f.store.quality;
	const interruptId = 'approve-partial-correction';
	f.store.createInterrupt({ interruptId, runId: f.runId, kind: 'quality_review',
		stateHash: sha256(binding), requestArtifact: f.artifacts.writeJson('fixture-interrupt', {}),
		createdAt: f.runtime.now().toISOString() });
	quality.bindInterrupt({ runId: f.runId, interruptId, bindingHash: sha256(binding),
		findingIds: ['partial-finding'], affectedTaskIds: ['enable-task'],
		expectedRevisions: [{ taskId: 'enable-task', executionRevision: 0 }] });
	quality.consumeAnswer({
		runId: f.runId, correctionId: 'partial-correction', expectedBindingHash: sha256(binding),
		affectedTaskIds: ['enable-task'], answer: {
			schemaVersion: '1.0.0', answerId: 'partial-approval', interruptId,
			bindingHash: sha256(binding), findingIds: ['partial-finding'], action: 'approve-correction',
			rationale: 'Correct the staged final candidate', evidenceHashes: [],
			correction: { owners: [{ taskId: 'enable-task', expectedRevision: 0, editPaths: ['src/a.ts'] }],
				rerunObligationIds: [], maxSourceEditIterations: 1, expectedBudgetLedgerHash: quality.budgetHash(f.runId) },
		},
	});
	quality.beginFinalMaterialization({ runId: f.runId, correctionId: 'partial-correction',
		binding, relativePath: 'worktrees/integration', priorTreeSha: f.tree, baseTreeSha: f.tree });
	quality.advanceFinalMaterialization(f.runId, 'partial-correction', 'resetting');
	quality.advanceFinalMaterialization(f.runId, 'partial-correction', 'checking-out');
	// Reproduce a process death after the index and one file were updated, before the second file.
	f.runtime.gitCli('git', ['read-tree', binding.treeSha], { cwd: integration });
	fs.writeFileSync(path.join(integration, 'src/a.ts'), 'export const value = 2;\n');
	const observeSource = async () => {
		const observed = captureTaskDelta({
			task: { taskId: 'observed', parentTreeSha: f.tree, pathPrefixes: ['src'] },
			worktreeDir: integration, rootDir: f.rootDir, gitCli: f.runtime.gitCli, rawPatchHash: true,
		});
		return { treeSha: observed.targetTreeSha, sourceHash: observed.patchHash, preparationHash: binding.preparationHash };
	};
	const observed = await observeSource();
	assert.notEqual(observed.treeSha, f.tree);
	assert.notEqual(observed.treeSha, binding.treeSha);
	const snapshot = { ...f.snapshot, qualityPolicy: f.plan.qualityPolicy, qualityCheckpointId: binding.checkpointId,
		qualityCheckpointKind: 'final', qualityCheckpointTreeSha: binding.treeSha,
		qualityCheckpointBindingHash: sha256(binding) };
	const budget = quality.getBudget(f.runId);
	await assert.rejects(materializeCorrectedFinal({
		runtime: f.runtime, snapshot, correctionId: 'partial-correction', binding,
		worktreeDir: integration, observeSource,
	}), /unrecognized source edits/);
	f.runtime.transition = (current, options) => SdlcWorkflowRuntime.prototype.transition.call(f.runtime, current, options);
	const blocked = blockFailedCorrection({
		runtime: f.runtime, snapshot, correctionId: 'partial-correction',
		message: 'Final snapshot has unrecognized source edits', code: 'POLICY_VIOLATION',
	});
	const pending = f.store.getPendingInterrupt(f.runId);
	const request = f.artifacts.readJson(pending.requestArtifact);
	assert.equal(blocked.qualityCheckpointTreeSha, observed.treeSha);
	assert.equal(request.failedCandidate.integrationObservation.treeSha, observed.treeSha);
	assert.deepEqual(request.allowedActions, ['confirm']);
	assert.equal(quality.getFinalMaterialization(f.runId, 'partial-correction').phase, 'checking-out');
	assert.deepEqual(quality.getBudget(f.runId), budget);
	assert.equal(f.runtime.governor.calls.length, 0);
});
