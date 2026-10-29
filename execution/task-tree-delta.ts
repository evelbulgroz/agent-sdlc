import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPOSITORY_ROOT, stateDirRelative } from '../persistence/run-paths.ts';
import { sha256 } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { assertPlanFrozenThenCreateWorktree } from '../workflow/worktree-guard.ts';
import { removeWorktree } from '../workflow/worktrees.ts';

export type GitCliFn = (
	command: string,
	args: readonly string[],
	options?: Record<string, unknown>,
) => string | Buffer;

function gitText(value: string | Buffer | null | undefined): string {
	if (typeof value === 'string') return value;
	return value ? value.toString('utf8') : '';
}

export interface DeltaTaskLike {
	readonly taskId: string;
	readonly baseCommitSha?: string | null;
	readonly parentTreeSha?: string | null;
	readonly targetTreeSha?: string | null;
	readonly dependsOn?: readonly string[];
	readonly authoredPaths?: readonly string[];
	readonly generatedOutputs?: readonly string[];
	readonly pathPrefixes: readonly string[];
}

export interface DeltaTaskPlanLike {
	readonly runId: string;
	readonly baseCommitSha?: string | null;
	readonly integrationOrder?: readonly string[];
	readonly tasks: readonly DeltaTaskLike[];
}

/**
 * Derives parent tree SHA for a task.
 * For independent tasks, returns baseCommitSha^{tree}.
 * For dependent tasks, returns upstream parent targetTreeSha.
 */
export function deriveParentTreeSha({
	task,
	taskPlan,
	rootDir = REPOSITORY_ROOT,
	gitCli = execFileSync as GitCliFn,
	snapshot = null,
	taskPlanFrozen,
}: {
	task: DeltaTaskLike;
	taskPlan: DeltaTaskPlanLike;
	rootDir?: string;
	gitCli?: GitCliFn;
	snapshot?: { readonly taskPlanFrozen?: boolean; readonly [key: string]: unknown } | null;
	taskPlanFrozen?: boolean;
}): string {
	if (!task.dependsOn || task.dependsOn.length === 0) {
		const baseSha = task.baseCommitSha || taskPlan.baseCommitSha || '';
		try {
			const out = gitCli('git', ['rev-parse', `${baseSha}^{tree}`], {
				cwd: rootDir,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			const trimmed = gitText(out).trim();
			if (/^[a-f0-9]{40}$/.test(trimmed)) {
				return trimmed;
			}
		} catch {
			// fall back to baseSha
		}
		return baseSha;
	}

	const taskMap = new Map(taskPlan.tasks.map((t) => [t.taskId, t]));

	if (task.dependsOn.length === 1) {
		const parentId = task.dependsOn[0] ?? '';
		const parent = taskMap.get(parentId);
		if (!parent || !parent.targetTreeSha) {
			throw new SdlcError(
				'TASK_EXECUTION_FAILED',
				`Parent task '${parentId}' has not completed or targetTreeSha is missing`,
				{ taskId: task.taskId, parentId },
			);
		}
		return parent.targetTreeSha;
	}

	// Multiple parents: apply every transitive ancestor delta once in integration order.
	const ancestorIds = new Set<string>();
	const collectAncestors = (taskId: string): void => {
		if (ancestorIds.has(taskId)) return;
		ancestorIds.add(taskId);
		for (const dependencyId of taskMap.get(taskId)?.dependsOn ?? []) {
			collectAncestors(dependencyId);
		}
	};
	for (const dependencyId of task.dependsOn) collectAncestors(dependencyId);
	const upstreamOrder = (taskPlan.integrationOrder || []).filter((id) =>
		ancestorIds.has(id),
	);
	const upstreamTasks: Array<DeltaTaskLike & { targetTreeSha: string }> = [];
	for (const id of upstreamOrder) {
		const p = taskMap.get(id);
		if (!p || !p.targetTreeSha) {
			throw new SdlcError(
				'TASK_EXECUTION_FAILED',
				`Upstream task '${p?.taskId ?? id}' has not completed or targetTreeSha is missing`,
				{ taskId: task.taskId, parentId: p?.taskId ?? id },
			);
		}
		upstreamTasks.push({ ...p, targetTreeSha: p.targetTreeSha });
	}

	const baseCommitSha = task.baseCommitSha || taskPlan.baseCommitSha || '';
	const runId = taskPlan.runId;
	const tmpWorktreeDir = path.join(
		rootDir,
		stateDirRelative(rootDir),
		runId,
		'worktrees',
		`.tmp-multi-${task.taskId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
	);

	assertPlanFrozenThenCreateWorktree({
		snapshot,
		taskPlanFrozen,
		runId,
		baseCommitSha,
		worktreeDir: tmpWorktreeDir,
		rootDir,
		gitCli,
	});

	try {
		for (const p of upstreamTasks) {
			const parentBaseTree = p.parentTreeSha || baseCommitSha;
			const patch = gitText(
				gitCli('git', ['diff-tree', '-p', '--binary', parentBaseTree, p.targetTreeSha], {
					cwd: rootDir,
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
				}),
			);

			if (patch && patch.trim()) {
				try {
					gitCli('git', ['apply', '--check', '--binary', '-'], {
						cwd: tmpWorktreeDir,
						input: patch,
						stdio: ['pipe', 'pipe', 'pipe'],
					});
					gitCli('git', ['apply', '--binary', '-'], {
						cwd: tmpWorktreeDir,
						input: patch,
						stdio: ['pipe', 'pipe', 'pipe'],
					});
				} catch (applyErr) {
					const msg = applyErr instanceof Error ? applyErr.message : String(applyErr);
					throw new SdlcError(
						'RECONCILIATION_CONFLICT',
						`Upstream dependency patch conflict for task '${task.taskId}' from parent '${p.taskId}': ${msg}`,
						{ taskId: task.taskId, conflictingTaskId: p.taskId },
						{ cause: applyErr },
					);
				}
			}
		}

		const parentDir = path.dirname(tmpWorktreeDir);
		const tmpIndex = path.join(
			parentDir,
			`.tmp-index-${task.taskId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
		);
		const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
		try {
			gitCli('git', ['read-tree', baseCommitSha], {
				cwd: tmpWorktreeDir,
				env,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			gitCli('git', ['add', '-A'], {
				cwd: tmpWorktreeDir,
				env,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			const multiParentTreeSha = gitText(
				gitCli('git', ['write-tree'], {
					cwd: tmpWorktreeDir,
					env,
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
				}),
			).trim();
			return multiParentTreeSha;
		} finally {
			if (fs.existsSync(tmpIndex)) {
				try {
					fs.unlinkSync(tmpIndex);
				} catch {}
			}
		}
	} finally {
		if (fs.existsSync(tmpWorktreeDir)) {
			try {
				removeWorktree(runId, {
					worktreeDir: tmpWorktreeDir,
					rootDir,
					gitCli,
					force: true,
				});
			} catch {}
		}
	}
}

export interface TaskDeltaResult {
	readonly targetTreeSha: string;
	readonly patch: string;
	readonly patchHash: string;
	readonly changedFiles: string[];
}

/**
 * Materializes task mutations via temporary git index, asserts path containment,
 * writes the new tree object, and generates the binary diff patch.
 */
export function captureTaskDelta({
	task,
	worktreeDir,
	rootDir = REPOSITORY_ROOT,
	gitCli = execFileSync as GitCliFn,
}: {
	task: DeltaTaskLike;
	worktreeDir: string;
	rootDir?: string;
	gitCli?: GitCliFn;
}): TaskDeltaResult {
	const parentTreeSha =
		task.parentTreeSha ||
		(() => {
			try {
				const out = gitCli('git', ['rev-parse', `${String(task.baseCommitSha ?? '')}^{tree}`], {
					cwd: rootDir,
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
				});
				const trimmed = gitText(out).trim();
				if (/^[a-f0-9]{40}$/.test(trimmed)) {
					return trimmed;
				}
			} catch {}
			return task.baseCommitSha || '';
		})();

	const parentDir = path.dirname(worktreeDir);
	const tempIndex = path.join(
		parentDir,
		`.tmp-index-${task.taskId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
	);
	const env = { ...process.env, GIT_INDEX_FILE: tempIndex };

	try {
		// 1. Read parent tree into temp index
		gitCli('git', ['read-tree', parentTreeSha], {
			cwd: worktreeDir,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		// 2. Stage all working tree changes into temp index
		gitCli('git', ['add', '-A'], {
			cwd: worktreeDir,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		// 3. Inspect changed files in temp index compared to parent tree
		const diffOutput = gitText(
			gitCli('git', ['diff-index', '--cached', '--name-only', parentTreeSha], {
				cwd: worktreeDir,
				env,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			}),
		);
		const changedFiles = diffOutput.trim().split('\n').filter(Boolean);

		// 4. Assert exact authored/generated output containment for manifest tasks.
		const deltaPrefixes =
			task.authoredPaths || task.generatedOutputs
				? [...(task.authoredPaths ?? []), ...(task.generatedOutputs ?? [])]
				: task.pathPrefixes;
		for (const file of changedFiles) {
			const contained = deltaPrefixes.some(
				(prefix) => file === prefix || file.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'),
			);
			if (!contained) {
				throw new SdlcError(
					'PATH_CONTAINMENT_VIOLATION',
					`File '${file}' modified outside task authored/generated paths: ${deltaPrefixes.join(', ')}`,
					{ file, taskId: task.taskId, allowedDeltaPrefixes: [...deltaPrefixes] },
				);
			}
		}

		// 5. Write tree
		const targetTreeSha = gitText(
			gitCli('git', ['write-tree'], {
				cwd: worktreeDir,
				env,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			}),
		).trim();

		// 6. Generate binary delta patch
		let patch = '';
		if (targetTreeSha !== parentTreeSha) {
			patch = gitText(
				gitCli('git', ['diff-tree', '-p', '--binary', parentTreeSha, targetTreeSha], {
					cwd: worktreeDir,
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
				}),
			);
		}
		const patchHash = sha256(patch);

		return {
			targetTreeSha,
			patch,
			patchHash,
			changedFiles,
		};
	} finally {
		try {
			if (fs.existsSync(tempIndex)) {
				fs.unlinkSync(tempIndex);
			}
		} catch {}
	}
}
