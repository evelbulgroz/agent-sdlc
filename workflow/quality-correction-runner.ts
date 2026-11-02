import path from 'node:path';
import { MinimalExecutor } from '../execution/minimal-executor.ts';
import { captureTaskDelta } from '../execution/task-tree-delta.ts';
import { eligibleParentTasks, materializeClosureTree } from '../execution/eligible-closure.ts';
import type { ExecutableTask } from '../execution/task-executor.ts';
import type { QualityAnswer, TaskRevision, ClosureRecord } from '../policy/contracts/quality-schema.ts';
import { sha256, type RuntimeState } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { liveRunRoot } from '../persistence/run-paths.ts';
import { runCheckpointQaCritic } from '../review/qa-checkpoint.ts';
import { createSyntheticCommit } from './worktrees.ts';
import { assertPlanFrozenThenCreateWorktree } from './worktree-guard.ts';
import { createTaskQualitySession } from './task-quality-session.ts';
import { getAndValidateAuthorization, type WorkflowRuntimeLike } from './node-helpers.ts';
import { hydrateWorktree } from './hydration.ts';
import { rebuildCorrectedFinal } from './corrected-final-checkpoint.ts';
import { qualityParentRevisionHash } from './quality-checkpoints.ts';
import { blockFailedCorrection, correctionNeedsAdjudication, pendingCorrectionAdjudication } from './quality-correction-failure.ts';

export async function runApprovedQualityCorrection({
	runtime, snapshot, answer, correctionId,
}: {
	runtime: WorkflowRuntimeLike; snapshot: Readonly<RuntimeState>;
	answer: QualityAnswer; correctionId: string;
}): Promise<Readonly<RuntimeState>> {
	const quality = runtime.runtimeStore.quality;
	const plan = runtime.runtimeStore.getTaskPlan(snapshot.runId);
	if (!quality || !plan || plan.schemaVersion !== '2.0.0' || !plan.slices || !answer.correction) {
		throw new SdlcError('POLICY_VIOLATION', 'Correction requires an approved v2 task plan');
	}
	const taskPlanHash = snapshot.taskPlanHash;
	if (!taskPlanHash) throw new SdlcError('INVALID_CONTRACT', 'Correction task plan binding missing');
	const correction = quality.getCorrection(snapshot.runId, correctionId);
	if (!correction) throw new SdlcError('INVALID_CONTRACT', 'Correction approval was not consumed');
	const adjudication = pendingCorrectionAdjudication(runtime, snapshot.runId, correctionId);
	if (adjudication) return adjudication;
	const auth = getAndValidateAuthorization(runtime, snapshot);
	if (!auth.allowedOperations.createDetachedWorktree || !auth.allowedOperations.editIsolatedWorktree ||
		!auth.allowedOperations.runAllowlistedCommands) {
		throw new SdlcError('OPERATION_NOT_PERMITTED', 'Correction requires authorized worktrees, edits, and verification');
	}
	const previous = new Map<string, TaskRevision>();
	for (const selected of quality.listRevisionSelections(snapshot.runId)) {
		const revision = quality.getTaskRevision(snapshot.runId, selected.taskId, selected.executionRevision);
		if (!revision) throw new SdlcError('INVALID_CONTRACT', 'Correction selected revision missing');
		previous.set(revision.taskId, revision);
	}
	const revisions = new Map(previous);
	const tasks: ExecutableTask[] = plan.tasks.map(task => {
		const revision = previous.get(task.taskId);
		return revision ? { ...task, parentTreeSha: revision.parentTreeSha,
			targetTreeSha: revision.targetTreeSha, patchHash: revision.patchHash, status: 'completed' } : { ...task };
	});
	const session = createTaskQualitySession(runtime, snapshot, plan, {
		correctionId, revisions, affectedTaskIds: correction.binding.affectedTaskIds,
	});
	if (!session) throw new SdlcError('INVALID_CONTRACT', 'Correction quality policy missing');
	try {
		if (correction.status === 'completed') return correctionCompleted(runtime, snapshot, correctionId, correction.binding.affectedTaskIds);
		if (!['invalidated', 'failed', 'interrupted'].includes(correction.status)) {
			quality.setCorrectionStatus(snapshot.runId, correctionId, 'interrupted');
		}
		quality.setCorrectionStatus(snapshot.runId, correctionId, 'materializing');
		quality.setCorrectionStatus(snapshot.runId, correctionId, 'executing');
		for (const taskId of plan.integrationOrder.filter(id => correction.binding.affectedTaskIds.includes(id))) {
			const task = tasks.find(entry => entry.taskId === taskId);
			if (!task) throw new SdlcError('TASK_PLAN_INVALID', 'Correction task missing');
			const old = previous.get(taskId);
			if (!old?.targetTreeSha || !old.patchHash) throw new SdlcError('INVALID_CONTRACT', 'Correction old delta missing');
			const parentTreeSha = materializeClosureTree({
				baseTreeSha: String(runtime.gitCli('git', ['rev-parse', `${plan.baseCommitSha}^{tree}`],
					{ cwd: runtime.rootDir, encoding: 'utf8' })).trim(),
				tasks: eligibleParentTasks({ ...plan, slices: plan.slices, tasks }, taskId),
				rootDir: runtime.rootDir, gitCli: runtime.gitCli,
			});
			const executionRevision = old.executionRevision + 1;
			const staged = quality.getTaskRevision(snapshot.runId, taskId, executionRevision);
			if (staged) {
				if (staged.correctionId !== correctionId || staged.parentTreeSha !== parentTreeSha ||
					staged.parentRevisionSetHash !== qualityParentRevisionHash(
						{ ...plan, slices: plan.slices }, taskId, [...revisions.values()])) {
					throw new SdlcError('INVALID_CONTRACT', 'Correction staged revision provenance changed');
				}
				if (staged.status === 'completed') {
					Object.assign(task, { parentTreeSha, targetTreeSha: staged.targetTreeSha, patchHash: staged.patchHash });
					revisions.set(taskId, staged);
					continue;
				}
				if (staged.status === 'executing') {
					throw new SdlcError('POLICY_VIOLATION', 'Interrupted source edit requires operator adjudication; approval is not replayed');
				}
			}
			const progress: TaskRevision = { schemaVersion: '1.0.0', runId: snapshot.runId,
				taskPlanHash, taskId, executionRevision, correctionId,
				parentTreeSha, targetTreeSha: null, patchHash: null,
				parentRevisionSetHash: qualityParentRevisionHash({ ...plan, slices: plan.slices }, taskId, [...revisions.values()]),
				status: 'materializing', receiptHashes: [] };
			if (!staged) quality.saveTaskRevision(progress);
			const worktreeDir = path.join(liveRunRoot(runtime.rootDir), snapshot.runId, 'worktrees', `${taskId}-r${executionRevision}`);
			const commitSha = createSyntheticCommit({ parentTreeSha, baseCommitSha: plan.baseCommitSha,
				message: `sdlc approved correction ${correctionId} ${taskId}`, rootDir: runtime.rootDir, gitCli: runtime.gitCli });
			assertPlanFrozenThenCreateWorktree({ runId: snapshot.runId, baseCommitSha: plan.baseCommitSha,
				commitSha, worktreeDir, rootDir: runtime.rootDir, gitCli: runtime.gitCli, taskPlanFrozen: true });
			const patch = runtime.gitCli('git', ['diff-tree', '-r', '-p', '--binary', old.parentTreeSha, old.targetTreeSha],
				{ cwd: runtime.rootDir });
			const existing = captureTaskDelta({ task: { ...task, parentTreeSha }, worktreeDir,
				rootDir: runtime.rootDir, gitCli: runtime.gitCli, rawPatchHash: true });
			const expectedTreeSha = materializeClosureTree({ baseTreeSha: parentTreeSha,
				tasks: [{ ...task, parentTreeSha: old.parentTreeSha, targetTreeSha: old.targetTreeSha, patchHash: old.patchHash }],
				rootDir: runtime.rootDir, gitCli: runtime.gitCli });
			const recoveredTreeSha = staged?.status === 'verifying' ? staged.targetTreeSha : expectedTreeSha;
			if (staged?.status === 'verifying' ? existing.targetTreeSha !== recoveredTreeSha :
				existing.targetTreeSha !== parentTreeSha && existing.targetTreeSha !== recoveredTreeSha) {
				throw new SdlcError('POLICY_VIOLATION', 'Interrupted correction worktree has unrecognized edits');
			}
			if (staged?.status !== 'verifying' && existing.targetTreeSha === parentTreeSha && patch.length) {
				runtime.gitCli('git', ['apply', '--check', '--binary', '-'], { cwd: worktreeDir, input: patch, stdio: ['pipe', 'pipe', 'pipe'] });
				runtime.gitCli('git', ['apply', '--binary', '-'], { cwd: worktreeDir, input: patch, stdio: ['pipe', 'pipe', 'pipe'] });
			}
			task.parentTreeSha = parentTreeSha;
			await hydrateWorktree({ worktreeDir, allowedPackages: auth.allowedPackages, targetPackage: task.targetPackage, runner: runtime.execCli });
			const owner = answer.correction.owners.find(entry => entry.taskId === taskId);
			if (owner && staged?.status !== 'verifying') {
				quality.saveTaskRevision({ ...progress, status: 'executing' });
				const executor = new MinimalExecutor({ governor: runtime.governor, runtimeStore: runtime.runtimeStore,
					artifactStore: runtime.artifactStore, roleRegistry: runtime.registry, execCli: runtime.execCli });
				const result = await executor.execute({
					runId: snapshot.runId, taskId, worktreeDir,
					specSummary: `Explicitly approved correction: ${answer.rationale}`,
					acceptanceCriteria: [answer.rationale], agentsMd: '',
					authoredPaths: owner.editPaths, allowedWritePathPrefixes: owner.editPaths,
					allowedPackages: auth.allowedPackages, verificationCommands: [task.verificationCommand ?? []],
					maxSourceEditIterations: answer.correction.maxSourceEditIterations,
				});
				if (result.status !== 'completed') throw new SdlcError('TASK_EXECUTION_FAILED', 'Approved correction edit failed');
			}
			const delta = captureTaskDelta({ task, worktreeDir, rootDir: runtime.rootDir,
				gitCli: runtime.gitCli, rawPatchHash: true });
			if (owner) {
				captureTaskDelta({ task: { ...task, parentTreeSha: expectedTreeSha,
					authoredPaths: owner.editPaths, pathPrefixes: owner.editPaths }, worktreeDir,
					rootDir: runtime.rootDir, gitCli: runtime.gitCli, rawPatchHash: true });
			} else if (delta.targetTreeSha !== expectedTreeSha) {
				throw new SdlcError('PATH_CONTAINMENT_VIOLATION', 'Consumer rematerialization cannot introduce source edits');
			}
			task.targetTreeSha = delta.targetTreeSha;
			task.patchHash = delta.patchHash;
			quality.saveTaskRevision({ ...progress, status: 'verifying',
				targetTreeSha: delta.targetTreeSha, patchHash: delta.patchHash });
			await runtime.onBoundary('quality-correction-revision-captured', {
				runId: snapshot.runId, correctionId, taskId, executionRevision,
			});
			await session.hooks.verifyTask(task, worktreeDir);
		}
		quality.setCorrectionStatus(snapshot.runId, correctionId, 'verifying');
		quality.setCorrectionStatus(snapshot.runId, correctionId, 'rebuilding');
		const rebuilt: ClosureRecord[] = [];
		const affectedClosures = quality.listClosures(snapshot.runId).filter(closure =>
			closure.status === 'invalidated' && closure.binding.checkpointKind !== 'final');
		for (const slice of plan.slices) {
			if (!affectedClosures.some(closure => closure.binding.ownerId === slice.sliceId)) continue;
			const closure = await session.prepareSlice(slice.sliceId, { ...plan, tasks });
			if (slice.kind !== 'enabling') {
				const registration = quality.getWorktree(snapshot.runId, closure.registryId);
				if (!registration) throw new SdlcError('INVALID_CONTRACT', 'Corrected checkpoint registry missing');
				const reviewSnapshot = { ...snapshot, qualityPolicy: session.policy,
						qualityCheckpointId: closure.binding.checkpointId, qualityCheckpointKind: 'slice' as const,
						qualityCheckpointSliceId: slice.sliceId, qualityCheckpointTreeSha: closure.binding.treeSha,
						qualityCheckpointBindingHash: sha256(closure.binding) };
				const result = await runCheckpointQaCritic({
					runtime, snapshot: reviewSnapshot,
					context: { plan, policy: session.policy, closure,
						worktreeDir: path.join(liveRunRoot(runtime.rootDir), snapshot.runId, registration.relativePath) },
				});
				if (result.hasP1 || !['PASS', 'SKIP'].includes(result.status)) {
					throw new SdlcError('POLICY_VIOLATION', 'Corrected slice still lacks accepted adequacy');
				}
				quality.saveStagedClosure(correctionId, { ...closure, status: 'accepted' });
			}
			rebuilt.push(closure);
		}
		if (quality.listClosures(snapshot.runId).some(closure => closure.status === 'invalidated' &&
			closure.binding.checkpointKind === 'final')) {
			rebuilt.push(await rebuildCorrectedFinal({ runtime, snapshot, plan, tasks, revisions, correctionId }));
		}
		quality.completeCorrection({
			runId: snapshot.runId, correctionId, expectedBudgetLedgerHash: quality.budgetHash(snapshot.runId),
			stagedRevisions: correction.binding.affectedTaskIds.map(taskId => {
				const revision = revisions.get(taskId);
				if (!revision) throw new SdlcError('INVALID_CONTRACT', 'Completed correction revision missing');
				return { taskId, executionRevision: revision.executionRevision };
			}),
			closures: rebuilt.map(closure => ({
				checkpointId: closure.binding.checkpointId, candidateRevision: closure.binding.candidateRevision,
			})),
		});
		return correctionCompleted(runtime, snapshot, correctionId, correction.binding.affectedTaskIds);
	} catch (error) {
		const blocked = runtime.runtimeStore.transaction(() => {
			if (quality.getCorrection(snapshot.runId, correctionId)?.status !== 'completed') {
				quality.setCorrectionStatus(snapshot.runId, correctionId, 'failed');
			}
			const current = runtime.runtimeStore.getRun(snapshot.runId);
			const interruptedEdit = quality.listTaskRevisions(snapshot.runId).some(revision =>
				revision.correctionId === correctionId && revision.status === 'executing');
			const message = error instanceof Error ? error.message : String(error);
			const requiresAdjudication = correctionNeedsAdjudication(error, interruptedEdit);
			if (requiresAdjudication) return blockFailedCorrection({
				runtime, snapshot, correctionId, message,
				code: error instanceof SdlcError ? error.code : 'QUALITY_CORRECTION_FAILED',
			});
			runtime.transition({ ...snapshot,
				runtimeRevision: Math.max(snapshot.runtimeRevision, current.runtimeRevision),
			}, {
				to: 'BLOCKED', eventType: 'RUN_BLOCKED',
				causalId: `quality-correction-failed-${correctionId}-${current.runtimeRevision}`,
				updates: {
					pendingInterruptId: answer.interruptId, blockedReason: 'QUALITY_REVIEW_BLOCKED',
					lastError: { code: error instanceof SdlcError ? error.code : 'QUALITY_CORRECTION_FAILED',
						message: interruptedEdit
							? `${message}; interrupted source edit requires operator adjudication; approval is not replayed`
							: requiresAdjudication ? `${message}; operator adjudication required` : message,
						metadata: { correctionId, answerId: answer.answerId, sourceEditsReplayed: false,
							qualityRecoveryAllowed: !requiresAdjudication,
							recovery: requiresAdjudication ? 'operator-adjudication-required' : 'resume-persisted-correction' } },
				},
				payload: { correctionId, interruptId: answer.interruptId, reason: 'QUALITY_REVIEW_BLOCKED' },
			});
			return null;
		});
		if (blocked) return blocked;
		throw error;
	}
}

function correctionCompleted(runtime: WorkflowRuntimeLike, snapshot: Readonly<RuntimeState>,
	correctionId: string, taskIds: readonly string[]): Readonly<RuntimeState> {
	if (snapshot.state === 'EXECUTING_IMPLEMENTATION' && !snapshot.pendingInterruptId) return snapshot;
	return runtime.transition(snapshot, {
			to: 'EXECUTING_IMPLEMENTATION', eventType: 'QUALITY_CORRECTION_COMPLETED',
			causalId: `correction-completed-${correctionId}`,
			updates: { pendingInterruptId: null, blockedReason: null, lastError: null },
			payload: { correctionId, taskIds },
		});
}
