import path from 'node:path';
import { liveRunRoot } from '../persistence/run-paths.ts';
import { materializeClosureTree } from '../execution/eligible-closure.ts';
import type { ExecutableTask } from '../execution/task-executor.ts';
import { evaluateAcCoverageFromWorktree } from '../execution/ac-worktree-coverage.ts';
import type { TaskRevision, ClosureRecord } from '../policy/contracts/quality-schema.ts';
import { sha256, type RuntimeState, type TaskPlan } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { executePreflightVerifier } from '../review/verifier.ts';
import { runCheckpointQaCritic } from '../review/qa-checkpoint.ts';
import { materializeCorrectedFinal } from './corrected-final-materialization.ts';
import { hydrateWorktree } from './hydration.ts';
import { checkpointHydrationBinding, checkpointPreparationSelection } from './checkpoint-hydration.ts';
import { createTaskSourceObserver, executeCheckpointObligations, sourcePreparationHash } from './quality-checkpoints.ts';
import { getAndValidateAuthorization, type WorkflowRuntimeLike } from './node-helpers.ts';

export async function rebuildCorrectedFinal({
	runtime, snapshot, plan, tasks, revisions, correctionId,
}: {
	runtime: WorkflowRuntimeLike; snapshot: Readonly<RuntimeState>; plan: TaskPlan;
	tasks: ExecutableTask[]; revisions: ReadonlyMap<string, TaskRevision>; correctionId: string;
}): Promise<ClosureRecord> {
	if (plan.schemaVersion !== '2.0.0' || !plan.qualityPolicy || !plan.evidenceObligations ||
		!plan.qualityPolicyHash || !snapshot.approvedSpecHash || !snapshot.taskPlanHash) {
		throw new SdlcError('INVALID_CONTRACT', 'Corrected final requires v2 policy');
	}
	const quality = runtime.runtimeStore.quality;
	const auth = getAndValidateAuthorization(runtime, snapshot);
	const treeSha = materializeClosureTree({ baseTreeSha: String(runtime.gitCli('git',
		['rev-parse', `${plan.baseCommitSha}^{tree}`], { cwd: runtime.rootDir, encoding: 'utf8' })).trim(),
		tasks, rootDir: runtime.rootDir, gitCli: runtime.gitCli });
	const relativePath = 'worktrees/integration';
	const worktreeDir = path.join(liveRunRoot(runtime.rootDir), snapshot.runId, relativePath);
	const preparationSelection = checkpointPreparationSelection(runtime.execCli, { preparationPolicyHash: auth.preparationPolicyHash ?? null,
		preparationSelectionHash: snapshot.preparationSelectionHash ?? null, adapters: plan.adapterBindings });
	const firstTask = tasks[0];
	if (!firstTask) throw new SdlcError('TASK_PLAN_INVALID', 'Corrected final has no tasks');
	const task = { ...firstTask, parentTreeSha: treeSha, targetTreeSha: treeSha,
		generatedOutputs: [...new Set(tasks.flatMap(entry => entry.generatedOutputs ?? []))],
		authoredPaths: [...auth.allowedPathPrefixes], pathPrefixes: [...auth.allowedPathPrefixes] };
	const selectedRevisions = plan.integrationOrder.map(taskId => {
		const revision = revisions.get(taskId);
		if (!revision?.patchHash) throw new SdlcError('INVALID_CONTRACT', 'Missing corrected final revision');
		return { taskId, executionRevision: revision.executionRevision, patchHash: revision.patchHash };
	});
	const checkpointId = `final-${sha256({ treeSha, selectedRevisions }).slice(0, 40)}`;
	const binding = { runId: snapshot.runId, approvedSpecHash: snapshot.approvedSpecHash,
		taskPlanHash: snapshot.taskPlanHash, qualityPolicyHash: plan.qualityPolicyHash,
		checkpointId, checkpointKind: 'final' as const, ownerId: null,
		candidateRevision: Math.max(...selectedRevisions.map(revision => revision.executionRevision)),
		baseCommitSha: plan.baseCommitSha, treeSha, revisionSetHash: sha256(selectedRevisions),
		preparationHash: sourcePreparationHash(task, preparationSelection) };
	quality.registerWorktree({ runId: snapshot.runId, registryId: checkpointId, kind: 'final',
		ownerId: null, relativePath, bindingHash: sha256(binding), sourceHash: sha256(treeSha) });
	await materializeCorrectedFinal({ runtime, snapshot, correctionId, binding, worktreeDir,
		observeSource: () => createTaskSourceObserver(runtime, task, worktreeDir, preparationSelection)() });
	await hydrateWorktree({ worktreeDir, allowedPackages: auth.allowedPackages, runner: runtime.execCli,
		checkpoint: checkpointHydrationBinding(plan, snapshot, auth) });
	const receiptHashes = await executeCheckpointObligations({ runtime, snapshot, plan, binding, worktreeDir,
		registryId: checkpointId, obligations: plan.evidenceObligations,
		observeSource: createTaskSourceObserver(runtime, task, worktreeDir, preparationSelection) });
	await runtime.onBoundary('corrected-final-evidence', { runId: snapshot.runId, correctionId, checkpointId });
	const draft = runtime.artifactStore.readJson(snapshot.draftArtifact);
	const coverage = evaluateAcCoverageFromWorktree({ draft, baseCommitSha: plan.baseCommitSha,
		gitCli: runtime.gitCli, worktreeDir, allowedPathPrefixes: auth.allowedPathPrefixes,
		touchedTestFiles: [...new Set(plan.evidenceObligations.flatMap(entry => entry.testCases.map(test => test.file)))] });
	if (!coverage.pass) throw new SdlcError('POLICY_VIOLATION', 'Corrected final coverage failed');
	const preflight = await executePreflightVerifier({ runId: snapshot.runId, worktreeDir,
		rootDir: runtime.rootDir, baseCommitSha: plan.baseCommitSha, targetTreeSha: treeSha,
		targetPaths: auth.allowedPathPrefixes, artifactStore: runtime.artifactStore, execCli: runtime.execCli });
	if (preflight.status !== 'PASS') throw new SdlcError('POLICY_VIOLATION', 'Corrected final preflight failed');
	const preflightBindingArtifact = runtime.artifactStore.writeJson('corrected-final-preflight', preflight.binding);
	const staged = quality.getStagedClosure(snapshot.runId, correctionId, checkpointId, binding.candidateRevision);
	const closure: ClosureRecord = staged ?? { schemaVersion: '1.0.0', binding, selectedRevisions,
		registryId: checkpointId, status: 'reviewing', receiptHashes, reviewOperationIds: [] };
	if (!staged) quality.saveStagedClosure(correctionId, closure);
	const reviewSnapshot = { ...snapshot,
		targetTreeSha: treeSha, preflightBindingArtifact,
		qualityPolicy: plan.qualityPolicy, qualityCheckpointId: checkpointId, qualityCheckpointKind: 'final' as const,
		qualityCheckpointTreeSha: treeSha, qualityCheckpointBindingHash: sha256(binding) };
	const review = await runCheckpointQaCritic({ runtime, snapshot: reviewSnapshot,
		context: { plan, policy: plan.qualityPolicy, closure, worktreeDir } });
	if (review.hasP1 || !['PASS', 'SKIP'].includes(review.status)) {
		throw new SdlcError('POLICY_VIOLATION', 'Corrected final still lacks accepted adequacy');
	}
	quality.saveStagedClosure(correctionId, { ...closure, status: 'accepted' });
	return closure;
}
