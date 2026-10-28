import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ReconciliationRecord, TaskPlan } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import type { GitCliFn } from './git-manager.ts';
import {
	type DetachedWorktreeResult,
	removeWorktree,
	resolveIntegrationWorktreeDir,
	resolveWorktreeDir,
} from './worktrees.ts';
import { assertPlanFrozenThenCreateWorktree } from './worktree-guard.ts';

function gitText(
	gitCli: GitCliFn,
	args: readonly string[],
	options: Record<string, unknown>,
): string {
	const result = gitCli('git', args, options);
	return typeof result === 'string' ? result : result.toString('utf8');
}

/**
 * Resets or cleans the integration worktree without git reset --hard.
 */
export function resetIntegrationWorktree({
	runId,
	baseCommitSha,
	rootDir = REPOSITORY_ROOT,
	gitCli = execFileSync as GitCliFn,
	snapshot = null,
	taskPlanFrozen,
}: {
	runId: string;
	baseCommitSha: string;
	rootDir?: string;
	gitCli?: GitCliFn;
	snapshot?: { taskPlanFrozen?: boolean } | null;
	taskPlanFrozen?: boolean;
}): DetachedWorktreeResult {
	const integrationWorktreePath = resolveIntegrationWorktreeDir(runId, rootDir);
	if (fs.existsSync(integrationWorktreePath)) {
		removeWorktree(runId, {
			rootDir,
			force: true,
			worktreeDir: integrationWorktreePath,
			gitCli,
		});
	}
	return assertPlanFrozenThenCreateWorktree({
		snapshot,
		taskPlanFrozen,
		runId,
		baseCommitSha,
		worktreeDir: integrationWorktreePath,
		rootDir,
		gitCli,
	});
}

export type ReconcileTasksResult =
	| {
			status: 'RECONCILIATION_COMPLETED';
			integrationWorktreePath: string;
			reconciledTreeSha: string;
			reconciliationRecord: ReconciliationRecord;
	  }
	| {
			status: 'RECONCILIATION_CONFLICT';
			integrationWorktreePath: string;
			failingTaskId: string;
			conflictingTaskId: string;
			conflictDetails: Record<string, unknown>;
			reconciliationRecord: ReconciliationRecord;
	  };

/**
 * Reconciles completed tasks in deterministic integrationOrder.
 * For single-task runs, performs an identity reconcile on the legacy worktree.
 * For multi-task runs, applies binary diff patches onto a fresh integration worktree.
 */
export async function reconcileTasks({
	runId,
	taskPlan,
	authorization: _authorization,
	runtimeStore,
	rootDir = REPOSITORY_ROOT,
	gitCli = execFileSync as GitCliFn,
	taskPlanFrozen,
	snapshot = null,
}: {
	runId: string;
	taskPlan: Readonly<TaskPlan>;
	authorization?: unknown;
	runtimeStore?: { saveReconciliation(record: ReconciliationRecord): void } | null;
	rootDir?: string;
	gitCli?: GitCliFn;
	taskPlanFrozen?: boolean;
	snapshot?: { taskPlanFrozen?: boolean } | null;
}): Promise<ReconcileTasksResult> {
	// 1. Single-task run: Identity reconcile (P2-1)
	if (taskPlan.tasks.length === 1) {
		const task = taskPlan.tasks[0];
		if (!task) {
			throw new SdlcError('TASK_PLAN_INVALID', 'Single-task plan is missing task entry');
		}
		const integrationWorktreePath = resolveWorktreeDir(
			runId,
			rootDir,
			task.worktreeSubdir || 'worktree',
		);
		const reconciledTreeSha =
			task.targetTreeSha || task.parentTreeSha || task.baseCommitSha;

		const record: ReconciliationRecord = {
			reconciliationId: `recon-${crypto.randomUUID()}`,
			runId,
			integrationOrder: [...taskPlan.integrationOrder],
			reconciledTreeSha,
			status: 'RECONCILIATION_COMPLETED',
			conflictDetails: null,
			reconciledAt: new Date().toISOString(),
		};

		if (runtimeStore) {
			runtimeStore.saveReconciliation(record);
		}

		return {
			status: 'RECONCILIATION_COMPLETED',
			integrationWorktreePath,
			reconciledTreeSha,
			reconciliationRecord: record,
		};
	}

	// 2. Multi-task run: Fresh detached checkout at worktrees/integration
	const integrationWorktreePath = resolveIntegrationWorktreeDir(runId, rootDir);

	resetIntegrationWorktree({
		runId,
		baseCommitSha: taskPlan.baseCommitSha,
		rootDir,
		gitCli,
		snapshot,
		taskPlanFrozen,
	});

	const taskMap = new Map(taskPlan.tasks.map((t) => [t.taskId, t]));

	// 3. Iterate tasks in predetermined integrationOrder
	for (const taskId of taskPlan.integrationOrder) {
		const task = taskMap.get(taskId);
		if (!task) {
			throw new SdlcError(
				'TASK_PLAN_INVALID',
				`Task '${taskId}' from integrationOrder not found in taskPlan`,
				{ taskId },
			);
		}

		// Empty diffs where targetTreeSha === parentTreeSha are no-ops
		if (!task.targetTreeSha || !task.parentTreeSha || task.targetTreeSha === task.parentTreeSha) {
			continue;
		}

		// Generate binary patch: git diff-tree -p --binary parentTreeSha targetTreeSha
		const patch = gitText(
			gitCli,
			['diff-tree', '-p', '--binary', task.parentTreeSha, task.targetTreeSha],
			{
				cwd: rootDir,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		);

		if (!patch || patch.trim().length === 0) {
			continue;
		}

		// Verify task diff contains zero files outside task.pathPrefixes
		const changedFilesOutput = gitText(
			gitCli,
			['diff-tree', '--name-only', '-r', task.parentTreeSha, task.targetTreeSha],
			{
				cwd: rootDir,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		);
		const changedFiles = changedFilesOutput.trim().split('\n').filter(Boolean);

		const allowedPrefixes = [
			...(task.pathPrefixes ?? []),
			...(task.generatedOutputs ?? []),
		];
		for (const file of changedFiles) {
			const isContained = allowedPrefixes.some(
				(prefix) =>
					file === prefix ||
					file.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'),
			);
			if (!isContained) {
				throw new SdlcError(
					'PATH_CONTAINMENT_VIOLATION',
					`Reconciliation containment failed: task '${task.taskId}' touched file '${file}' outside pathPrefixes: ${task.pathPrefixes.join(', ')}`,
					{ taskId: task.taskId, file, pathPrefixes: task.pathPrefixes },
				);
			}
		}

		// Dry-run patch apply
		try {
			gitCli('git', ['apply', '--check', '--binary', '-'], {
				cwd: integrationWorktreePath,
				input: patch,
				stdio: ['pipe', 'pipe', 'pipe'],
			});
		} catch (checkErr: unknown) {
			const errMessage = checkErr instanceof Error ? checkErr.message : String(checkErr);
			const conflictDetails = {
				failingTaskId: task.taskId,
				error: errMessage,
				patchSnippet: patch.slice(0, 500),
			};

			const record: ReconciliationRecord = {
				reconciliationId: `recon-${crypto.randomUUID()}`,
				runId,
				integrationOrder: [...taskPlan.integrationOrder],
				reconciledTreeSha: taskPlan.baseCommitSha,
				status: 'RECONCILIATION_CONFLICT',
				conflictDetails,
				reconciledAt: new Date().toISOString(),
			};

			if (runtimeStore) {
				runtimeStore.saveReconciliation(record);
			}

			return {
				status: 'RECONCILIATION_CONFLICT',
				integrationWorktreePath,
				failingTaskId: task.taskId,
				conflictingTaskId: task.taskId,
				conflictDetails,
				reconciliationRecord: record,
			};
		}

		try {
			gitCli('git', ['apply', '--binary', '-'], {
				cwd: integrationWorktreePath,
				input: patch,
				stdio: ['pipe', 'pipe', 'pipe'],
			});
		} catch (applyErr: unknown) {
			const errMessage =
				applyErr instanceof Error && applyErr.message ? applyErr.message : 'git apply failed';
			const conflictDetails = {
				error: errMessage,
				conflictingTaskId: task.taskId,
				reconciliationOrder: taskPlan.integrationOrder,
			};

			const record: ReconciliationRecord = {
				reconciliationId: `recon-${crypto.randomUUID()}`,
				runId,
				integrationOrder: [...taskPlan.integrationOrder],
				reconciledTreeSha: taskPlan.baseCommitSha,
				status: 'RECONCILIATION_CONFLICT',
				conflictDetails,
				reconciledAt: new Date().toISOString(),
			};

			if (runtimeStore) {
				runtimeStore.saveReconciliation(record);
			}

			// Clean and recreate integration worktree to leave it in a clean state at baseCommitSha
			resetIntegrationWorktree({
				runId,
				baseCommitSha: taskPlan.baseCommitSha,
				rootDir,
				gitCli,
				snapshot,
				taskPlanFrozen,
			});

			return {
				status: 'RECONCILIATION_CONFLICT',
				integrationWorktreePath,
				failingTaskId: task.taskId,
				conflictingTaskId: task.taskId,
				conflictDetails,
				reconciliationRecord: record,
			};
		}
	}

	// 4. Materialize reconciledTreeSha
	const parentDir = path.dirname(integrationWorktreePath);
	const tmpIndex = path.join(
		parentDir,
		`.tmp-index-reconcile-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
	);
	const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
	let reconciledTreeSha: string;

	try {
		gitCli('git', ['read-tree', taskPlan.baseCommitSha], {
			cwd: integrationWorktreePath,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		gitCli('git', ['add', '-A'], {
			cwd: integrationWorktreePath,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		reconciledTreeSha = gitText(gitCli, ['write-tree'], {
			cwd: integrationWorktreePath,
			env,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		}).trim();
	} finally {
		if (fs.existsSync(tmpIndex)) {
			try {
				fs.unlinkSync(tmpIndex);
			} catch {
				// Best-effort cleanup
			}
		}
	}

	const record: ReconciliationRecord = {
		reconciliationId: `recon-${crypto.randomUUID()}`,
		runId,
		integrationOrder: [...taskPlan.integrationOrder],
		reconciledTreeSha,
		status: 'RECONCILIATION_COMPLETED',
		conflictDetails: null,
		reconciledAt: new Date().toISOString(),
	};

	if (runtimeStore) {
		runtimeStore.saveReconciliation(record);
	}

	return {
		status: 'RECONCILIATION_COMPLETED',
		integrationWorktreePath,
		reconciledTreeSha,
		reconciliationRecord: record,
	};
}
