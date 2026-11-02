import fs from 'node:fs';
import path from 'node:path';
import { materializeClosureTree } from '../execution/eligible-closure.ts';
import { SdlcError } from '../policy/errors.ts';
import { type GitCliFn } from './run-cleanup.ts';
import { isCheckpointWorktree, readRegisteredQualityWorktrees, readSelectedQualityPlan } from './quality-worktree-reader.ts';
import type { RecordedRun } from './run-retention.ts';

function diffWorktreeOrTree(
	rootDir: string,
	baseCommitSha: string,
	{ worktreeDir, targetTreeSha, gitCli }: {
		worktreeDir: string | null;
		targetTreeSha: string | null;
		gitCli: GitCliFn;
	},
): Buffer | null {
	const options = {
		maxBuffer: 64 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	};
	if (worktreeDir && fs.existsSync(worktreeDir)) {
		gitCli('git', ['-C', worktreeDir, 'add', '-N', '.'], options);
		return Buffer.from(gitCli('git', ['-C', worktreeDir, 'diff', '--binary', baseCommitSha], options));
	}
	if (targetTreeSha) return Buffer.from(gitCli('git', ['-C', rootDir, 'diff', '--binary', baseCommitSha, targetTreeSha], options));
	return null;
}

function buildSelectedQualityPatch(
	runRecord: RecordedRun,
	{ rootDir, targetTreeSha, gitCli }: { rootDir: string; targetTreeSha: string | null; gitCli: GitCliFn },
): Buffer | null {
	const selection = readSelectedQualityPlan(runRecord.runDir, runRecord.runId);
	if (!selection) return null;
	if (!runRecord.baseCommitSha || runRecord.baseCommitSha !== selection.plan.baseCommitSha) {
		throw new SdlcError('WORKTREE_FAILED', `Quality archive base commit mismatch for ${runRecord.runId}`);
	}
	const selectedTreeSha = materializeClosureTree({
		baseTreeSha: selection.plan.baseCommitSha,
		tasks: selection.tasks,
		rootDir,
		gitCli,
	});
	const recordedTreeSha = targetTreeSha ?? runRecord.targetTreeSha;
	if ((recordedTreeSha && recordedTreeSha !== selectedTreeSha) ||
		selection.finalTreeShas.some(tree => tree !== selectedTreeSha)) {
		throw new SdlcError('WORKTREE_FAILED', `Selected quality deltas do not reconstruct recorded final tree for ${runRecord.runId}`, {
			targetTreeSha: recordedTreeSha,
			selectedTreeSha,
		});
	}
	const patch = Buffer.from(gitCli('git', ['diff', '--binary', runRecord.baseCommitSha, selectedTreeSha], {
		cwd: rootDir,
		maxBuffer: 64 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	}));
	if (!patch.length) throw new SdlcError('WORKTREE_FAILED', `Empty selected quality patch for ${runRecord.runId}`);
	return patch;
}

export function buildUnlandedPatch(
	runRecord: RecordedRun,
	{ rootDir, targetTreeSha, gitCli }: { rootDir: string; targetTreeSha: string | null; gitCli: GitCliFn },
): Buffer {
	const baseCommitSha = runRecord.baseCommitSha;
	if (!baseCommitSha) {
		throw new SdlcError('WORKTREE_FAILED', `Cannot generate unlanded.patch for ${runRecord.runId}: missing baseCommitSha`);
	}
	const qualityPatch = buildSelectedQualityPatch(runRecord, { rootDir, targetTreeSha, gitCli });
	if (qualityPatch !== null) return qualityPatch;

	for (const candidate of [
		path.join(runRecord.runDir, 'worktrees', 'integration'),
		path.join(runRecord.runDir, 'worktree'),
	]) {
		if (isCheckpointWorktree(runRecord.runDir, candidate)) continue;
		if (!fs.existsSync(candidate)) continue;
		const patch = diffWorktreeOrTree(rootDir, baseCommitSha, { worktreeDir: candidate, targetTreeSha, gitCli });
		if (!patch?.length) throw new SdlcError('WORKTREE_FAILED', `Empty unlanded.patch for ${runRecord.runId}`);
		return patch;
	}

	const multiWorktreesRoot = path.join(runRecord.runDir, 'worktrees');
	const taskMap = new Map((runRecord.dagTasks ?? []).map((task) => [task.task_id, task]));
	const taskIds = new Set(taskMap.keys());
	const checkpointPaths = readRegisteredQualityWorktrees(runRecord.runDir)
		.filter(record => record.kind !== 'task')
		.map(record => path.resolve(runRecord.runDir, record.relativePath));
	if (fs.existsSync(multiWorktreesRoot)) {
		for (const entry of fs.readdirSync(multiWorktreesRoot, { withFileTypes: true })) {
			const candidate = path.join(multiWorktreesRoot, entry.name);
			if (checkpointPaths.some(dir => dir === candidate || dir.startsWith(`${candidate}${path.sep}`))) continue;
			if ((entry.isDirectory() || entry.isSymbolicLink()) && entry.name !== 'integration') taskIds.add(entry.name);
		}
	}
	const sortedTaskIds = [...taskIds].sort((left, right) => left.localeCompare(right));
	if (sortedTaskIds.length > 0) {
		const patches: Buffer[] = [];
		for (const taskId of sortedTaskIds) {
			if (isCheckpointWorktree(runRecord.runDir, path.join(multiWorktreesRoot, taskId))) continue;
			const taskRow = taskMap.get(taskId);
			const taskPatch = diffWorktreeOrTree(rootDir, taskRow?.base_commit_sha ?? baseCommitSha, {
				worktreeDir: path.join(multiWorktreesRoot, taskId),
				targetTreeSha: taskRow?.target_tree_sha ?? null,
				gitCli,
			});
			if (taskPatch?.length) patches.push(Buffer.concat([Buffer.from(`# task: ${taskId}\n`), taskPatch]));
		}
		const combined = Buffer.concat(patches.flatMap((patch, index) => index ? [Buffer.from('\n'), patch] : [patch]));
		if (!combined.length) throw new SdlcError('WORKTREE_FAILED', `Empty multi-task patch for ${runRecord.runId}`);
		return combined;
	}

	const patch = diffWorktreeOrTree(rootDir, baseCommitSha, { worktreeDir: null, targetTreeSha, gitCli });
	if (!patch?.length) throw new SdlcError('WORKTREE_FAILED', `Cannot generate unlanded.patch for ${runRecord.runId}`);
	return patch;
}
