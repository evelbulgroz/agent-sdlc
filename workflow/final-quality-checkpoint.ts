import path from 'node:path';
import { getCheckpointQualityPolicy } from '../policy/contracts/quality-policy.ts';
import type { ClosureRecord, CandidateBinding } from '../policy/contracts/quality-schema.ts';
import { sha256, type RuntimeState } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { liveRunRoot } from '../persistence/run-paths.ts';
import { materializeClosureTree } from '../execution/eligible-closure.ts';
import { createTaskSourceObserver, executeCheckpointObligations, sourcePreparationHash } from './quality-checkpoints.ts';
import { getAndValidateAuthorization, type WorkflowRuntimeLike } from './node-helpers.ts';
import { checkpointPreparationSelection } from './checkpoint-hydration.ts';

export async function prepareFinalQualityCheckpoint(
	runtime: WorkflowRuntimeLike, snapshot: Readonly<RuntimeState>, worktreeDir: string,
): Promise<Partial<RuntimeState>> {
	const plan = runtime.runtimeStore.getTaskPlan(snapshot.runId);
	if (!plan || !getCheckpointQualityPolicy(plan)) return {};
	if (plan.schemaVersion !== '2.0.0' || !snapshot.targetTreeSha || !snapshot.approvedSpecHash ||
		!snapshot.taskPlanHash || !plan.qualityPolicy || !plan.qualityPolicyHash || !plan.evidenceObligations) {
		throw new SdlcError('INVALID_CONTRACT', 'Final quality candidate lacks plan/tree binding');
	}
	const quality = runtime.runtimeStore.quality;
	if (!quality) throw new SdlcError('STORE_RECONCILIATION_FAILED', 'Quality store unavailable');
	const auth = getAndValidateAuthorization(runtime, snapshot);
	const selected = quality.listCurrentTaskRevisions(snapshot.runId)
		.sort((a, b) => plan.integrationOrder.indexOf(a.taskId) - plan.integrationOrder.indexOf(b.taskId));
	if (selected.length !== plan.tasks.length) throw new SdlcError('POLICY_VIOLATION', 'Final candidate has incomplete current task revisions');
	for (const revision of selected) {
		const task = plan.tasks.find(entry => entry.taskId === revision.taskId);
		if (!task || task.status !== 'completed' || task.patchHash !== revision.patchHash ||
			task.targetTreeSha !== revision.targetTreeSha || task.parentTreeSha !== revision.parentTreeSha) {
			throw new SdlcError('INVALID_CONTRACT', `Final selected revision '${revision.taskId}' differs from its frozen task delta`);
		}
	}
	const selectedTreeSha = materializeClosureTree({
		baseTreeSha: plan.baseCommitSha, tasks: plan.tasks, rootDir: worktreeDir, gitCli: runtime.gitCli,
	});
	if (selectedTreeSha !== snapshot.targetTreeSha) {
		throw new SdlcError('INVALID_CONTRACT', 'Final integration tree differs from the selected task delta closure', {
			expectedTreeSha: selectedTreeSha,
			actualTreeSha: snapshot.targetTreeSha,
		});
	}
	const preparationHash = checkpointPreparationSelection(runtime.execCli, {
		preparationPolicyHash: auth.preparationPolicyHash ?? null,
		preparationSelectionHash: snapshot.preparationSelectionHash ?? null, adapters: plan.adapterBindings,
	});
	const selectedRevisions = selected.map(({ taskId, executionRevision, patchHash }) => {
		if (!patchHash) throw new SdlcError('INVALID_CONTRACT', 'Final selected task patch missing');
		return { taskId, executionRevision, patchHash };
	});
	const checkpointId = `final-${sha256({ treeSha: snapshot.targetTreeSha, selectedRevisions }).slice(0, 40)}`;
	const firstTask = plan.tasks[0];
	if (!firstTask) throw new SdlcError('TASK_PLAN_INVALID', 'Final plan has no tasks');
	const task = { ...firstTask, parentTreeSha: snapshot.targetTreeSha, targetTreeSha: snapshot.targetTreeSha,
		generatedOutputs: [...new Set(plan.tasks.flatMap(entry => entry.generatedOutputs ?? []))],
		authoredPaths: [...auth.allowedPathPrefixes], pathPrefixes: [...auth.allowedPathPrefixes] };
	const binding: CandidateBinding = {
		runId: snapshot.runId, approvedSpecHash: snapshot.approvedSpecHash, taskPlanHash: snapshot.taskPlanHash,
		qualityPolicyHash: plan.qualityPolicyHash, checkpointId, checkpointKind: 'final', ownerId: null,
		candidateRevision: Math.max(0, ...selected.map(revision => revision.executionRevision)),
		baseCommitSha: plan.baseCommitSha, treeSha: snapshot.targetTreeSha,
		revisionSetHash: sha256(selectedRevisions),
		preparationHash: sourcePreparationHash(task, preparationHash),
	};
	quality.registerWorktree({
		runId: snapshot.runId, registryId: checkpointId, kind: 'final', ownerId: null,
		relativePath: path.relative(path.join(liveRunRoot(runtime.rootDir), snapshot.runId), worktreeDir),
		bindingHash: sha256(binding), sourceHash: sha256(snapshot.targetTreeSha),
	});
	const receiptHashes = await executeCheckpointObligations({
		runtime, snapshot, plan, binding, worktreeDir, registryId: checkpointId,
		obligations: plan.evidenceObligations,
		observeSource: createTaskSourceObserver(runtime, task, worktreeDir, preparationHash),
	});
	const closure: ClosureRecord = {
		schemaVersion: '1.0.0', binding, selectedRevisions,
		registryId: checkpointId, status: 'reviewing', receiptHashes, reviewOperationIds: [],
	};
	quality.saveClosure(closure);
	return {
		qualityPolicy: plan.qualityPolicy, qualityCheckpointId: checkpointId, qualityCheckpointKind: 'final',
		qualityCheckpointSliceId: undefined, qualityCheckpointTreeSha: snapshot.targetTreeSha,
		qualityCheckpointBindingHash: sha256(binding),
	};
}
