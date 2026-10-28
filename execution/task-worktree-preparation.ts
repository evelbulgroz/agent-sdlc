import { createEvent } from '../policy/contracts.ts';
import { hydrateWorktree } from '../workflow/hydration.ts';
import { assertPlanFrozenThenCreateWorktree } from '../workflow/worktree-guard.ts';
import { createSyntheticCommit } from '../workflow/worktrees.ts';
import {
	type TaskScopeAuthorizationLike,
	type TaskScopePlanLike,
	type TaskScopeTaskLike,
	collectCumulativeTaskPackages,
} from './task-scope.ts';
import type { GitCliFn } from './task-tree-delta.ts';
import type { CommandExecFn } from './tool-commands.ts';

export interface PreparableTask extends TaskScopeTaskLike {
	readonly taskId: string;
	readonly targetPackage: string;
	readonly baseCommitSha: string;
	readonly dependsOn?: readonly string[];
	parentCommitSha?: string | null;
	status?: string;
}

export interface WorktreeRuntimeStoreLike {
	listEvents(runId: string): ReadonlyArray<{
		readonly eventType: string;
		readonly payload?: { readonly taskId?: string | null; readonly [key: string]: unknown };
	}>;
	appendEvent(event: unknown): void;
	updateTaskStatus(
		runId: string,
		taskId: string,
		patch: {
			status?: string;
			parentTreeSha?: string | null;
			parentCommitSha?: string | null;
			targetTreeSha?: string | null;
			patchHash?: string | null;
		},
	): void;
}

export interface PrepareTaskWorktreeOptions {
	readonly task: PreparableTask;
	readonly taskPlan: TaskScopePlanLike;
	readonly authorization?: TaskScopeAuthorizationLike | null;
	readonly snapshot?: {
		readonly runtimeRevision?: number;
		readonly taskPlanFrozen?: boolean;
		readonly [key: string]: unknown;
	} | null;
	readonly runId: string;
	readonly worktreeDir: string;
	readonly parentTreeSha: string;
	readonly previousParentTreeSha?: string | null;
	readonly rootDir?: string;
	readonly gitCli?: GitCliFn;
	readonly execCli?: CommandExecFn;
	readonly runtimeStore: WorktreeRuntimeStoreLike;
	readonly runtime?: { readonly now?: () => Date } | null;
	readonly onBoundary?: (
		name: string,
		payload: { runId: string; taskId: string },
	) => Promise<void> | void;
}

export async function prepareTaskWorktree({
	task,
	taskPlan,
	authorization,
	snapshot,
	runId,
	worktreeDir,
	parentTreeSha,
	previousParentTreeSha,
	rootDir,
	gitCli,
	execCli,
	runtimeStore,
	runtime,
	onBoundary,
}: PrepareTaskWorktreeOptions): Promise<void> {
	if (!task.dependsOn || task.dependsOn.length === 0) {
		assertPlanFrozenThenCreateWorktree({
			snapshot,
			runId,
			baseCommitSha: task.baseCommitSha,
			worktreeDir,
			rootDir,
			gitCli,
		});
	} else {
		let commitSha =
			task.parentCommitSha && (!previousParentTreeSha || previousParentTreeSha === parentTreeSha)
				? task.parentCommitSha
				: null;
		if (!commitSha) {
			commitSha = createSyntheticCommit({
				parentTreeSha,
				baseCommitSha: task.baseCommitSha,
				message: `sdlc intermediate parent for ${task.taskId}`,
				rootDir,
				gitCli,
			});
			task.parentCommitSha = commitSha;
			if (runtimeStore) {
				runtimeStore.updateTaskStatus(runId, task.taskId, {
					parentCommitSha: commitSha,
				});
			}
		}
		assertPlanFrozenThenCreateWorktree({
			snapshot,
			runId,
			baseCommitSha: task.baseCommitSha,
			commitSha,
			worktreeDir,
			rootDir,
			gitCli,
		});
	}

	const existingEvents = runtimeStore.listEvents(runId);
	const hasPrepared = existingEvents.some(
		(e) =>
			e.eventType === 'WORKTREE_PREPARED' &&
			(e.payload?.taskId === task.taskId || (!e.payload?.taskId && task.taskId === 'task-0')),
	);
	if (!hasPrepared) {
		const prepEvent = createEvent({
			eventType: 'WORKTREE_PREPARED',
			runId,
			runtimeRevision: snapshot?.runtimeRevision ?? 0,
			causalId: `prepare-worktree-${task.taskId}`,
			payload: {
				taskId: task.taskId,
				worktreeDir,
				baseCommitSha: task.baseCommitSha,
			},
			now: runtime?.now ? runtime.now() : new Date(),
		});
		runtimeStore.appendEvent(prepEvent);
		if (onBoundary) {
			await onBoundary('worktree-prepared-transition-recorded', {
				runId,
				taskId: task.taskId,
			});
		}
	}

	// 4. Hydrate task worktree lazily
	const cumulativeAllowedPackages = collectCumulativeTaskPackages(
		task,
		taskPlan,
		authorization,
	);
	const hydrationResult = await hydrateWorktree({
		worktreeDir,
		targetPackage: task.targetPackage,
		allowedPackages: cumulativeAllowedPackages,
		runner: execCli,
	});

	const hasHydrated = existingEvents.some(
		(e) =>
			e.eventType === 'WORKTREE_HYDRATED' &&
			(e.payload?.taskId === task.taskId || (!e.payload?.taskId && task.taskId === 'task-0')),
	);
	if (!hasHydrated) {
		const hydrateEvent = createEvent({
			eventType: 'WORKTREE_HYDRATED',
			runId,
			runtimeRevision: snapshot?.runtimeRevision ?? 0,
			causalId: `hydrate-worktree-${task.taskId}`,
			payload: {
				taskId: task.taskId,
				hydrationFingerprint: hydrationResult?.fingerprint || 'initial',
				cached: hydrationResult?.status === 'CACHED',
			},
			now: runtime?.now ? runtime.now() : new Date(),
		});
		runtimeStore.appendEvent(hydrateEvent);
		if (onBoundary) {
			await onBoundary('worktree-hydrated-transition-recorded', {
				runId,
				taskId: task.taskId,
			});
		}
	}

	// 5. Update task status to in_progress
	task.status = 'in_progress';
	runtimeStore.updateTaskStatus(runId, task.taskId, {
		status: 'in_progress',
		parentTreeSha,
	});

	const hasStarted = existingEvents.some(
		(e) => e.eventType === 'TASK_STARTED' && e.payload?.taskId === task.taskId,
	);
	if (!hasStarted) {
		const startEvent = createEvent({
			eventType: 'TASK_STARTED',
			runId,
			runtimeRevision: snapshot?.runtimeRevision ?? 0,
			causalId: `start-task-${task.taskId}`,
			payload: {
				taskId: task.taskId,
				targetPackage: task.targetPackage,
			},
			now: runtime?.now ? runtime.now() : new Date(),
		});
		runtimeStore.appendEvent(startEvent);
		if (onBoundary) {
			await onBoundary('task_started_transition_recorded', {
				runId,
				taskId: task.taskId,
			});
		}
	}
}
