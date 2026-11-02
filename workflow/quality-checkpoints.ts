import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { executeEvidence } from '../host/evidence-port.ts';
import { createEvidenceSourceObserver } from '../host/evidence-source.ts';
import { createEvidenceRecordStore } from '../host/evidence-store.ts';
import type { EvidenceInvocationContext } from '../host/evidence-types.ts';
import { liveRunRoot } from '../persistence/run-paths.ts';
import type { TaskQualityHooks, ExecutableTask } from '../execution/task-executor.ts';
import { eligibleParentTasks, type ClosurePlan } from '../execution/eligible-closure.ts';
import { sha256 } from '../policy/contracts/primitives.ts';
import type { CandidateBinding, Obligation, AdapterRegistration, TaskRevision, QualityPolicy } from '../policy/contracts/quality-schema.ts';
import type { TaskPlan, RuntimeState } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { getAndValidateAuthorization, type WorkflowRuntimeLike } from './node-helpers.ts';

type QualityPlan = TaskPlan & {
	qualityPolicy: QualityPolicy; qualityPolicyHash: string;
	adapterBindings: AdapterRegistration[]; evidenceObligations: Obligation[];
};

function requireQualityPlan(plan: TaskPlan): QualityPlan {
	if (plan.schemaVersion !== '2.0.0' || !('qualityPolicy' in plan)) {
		throw new SdlcError('TASK_PLAN_INVALID', 'Checkpoint operation requires a v2 quality plan');
	}
	return plan as QualityPlan;
}

export async function executeCheckpointObligations({
	runtime, snapshot, plan: rawPlan, binding, worktreeDir, registryId, obligations, observeSource,
}: {
	runtime: WorkflowRuntimeLike; snapshot: Readonly<RuntimeState>; plan: TaskPlan;
	binding: CandidateBinding; worktreeDir: string; registryId: string; obligations: Obligation[];
	observeSource: EvidenceInvocationContext['observeSource'];
}): Promise<string[]> {
	const plan = requireQualityPlan(rawPlan);
	const auth = getAndValidateAuthorization(runtime, snapshot);
	const receiptHashes: string[] = [];
	const groups = new Map<string, Obligation[]>();
	for (const obligation of obligations) {
		const key = `${obligation.adapterBindingHash}:${obligation.profileId}`;
		groups.set(key, [...(groups.get(key) ?? []), obligation]);
	}
	for (const group of groups.values()) {
		const first = group[0];
		if (!first) throw new SdlcError('INVALID_CONTRACT', 'Empty obligation group');
		const adapter = plan.adapterBindings.find(entry => sha256(entry) === first.adapterBindingHash);
		if (!adapter) throw new SdlcError('INVALID_CONTRACT', 'Missing bound evidence adapter');
		const operationId = `evidence-${sha256({ binding, group }).slice(0, 48)}`;
		const artifactDirectory = path.join(liveRunRoot(runtime.rootDir), snapshot.runId, 'evidence-operations', operationId);
		fs.mkdirSync(artifactDirectory, { recursive: true });
		const request = {
			schemaVersion: '1.0.0' as const, operationId, binding,
			adapterBindingHash: first.adapterBindingHash, profileId: first.profileId,
			obligations: group, artifactDirectory,
		};
		const observation = await observeSource();
		const ledger = runtime.runtimeStore.quality.getBudget(snapshot.runId);
		if (!ledger) throw new SdlcError('INVALID_CONTRACT', 'Evidence invocation has no persisted budget');
		const remainingDurationMs = plan.qualityPolicy.execution.maxTotalDurationMs - ledger.counters.executionDurationMs;
		if (remainingDurationMs <= 0) throw new SdlcError('BUDGET_EXHAUSTED', 'Evidence execution duration exhausted');
		const targetPackage = auth.allowedPackages[0];
		if (!targetPackage) throw new SdlcError('AUTHORIZATION_INVALID', 'Evidence requires an authorized package');
		const result = await executeEvidence(request, adapter, {
			worktreeDir, artifactDirectory, worktreeRegistryId: registryId,
			targetPackage, authorization: auth,
			allowedArgv: [adapter.argv], frozenAdapterBindingHash: first.adapterBindingHash,
			expectedSourceHash: observation.sourceHash, observeSource,
			environment: { PATH: process.env.PATH ?? '', CI: 'true' },
			executionDurationCeilingMs: remainingDurationMs,
		}, runtime.evidenceSpawn ?? spawn, createEvidenceRecordStore(runtime.runtimeStore, request), { now: runtime.now });
		const hash = sha256(result.receipt);
		receiptHashes.push(hash);
		if (result.receipt.status !== 'passed') throw new SdlcError('TASK_EXECUTION_FAILED',
			'Checkpoint obligations did not pass', { operationId, receiptHash: hash });
	}
	return receiptHashes;
}

export function qualityRevisionSetHash(tasks: readonly ExecutableTask[]): string {
	return sha256(tasks.map(task => ({
		taskId: task.taskId, parentTreeSha: task.parentTreeSha,
		targetTreeSha: task.targetTreeSha, patchHash: task.patchHash,
	})));
}

export function qualityParentRevisionHash(plan: ClosurePlan, taskId: string, revisions: readonly TaskRevision[]): string {
	return sha256(eligibleParentTasks(plan, taskId).map(task => {
		const revision = revisions.find(entry => entry.taskId === task.taskId);
		if (!revision || revision.status !== 'completed') throw new SdlcError('INVALID_CONTRACT', 'Missing eligible parent revision');
		return { taskId: task.taskId, executionRevision: revision.executionRevision, patchHash: revision.patchHash };
	}));
}

export function qualityTaskBinding(
	snapshot: Readonly<RuntimeState>, plan: TaskPlan, task: ExecutableTask, preparationHash: string,
): CandidateBinding {
	const quality = requireQualityPlan(plan);
	if (!task.targetTreeSha || !snapshot.approvedSpecHash || !snapshot.taskPlanHash) {
		throw new SdlcError('INVALID_CONTRACT', 'Missing task candidate binding');
	}
	return {
		runId: snapshot.runId, approvedSpecHash: snapshot.approvedSpecHash, taskPlanHash: snapshot.taskPlanHash,
		qualityPolicyHash: quality.qualityPolicyHash, checkpointId: `task-${task.taskId}-${task.targetTreeSha}`,
		checkpointKind: 'task', ownerId: task.taskId, candidateRevision: 0,
		baseCommitSha: plan.baseCommitSha, treeSha: task.targetTreeSha,
		revisionSetHash: qualityRevisionSetHash([task]), preparationHash,
	};
}

export function createTaskSourceObserver(
	runtime: WorkflowRuntimeLike, task: ExecutableTask, worktreeDir: string, preparationHash: string,
): EvidenceInvocationContext['observeSource'] {
	if (!task.targetTreeSha) throw new SdlcError('INVALID_CONTRACT', 'Source observer requires candidate tree');
	return createEvidenceSourceObserver({
		worktreeDir, sourceTreeSha: task.targetTreeSha, generatedOutputs: task.generatedOutputs ?? [],
		preparation: { configuration: { selectionHash: preparationHash }, files: [] }, gitCli: runtime.gitCli,
	});
}

export function sourcePreparationHash(task: ExecutableTask, selectionHash: string): string {
	return sha256({ sourceTreeSha: task.targetTreeSha, generatedOutputs: task.generatedOutputs ?? [],
		configuration: { selectionHash }, files: [] });
}

export type { TaskQualityHooks, ClosurePlan, QualityPlan };
