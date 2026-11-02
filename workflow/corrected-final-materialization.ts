import fs from 'node:fs';
import type { CandidateBinding } from '../policy/contracts/quality-schema.ts';
import { sha256, type RuntimeState } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import type { EvidenceInvocationContext } from '../host/evidence-types.ts';
import type { WorkflowRuntimeLike } from './node-helpers.ts';
import { resetIntegrationWorktree } from './reconciliation.ts';

export async function materializeCorrectedFinal({
	runtime, snapshot, correctionId, binding, worktreeDir, observeSource,
}: {
	runtime: WorkflowRuntimeLike; snapshot: Readonly<RuntimeState>; correctionId: string;
	binding: CandidateBinding; worktreeDir: string;
	observeSource: EvidenceInvocationContext['observeSource'];
}): Promise<void> {
	const quality = runtime.runtimeStore.quality;
	const relativePath = 'worktrees/integration';
	const observedTree = fs.existsSync(worktreeDir) ? (await observeSource()).treeSha : null;
	let progress = quality.getFinalMaterialization(snapshot.runId, correctionId);
	if (!progress) {
		const priorTrees = quality.listClosures(snapshot.runId).filter(closure =>
			closure.binding.checkpointKind === 'final' &&
			quality.getWorktree(snapshot.runId, closure.registryId)?.relativePath === relativePath)
			.map(closure => closure.binding.treeSha);
		if (observedTree !== null && !priorTrees.includes(observedTree)) {
			throw new SdlcError('POLICY_VIOLATION', 'Final snapshot has unrecognized source edits');
		}
		quality.beginFinalMaterialization({
			runId: snapshot.runId, correctionId, binding, relativePath, priorTreeSha: observedTree,
			baseTreeSha: String(runtime.gitCli('git', ['rev-parse', `${binding.baseCommitSha}^{tree}`],
				{ cwd: runtime.rootDir, encoding: 'utf8' })).trim(),
		});
		progress = quality.getFinalMaterialization(snapshot.runId, correctionId);
	}
	if (!progress || sha256(progress.intent.binding) !== sha256(binding)) {
		throw new SdlcError('POLICY_VIOLATION', 'Corrected final materialization identity changed');
	}
	const { intent } = progress;
	const allowedTrees = progress.phase === 'intended' ? [intent.priorTreeSha] :
		progress.phase === 'resetting' ? [intent.priorTreeSha, intent.baseTreeSha, null] :
		progress.phase === 'checking-out' ? [intent.baseTreeSha, binding.treeSha] : [binding.treeSha];
	if (!allowedTrees.includes(observedTree)) {
		throw new SdlcError('POLICY_VIOLATION', 'Final snapshot has unrecognized source edits');
	}
	if (progress.phase === 'intended') {
		quality.advanceFinalMaterialization(snapshot.runId, correctionId, 'resetting');
		progress = { intent, phase: 'resetting' };
	}
	if (progress.phase === 'resetting') {
		await runtime.onBoundary('corrected-final-reset-intent-recorded', { runId: snapshot.runId, correctionId });
		resetIntegrationWorktree({ runId: snapshot.runId, baseCommitSha: binding.baseCommitSha,
			rootDir: runtime.rootDir, gitCli: runtime.gitCli, taskPlanFrozen: true });
		await runtime.onBoundary('corrected-final-reset', { runId: snapshot.runId, correctionId });
		quality.advanceFinalMaterialization(snapshot.runId, correctionId, 'checking-out');
		progress = { intent, phase: 'checking-out' };
	}
	if (progress.phase === 'checking-out') {
		runtime.gitCli('git', ['read-tree', '--reset', '-u', binding.treeSha], { cwd: worktreeDir });
		await runtime.onBoundary('corrected-final-checkout', { runId: snapshot.runId, correctionId });
		quality.advanceFinalMaterialization(snapshot.runId, correctionId, 'ready');
	}
	await runtime.onBoundary('corrected-final-ready', { runId: snapshot.runId, correctionId });
}
