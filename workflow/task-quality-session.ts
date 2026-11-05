import path from 'node:path';
import type { ExecutableTask, ExecutableTaskPlan, TaskQualityHooks } from '../execution/task-executor.ts';
import { sliceClosureTasks, type ClosurePlan } from '../execution/eligible-closure.ts';
import { getCheckpointQualityPolicy } from '../policy/contracts/quality-policy.ts';
import type { ClosureRecord, CandidateBinding, TaskRevision } from '../policy/contracts/quality-schema.ts';
import { canonicalJson, sha256, type RuntimeState, type TaskPlan } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { liveRunRoot } from '../persistence/run-paths.ts';
import { runCommandTool } from '../execution/tool-commands.ts';
import { hydrateWorktree } from './hydration.ts';
import { checkpointHydrationBinding, checkpointPreparationSelection } from './checkpoint-hydration.ts';
import { materializeSliceCheckpoint } from './checkpoint-materialization.ts';
import { createTaskSourceObserver, executeCheckpointObligations, qualityParentRevisionHash, qualityTaskBinding, sourcePreparationHash } from './quality-checkpoints.ts';
import { getAndValidateAuthorization, type WorkflowRuntimeLike } from './node-helpers.ts';
import { timedSpan } from '../persistence/run-spans.ts';

export function createTaskQualitySession(
	runtime: WorkflowRuntimeLike, snapshot: Readonly<RuntimeState>, plan: TaskPlan,
	staging?: { correctionId: string; revisions: Map<string, TaskRevision>; affectedTaskIds: readonly string[] },
) {
	const policy = getCheckpointQualityPolicy(plan);
	if (!policy) return null;
	const maxExecutionDurationMs = policy.execution.maxTotalDurationMs;
	if (plan.schemaVersion !== '2.0.0' || !plan.slices?.length) throw new SdlcError('TASK_PLAN_INVALID', 'Quality slices missing');
	if (!snapshot.approvedSpecHash || !snapshot.taskPlanHash) throw new SdlcError('INVALID_CONTRACT', 'Quality snapshot identity missing');
	const identity = { approvedSpecHash: snapshot.approvedSpecHash, taskPlanHash: snapshot.taskPlanHash };
	const { evidenceObligations, qualityPolicyHash } = plan;
	const quality = runtime.runtimeStore.quality;
	if (!quality) throw new SdlcError('STORE_RECONCILIATION_FAILED', 'Quality records unavailable');
	const auth = getAndValidateAuthorization(runtime, snapshot);
	const preparationHash = checkpointPreparationSelection(runtime.execCli, {
		preparationPolicyHash: auth.preparationPolicyHash ?? null,
		preparationSelectionHash: snapshot.preparationSelectionHash ?? null,
		adapters: plan.adapterBindings,
	});
	quality.initializeBudget({
		schemaVersion: '1.0.0', runId: snapshot.runId, qualityPolicyHash: plan.qualityPolicyHash, revision: 0,
		counters: { executionInvocations: 0, executionDurationMs: 0, logicalDispatches: 0,
			physicalCalls: 0, inputTokens: 0, outputTokens: 0 }, reservations: [],
	}, policy);
	const closurePlan: ClosurePlan = { ...plan, slices: plan.slices };
	const closureStatus = (sliceId: string): string | null => {
		const currentRevisions = new Map((staging ? [...staging.revisions.values()] : quality.listCurrentTaskRevisions(snapshot.runId))
			.map(revision => [revision.taskId, revision]));
		const closures = quality.listClosures(snapshot.runId).filter(entry => entry.binding.ownerId === sliceId &&
			entry.binding.taskPlanHash === snapshot.taskPlanHash && entry.selectedRevisions.every(selected => {
				const current = currentRevisions.get(selected.taskId);
				return current?.executionRevision === selected.executionRevision && current.patchHash === selected.patchHash;
			}));
		const current = closures.find(entry => entry.status === 'accepted' || entry.status === 'verified');
		return current?.status ?? null;
	};
	async function verifyTaskEvidence(task: ExecutableTask, worktreeDir: string): Promise<string[]> {
		const executionRevision = staging ? (staging.revisions.get(task.taskId)?.executionRevision ?? -1) + 1 : 0;
		const binding = { ...qualityTaskBinding(snapshot, plan, task, sourcePreparationHash(task, preparationHash)),
			candidateRevision: executionRevision };
		const registryId = `task-${sha256(binding).slice(0, 40)}`;
		quality.registerWorktree({
			runId: snapshot.runId, registryId, kind: 'task', ownerId: task.taskId,
			relativePath: path.relative(path.join(liveRunRoot(runtime.rootDir), snapshot.runId), worktreeDir),
			bindingHash: sha256(binding), sourceHash: sha256(task.targetTreeSha),
		});
		const obligations = evidenceObligations.filter(entry => entry.owner.kind === 'task' && entry.owner.id === task.taskId);
		return executeCheckpointObligations({
			runtime, snapshot, plan, binding, worktreeDir, registryId, obligations,
			observeSource: createTaskSourceObserver(runtime, task, worktreeDir, preparationHash),
		});
	}
	async function verifyTask(task: ExecutableTask, worktreeDir: string): Promise<void> {
		if (!task.targetTreeSha || !task.parentTreeSha || !task.patchHash) throw new SdlcError('INVALID_CONTRACT', 'Task delta identity missing');
		const executionRevision = staging ? (staging.revisions.get(task.taskId)?.executionRevision ?? -1) + 1 : 0;
		const binding = { ...qualityTaskBinding(snapshot, plan, task, sourcePreparationHash(task, preparationHash)),
			candidateRevision: executionRevision };
		const receiptHashes = await verifyTaskEvidence(task, worktreeDir);
		if (!task.verificationCommand?.length) throw new SdlcError('TASK_PLAN_INVALID', 'Quality task verification command missing');
		const [command, ...args] = task.verificationCommand;
		if (!command) throw new SdlcError('TASK_PLAN_INVALID', 'Quality task verification command empty');
		const verificationOperation = `verification-${task.taskId}-r${executionRevision}-${task.targetTreeSha}`;
		const artifactValue = { binding, command: task.verificationCommand, exitCode: 0 };
		const artifactHash = sha256(`${canonicalJson(artifactValue)}\n`);
		const verificationReceipt = {
			schemaVersion: '1.0.0' as const, runId: snapshot.runId, taskId: task.taskId, executionRevision,
			treeSha: task.targetTreeSha, command: [...task.verificationCommand], artifactHash,
			exitCode: 0 as const, status: 'passed' as const,
		};
		const ledger = quality.getBudget(snapshot.runId);
		if (!ledger) throw new SdlcError('INVALID_CONTRACT', 'Task verification budget missing');
		const existing = ledger.reservations.find(entry => entry.operationId === verificationOperation);
		if (existing && !quality.getVerificationReceipt(snapshot.runId, sha256(verificationReceipt))) {
			throw new SdlcError('POLICY_VIOLATION', 'Interrupted task verification has no complete receipt; it cannot be replayed');
		}
		if (!existing) {
			quality.reserveBudget(snapshot.runId, { operationId: verificationOperation, kind: 'execution',
				checkpointId: `task:${task.taskId}`, candidateRevision: executionRevision, status: 'reserved' });
			const started = Date.now();
			const remainingDurationMs = maxExecutionDurationMs -
				ledger.counters.executionDurationMs;
			if (remainingDurationMs <= 0) throw new SdlcError('BUDGET_EXHAUSTED', 'Task verification duration exhausted');
			const result = runCommandTool({ command, args }, {
				worktreeDir, rootDir: runtime.rootDir, allowedPackages: auth.allowedPackages,
				execCli: (command, args, options) => runtime.execCli(command, args, {
					...options, timeout: Math.min(Number(options?.timeout ?? remainingDurationMs), remainingDurationMs),
				}),
			});
			quality.chargeBudget(snapshot.runId, verificationOperation, { executionDurationMs: Date.now() - started });
			if (result.exitCode !== 0) throw new SdlcError('TASK_EXECUTION_FAILED', 'Task checkpoint verification failed');
		}
		if ((await createTaskSourceObserver(runtime, task, worktreeDir, preparationHash)()).treeSha !== task.targetTreeSha) {
			throw new SdlcError('INVALID_CONTRACT', 'Task source changed during verification');
		}
		runtime.artifactStore.writeJson('task-quality-verification', artifactValue);
		receiptHashes.push(quality.saveVerificationReceipt(verificationReceipt));
		const revision = quality.saveTaskRevision({
			schemaVersion: '1.0.0', runId: snapshot.runId, taskPlanHash: identity.taskPlanHash,
			taskId: task.taskId, executionRevision, correctionId: staging?.correctionId ?? null,
			parentTreeSha: task.parentTreeSha, targetTreeSha: task.targetTreeSha,
			patchHash: task.patchHash, parentRevisionSetHash: qualityParentRevisionHash(closurePlan, task.taskId,
				staging ? [...staging.revisions.values()] : quality.listCurrentTaskRevisions(snapshot.runId)),
			status: 'completed', receiptHashes,
		});
		if (staging) staging.revisions.set(task.taskId, revision);
		else quality.selectTaskRevision(snapshot.runId, task.taskId, executionRevision);
	}
	async function prepareSlice(sliceId: string, livePlan: ExecutableTaskPlan): Promise<ClosureRecord> {
		const taskMap = new Map(livePlan.tasks.map(task => [task.taskId, task]));
		const revisions = (staging ? [...staging.revisions.values()] : quality.listCurrentTaskRevisions(snapshot.runId))
			.sort((a, b) => plan.integrationOrder.indexOf(a.taskId) - plan.integrationOrder.indexOf(b.taskId));
		const selectedRevisions = revisions.filter(revision => taskMap.has(revision.taskId))
			.map(({ taskId, executionRevision, patchHash }) => {
				if (!patchHash) throw new SdlcError('INVALID_CONTRACT', 'Selected task patch hash missing');
				return { taskId, executionRevision, patchHash };
			});
		const bindings: CandidateBinding[] = [];
		const closureTaskIds = new Set(sliceClosureTasks({ ...closurePlan, tasks: livePlan.tasks }, sliceId).map(task => task.taskId));
		const closureRevisions = selectedRevisions.filter(revision => closureTaskIds.has(revision.taskId));
		const generatedOutputs = [...new Set(livePlan.tasks.filter(task => closureTaskIds.has(task.taskId))
			.flatMap(task => task.generatedOutputs ?? []))];
		const sliceTask = livePlan.tasks.find(task => task.sliceId === sliceId);
		if (!sliceTask) throw new SdlcError('TASK_PLAN_INVALID', 'Slice has no constituent task');
		const materialized = materializeSliceCheckpoint({
			runId: snapshot.runId, sliceId, taskPlan: { ...closurePlan, tasks: livePlan.tasks },
			baseCommitSha: plan.baseCommitSha, rootDir: runtime.rootDir, gitCli: runtime.gitCli,
			frozen: snapshot.taskPlanFrozen === true,
			revisionIdentity: sha256(closureRevisions),
			register: checkpoint => {
				const binding: CandidateBinding = {
					runId: snapshot.runId, ...identity,
					qualityPolicyHash, checkpointId: checkpoint.checkpointId,
					checkpointKind: checkpoint.kind, ownerId: sliceId,
					candidateRevision: Math.max(0, ...revisions.map(revision => revision.executionRevision)),
					baseCommitSha: plan.baseCommitSha, treeSha: checkpoint.treeSha,
					revisionSetHash: sha256(closureRevisions),
					preparationHash: sourcePreparationHash({ ...sliceTask,
						targetTreeSha: checkpoint.treeSha, generatedOutputs }, preparationHash),
				};
				bindings.push(binding);
				quality.registerWorktree({ runId: snapshot.runId, registryId: checkpoint.checkpointId,
					kind: checkpoint.kind, ownerId: sliceId, relativePath: checkpoint.relativePath,
					bindingHash: sha256(binding), sourceHash: sha256(checkpoint.treeSha) });
			},
		});
		const [binding] = bindings;
		if (!binding) throw new SdlcError('INVALID_CONTRACT', 'Checkpoint registration did not bind its candidate');
		if (staging) {
			const existing = quality.getStagedClosure(snapshot.runId, staging.correctionId,
				binding.checkpointId, binding.candidateRevision);
			if (existing) return existing;
		}
		await timedSpan(runtime.runtimeStore, 'prepare', `hydrate checkpoint ${sliceId}`, () => hydrateWorktree({
			worktreeDir: materialized.worktreeDir,
			allowedPackages: auth.allowedPackages, runner: runtime.execCli,
			checkpoint: checkpointHydrationBinding(plan, snapshot, auth) }));
		const obligations = evidenceObligations.filter(entry => entry.owner.kind === 'slice' && entry.owner.id === sliceId ||
			entry.owner.kind === 'task' && taskMap.get(entry.owner.id)?.sliceId === sliceId);
		const candidateTask: ExecutableTask = {
			...sliceTask,
			parentTreeSha: materialized.treeSha, targetTreeSha: materialized.treeSha,
			generatedOutputs,
			pathPrefixes: [...auth.allowedPathPrefixes], authoredPaths: [...auth.allowedPathPrefixes],
		};
		const receiptHashes = await executeCheckpointObligations({
			runtime, snapshot, plan, binding, worktreeDir: materialized.worktreeDir,
			registryId: materialized.checkpointId, obligations,
			observeSource: createTaskSourceObserver(runtime, candidateTask, materialized.worktreeDir, preparationHash),
		});
		const closure: ClosureRecord = {
			schemaVersion: '1.0.0', binding,
			selectedRevisions: selectedRevisions.filter(revision => materialized.constituentTaskIds.includes(revision.taskId)),
			registryId: materialized.checkpointId, status: materialized.kind === 'enabling' ? 'verified' : 'reviewing',
			receiptHashes: receiptHashes.length ? receiptHashes : revisions.filter(revision =>
				materialized.constituentTaskIds.includes(revision.taskId)).flatMap(revision => revision.receiptHashes)
				.filter(hash => quality.getVerificationReceipt(snapshot.runId, hash) !== null),
			reviewOperationIds: [],
		};
		if (staging) quality.saveStagedClosure(staging.correctionId, closure);
		else quality.saveClosure(closure);
		return closure;
	}
	const hooks: TaskQualityHooks = {
		plan: closurePlan, closureStatus, verifyTask, verifyTaskEvidence,
		verifyEnabling: async (sliceId, livePlan) => { await prepareSlice(sliceId, livePlan); },
	};
	return { hooks, prepareSlice, policy };
}
