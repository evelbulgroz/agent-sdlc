import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { liveRunRoot } from '../persistence/run-paths.ts';
import { SdlcError } from '../policy/errors.ts';
import { materializeClosureTree, sliceClosureTasks, type ClosurePlan } from '../execution/eligible-closure.ts';
import type { GitCliFn } from '../execution/task-tree-delta.ts';
import { assertPlanFrozenThenCreateWorktree } from './worktree-guard.ts';
import { createSyntheticCommit } from './worktrees.ts';

export interface CheckpointMaterialization {
	readonly checkpointId: string;
	readonly sliceId: string;
	readonly kind: 'enabling' | 'slice';
	readonly relativePath: string;
	readonly worktreeDir: string;
	readonly treeSha: string;
	readonly constituentTaskIds: readonly string[];
}

export function materializeSliceCheckpoint({
	runId, sliceId, taskPlan, baseCommitSha, rootDir, gitCli, frozen, register, revisionIdentity,
}: {
	runId: string; sliceId: string; taskPlan: ClosurePlan; baseCommitSha: string;
	rootDir: string; gitCli: GitCliFn; frozen: boolean;
	revisionIdentity?: string;
	register: (checkpoint: CheckpointMaterialization) => void;
}): CheckpointMaterialization {
	if (!frozen) throw new SdlcError('POLICY_VIOLATION', 'Checkpoint requires frozen plan');
	const slice = taskPlan.slices.find(entry => entry.sliceId === sliceId);
	if (!slice) throw new SdlcError('TASK_PLAN_INVALID', `Unknown checkpoint slice '${sliceId}'`);
	const tasks = sliceClosureTasks(taskPlan, sliceId);
	const treeSha = materializeClosureTree({
		baseTreeSha: String(gitCli('git', ['rev-parse', `${baseCommitSha}^{tree}`],
			{ cwd: rootDir, encoding: 'utf8' })).trim(),
		tasks, rootDir, gitCli,
	});
	const checkpointId = `checkpoint-${crypto.createHash('sha256').update(JSON.stringify({
		runId, sliceId, treeSha, tasks: tasks.map(task => [task.taskId, task.patchHash]),
		...(revisionIdentity ? { revisionIdentity } : {}),
	})).digest('hex').slice(0, 40)}`;
	const relativePath = `checkpoint-worktrees/${checkpointId}`;
	const worktreeDir = path.join(liveRunRoot(rootDir), runId, relativePath);
	const result: CheckpointMaterialization = {
		checkpointId, sliceId, kind: slice.kind === 'enabling' ? 'enabling' : 'slice',
		relativePath, worktreeDir, treeSha, constituentTaskIds: tasks.map(task => task.taskId),
	};
	// Persist the intended exact path before creation so interruption is recoverable.
	register(result);
	if (fs.existsSync(worktreeDir)) {
		if (fs.lstatSync(worktreeDir).isSymbolicLink()) throw new SdlcError('PATH_CONTAINMENT_VIOLATION', 'Checkpoint symlink');
		const actual = String(gitCli('git', ['rev-parse', 'HEAD^{tree}'], { cwd: worktreeDir, encoding: 'utf8' })).trim();
		const dirt = String(gitCli('git', ['status', '--porcelain', '--untracked-files=all'],
			{ cwd: worktreeDir, encoding: 'utf8' })).trim();
		if (actual !== treeSha || dirt) throw new SdlcError('INVALID_CONTRACT', 'Existing checkpoint source/binding changed');
		return result;
	}
	const commitSha = createSyntheticCommit({
		parentTreeSha: treeSha, baseCommitSha, message: `sdlc checkpoint ${checkpointId}`,
		rootDir, gitCli,
	});
	assertPlanFrozenThenCreateWorktree({
		runId, baseCommitSha, commitSha, worktreeDir, rootDir, gitCli, taskPlanFrozen: frozen,
	});
	return result;
}
