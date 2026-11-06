import { execFileSync } from 'node:child_process';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { createEvent } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { resolveTaskWorktreeDir, resolveWorktreeDir } from '../workflow/worktrees.ts';
import {
	type ArtifactStoreLike,
	type GovernorLike,
	MinimalExecutor,
	type MinimalRuntimeStoreLike,
	type RoleRegistryLike,
} from './minimal-executor.ts';
import type { CompletionValidatorFn } from './minimal-verification.ts';
import { composeCompletionValidator } from './task-acceptance-evidence.ts';
import { type TaskScopeAuthorizationLike, taskAuthoredWritePaths } from './task-scope.ts';
import { type GitCliFn, captureTaskDelta, deriveParentTreeSha } from './task-tree-delta.ts';
import {
	type PackageJsonLike,
	type TaskPromptContextLike,
	type VerificationPlanTask,
	resolveTaskVerificationContext,
	resolveTaskVerificationSequence,
	withContractPreservationCommands,
} from './task-verification-plan.ts';
import { type WorktreeRuntimeStoreLike, prepareTaskWorktree } from './task-worktree-preparation.ts';
import type { CommandExecFn } from './tool-commands.ts';
import { type TaskPreparationHooks, taskPreparationHooks } from './verification-preparation.ts';
import {
	type ClosurePlan, assertEligiblePredecessors, eligibleParentTasks, materializeClosureTree,
} from './eligible-closure.ts';
import { DEFAULT_EXECUTOR_STEP_CEILING, calculateTaskStepCapacity, resolveRunMaxPhysicalCalls } from './task-capacity.ts';
import { timedSpan } from '../persistence/run-spans.ts';
export { DEFAULT_EXECUTOR_STEP_CEILING, calculateTaskStepCapacity, resolveRunMaxPhysicalCalls } from './task-capacity.ts';
export type { StepCapacityOptions, DetailedStepCapacity } from './task-capacity.ts';

export interface StoredTaskRecord {
	readonly taskId: string;
	status: string;
	parentTreeSha?: string | null;
	parentCommitSha?: string | null;
	targetTreeSha?: string | null;
	patchHash?: string | null;
	failurePacketArtifact?: unknown;
	repairCount?: number;
}

export interface ExecutableTask extends VerificationPlanTask, StoredTaskRecord {
	readonly targetPackage: string;
	readonly baseCommitSha: string;
	readonly worktreeSubdir?: string | null;
	readonly auditGate?: boolean;
	status: string;
}

export interface ExecutableTaskPlan {
	readonly runId: string;
	readonly baseCommitSha?: string | null;
	readonly integrationOrder: readonly string[];
	readonly tasks: readonly ExecutableTask[];
	readonly [key: string]: unknown;
}

export interface TaskExecutorAuthorization extends TaskScopeAuthorizationLike {
	readonly allowedOperations?: { readonly createDetachedWorktree?: boolean; readonly [key: string]: unknown };
}

export interface TaskExecutorRuntimeStore extends MinimalRuntimeStoreLike, WorktreeRuntimeStoreLike {
	listTasks?: (runId: string) => ReadonlyArray<Readonly<StoredTaskRecord>>;
	countModelOperations?: (runId: string) => number;
}

export interface TaskExecutorSnapshot {
	readonly runtimeRevision?: number;
	readonly taskPlanFrozen?: boolean;
	readonly [key: string]: unknown;
}

export interface ExecuteTaskCommonOptions {
	readonly taskPlan: ExecutableTaskPlan;
	readonly authorization?: TaskExecutorAuthorization | null;
	readonly snapshot?: TaskExecutorSnapshot | null;
	readonly generation?: number;
	readonly specSummary?: string;
	readonly acceptanceCriteria?: readonly string[];
	readonly agentsMd?: string;
	readonly checkpointer?: unknown;
}

export interface ExecuteTaskPlanOptions extends ExecuteTaskCommonOptions {
	readonly taskPromptContexts?: Readonly<Record<string, TaskPromptContextLike | undefined>>;
	readonly quality?: TaskQualityHooks;
}

export interface ExecuteTaskOptions extends ExecuteTaskCommonOptions {
	readonly task: ExecutableTask;
	readonly taskPromptContext?: TaskPromptContextLike | null;
	readonly quality?: TaskQualityHooks;
}

export interface TaskQualityHooks {
	readonly plan: ClosurePlan;
	readonly closureStatus: (sliceId: string) => string | null;
	readonly verifyEnabling: (sliceId: string, plan: ExecutableTaskPlan) => Promise<void>;
	readonly verifyTask: (task: ExecutableTask, worktreeDir: string) => Promise<void>;
	readonly verifyTaskEvidence?: (task: ExecutableTask, worktreeDir: string) => Promise<unknown>;
}

export interface TaskExecutorOptions {
	readonly governor: GovernorLike;
	readonly runtimeStore: TaskExecutorRuntimeStore;
	readonly artifactStore: ArtifactStoreLike;
	readonly roleRegistry: RoleRegistryLike;
	readonly runtime?: { readonly now?: () => Date } | null;
	readonly rootDir?: string;
	readonly execCli?: CommandExecFn;
	readonly gitCli?: GitCliFn;
	readonly onBoundary?: (name: string, payload: { runId: string; taskId: string }) => Promise<void> | void;
	readonly runMaxPhysicalCalls?: number | null;
	readonly configuredMaxSteps?: number;
	readonly runTaskTests?: boolean;
	readonly capabilityId?: string | null;
	readonly programmerTurn?: unknown;
	readonly requireWriteToComplete?: boolean | null;
}

export class TaskExecutor {
	readonly governor: GovernorLike;
	readonly runtimeStore: TaskExecutorRuntimeStore;
	readonly artifactStore: ArtifactStoreLike;
	readonly roleRegistry: RoleRegistryLike;
	readonly runtime: { readonly now?: () => Date } | null;
	readonly rootDir: string;
	readonly execCli: CommandExecFn;
	readonly gitCli: GitCliFn;
	readonly onBoundary: (name: string, payload: { runId: string; taskId: string }) => Promise<void> | void;
	readonly runMaxPhysicalCalls: number;
	readonly configuredMaxSteps: number;
	readonly runTaskTests: boolean;
	readonly capabilityId: string | null;
	readonly programmerTurn: unknown;
	readonly requireWriteToComplete: boolean | null;

	constructor(opts: TaskExecutorOptions) {
		this.governor = opts.governor;
		this.runtimeStore = opts.runtimeStore;
		this.artifactStore = opts.artifactStore;
		this.roleRegistry = opts.roleRegistry;
		this.runtime = opts.runtime ?? null;
		this.rootDir = opts.rootDir ?? REPOSITORY_ROOT;
		this.execCli = opts.execCli ?? (execFileSync as CommandExecFn);
		this.gitCli = opts.gitCli ?? (execFileSync as GitCliFn);
		this.onBoundary = opts.onBoundary ?? (async () => {});
		this.runMaxPhysicalCalls = opts.runMaxPhysicalCalls ?? resolveRunMaxPhysicalCalls({ rootDir: this.rootDir });
		this.configuredMaxSteps =
			opts.configuredMaxSteps ?? (Number(process.env.AGENT_SDLC_MAX_STEPS) || DEFAULT_EXECUTOR_STEP_CEILING);
		this.runTaskTests = opts.runTaskTests ?? true;
		this.capabilityId = opts.capabilityId ?? null;
		this.programmerTurn = opts.programmerTurn ?? null;
		this.requireWriteToComplete = opts.requireWriteToComplete ?? null;
	}

	async executeTasks(options: ExecuteTaskPlanOptions) {
		return this.executeTaskPlan(options);
	}

	async executeTaskPlan(opts: ExecuteTaskPlanOptions): Promise<
		{ status: 'COMPLETED'; tasks: ExecutableTask[] } |
		{ status: 'CHECKPOINT_REQUIRED'; sliceId: string; tasks: ExecutableTask[] }
	> {
		const { taskPlan, authorization, snapshot = null, generation = 0 } = opts;
		const { specSummary = '', acceptanceCriteria = [], taskPromptContexts = {}, agentsMd = '', checkpointer = null } = opts;
		if (snapshot?.taskPlanFrozen !== true) {
			throw new SdlcError('POLICY_VIOLATION', 'createDetachedWorktree requires taskPlanFrozen');
		}
		if (authorization?.allowedOperations && !authorization.allowedOperations.createDetachedWorktree) {
			throw new SdlcError('OPERATION_NOT_PERMITTED', 'createDetachedWorktree operation is required to execute tasks');
		}

		const storedMap = new Map((this.runtimeStore.listTasks?.(taskPlan.runId) ?? []).map((t) => [t.taskId, t]));
		const liveTasks: ExecutableTask[] = taskPlan.tasks.map((task) => {
			const stored = opts.quality && task.status === 'completed' ? undefined : storedMap.get(task.taskId);
			return !stored
				? { ...task }
				: {
						...task,
						status: stored.status,
						parentTreeSha: stored.parentTreeSha ?? task.parentTreeSha,
						parentCommitSha: stored.parentCommitSha ?? task.parentCommitSha,
						targetTreeSha: stored.targetTreeSha ?? task.targetTreeSha,
						patchHash: stored.patchHash ?? task.patchHash,
						failurePacketArtifact: stored.failurePacketArtifact ?? task.failurePacketArtifact,
						repairCount: stored.repairCount ?? task.repairCount,
					};
		});

		const livePlan: ExecutableTaskPlan = { ...taskPlan, tasks: liveTasks };
		const taskMap = new Map(liveTasks.map((t) => [t.taskId, t]));

		for (;;) {
			if (opts.quality) {
				for (const slice of opts.quality.plan.slices) {
					const members = liveTasks.filter(task => task.sliceId === slice.sliceId);
					if (!members.length || !members.every(task => task.status === 'completed')) continue;
					const status = opts.quality.closureStatus(slice.sliceId);
					if (slice.kind === 'enabling') {
						if (status !== 'verified') await opts.quality.verifyEnabling(slice.sliceId, livePlan);
					} else if (status !== 'accepted') {
						return { status: 'CHECKPOINT_REQUIRED', sliceId: slice.sliceId, tasks: liveTasks };
					}
				}
			}
			if (liveTasks.every(t => t.status === 'completed')) break;
			const readyTasks = liveTasks.filter((t) => {
				if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') return false;
				if (opts.quality && t.sliceId) {
					try {
						assertEligiblePredecessors(opts.quality.plan, t.sliceId, opts.quality.closureStatus);
					} catch {
						return false;
					}
				}
				return (t.dependsOn ?? []).every((depId) => taskMap.get(depId)?.status === 'completed');
			});
			if (readyTasks.length === 0) {
				const failed = liveTasks.find((t) => t.status === 'failed');
				if (failed) {
					throw new SdlcError('TASK_EXECUTION_FAILED', `Cannot proceed: task '${failed.taskId}' is failed`, {
						taskId: failed.taskId,
					});
				}
				throw new SdlcError('TASK_EXECUTION_FAILED', 'Deadlock in task execution DAG: no tasks ready', {
					liveTasks: liveTasks.map((t) => t.taskId),
				});
			}
			readyTasks.sort((a, b) => {
				const orderA = taskPlan.integrationOrder.indexOf(a.taskId);
				const orderB = taskPlan.integrationOrder.indexOf(b.taskId);
				return orderA !== -1 && orderB !== -1 && orderA !== orderB ? orderA - orderB : a.taskId.localeCompare(b.taskId);
			});
			const taskToRun = readyTasks[0];
			if (!taskToRun) break;
			await this.executeTask({
				task: taskToRun,
				taskPlan: livePlan,
				authorization,
				snapshot,
				generation,
				specSummary,
				acceptanceCriteria,
				taskPromptContext: taskPromptContexts[taskToRun.taskId] ?? null,
				agentsMd,
				checkpointer,
				quality: opts.quality,
			});
		}
		return { status: 'COMPLETED', tasks: liveTasks };
	}

	async executeTask(opts: ExecuteTaskOptions): Promise<ExecutableTask> {
		const { task, taskPlan, authorization, snapshot = null, specSummary = '' } = opts;
		const { acceptanceCriteria = [], taskPromptContext = null, agentsMd = '' } = opts;
		if (task.status === 'completed') return task;

		const runId = taskPlan.runId;
		const usedCalls = this.runtimeStore.countModelOperations?.(runId) ?? 0;
		if (Math.max(0, this.runMaxPhysicalCalls - usedCalls) <= 0) {
			this.runtimeStore.updateTaskStatus(runId, task.taskId, { status: 'failed' });
			throw new SdlcError(
				'BUDGET_EXHAUSTED',
				`Run model budget exhausted (${usedCalls}/${this.runMaxPhysicalCalls})`,
				{ runId, usedCalls, runMaxPhysicalCalls: this.runMaxPhysicalCalls },
			);
		}
		const worktreeDir =
			task.worktreeSubdir === 'worktree'
				? resolveWorktreeDir(runId, this.rootDir, 'worktree')
				: resolveTaskWorktreeDir(runId, task.taskId, this.rootDir);

		const parentTreeSha = opts.quality
			? materializeClosureTree({
					baseTreeSha: String(this.gitCli('git', ['rev-parse', `${task.baseCommitSha}^{tree}`],
						{ cwd: this.rootDir, encoding: 'utf8' })).trim(),
					tasks: eligibleParentTasks({ ...opts.quality.plan, tasks: taskPlan.tasks }, task.taskId),
					rootDir: this.rootDir, gitCli: this.gitCli,
				})
			: deriveParentTreeSha({ task, taskPlan, rootDir: this.rootDir, gitCli: this.gitCli, snapshot });
		const previousParentTreeSha = task.parentTreeSha;
		task.parentTreeSha = parentTreeSha;

		calculateTaskStepCapacity((task.pathPrefixes ?? []).length, {
			defaultCeiling: this.configuredMaxSteps ?? DEFAULT_EXECUTOR_STEP_CEILING,
		});

		await timedSpan(this.runtimeStore, 'prepare', `worktree ${task.taskId}`, () => prepareTaskWorktree({
			task,
			taskPlan,
			authorization,
			snapshot,
			runId,
			worktreeDir,
			parentTreeSha,
			previousParentTreeSha,
			useDerivedParent: Boolean(opts.quality),
			rootDir: this.rootDir,
			gitCli: this.gitCli,
			execCli: this.execCli,
			runtimeStore: this.runtimeStore,
			runtime: this.runtime,
			onBoundary: this.onBoundary,
		}));

		const v = resolveTaskVerificationContext({
			task,
			taskPlan,
			worktreeDir,
			taskPromptContext,
			acceptanceCriteria,
			specSummary,
			gitCli: this.gitCli,
		});
		const completed = await this.executeMinimalTask({
			...v,
			preparation: taskPreparationHooks({ runId, task, taskPlan, authorization, snapshot, worktreeDir, execCli: this.execCli, artifactStore: this.artifactStore, runtimeStore: this.runtimeStore, now: this.runtime?.now }),
			runId,
			task,
			worktreeDir,
			acceptanceCriteria,
			agentsMd,
			parentTreeSha,
			snapshot,
			qualityVerifyTask: opts.quality?.verifyTask,
			qualityVerifyEvidence: opts.quality?.verifyTaskEvidence,
		});
		return completed;
	}

	async executeMinimalTask(p: {
		runId: string;
		task: ExecutableTask;
		worktreeDir: string;
		packageJson: PackageJsonLike;
		allowedCommandPackages: readonly string[];
		acceptanceEvidenceCommand: readonly string[] | null;
		authoredTestPaths?: readonly string[];
		scopedSpecSummary: string;
		acceptanceCriteria: readonly string[];
		effectiveTaskPromptContext: TaskPromptContextLike;
		agentsMd: string;
		parentTreeSha: string;
		snapshot: TaskExecutorSnapshot | null;
		completionValidator: CompletionValidatorFn | null;
		preparation?: TaskPreparationHooks;
		qualityVerifyTask?: TaskQualityHooks['verifyTask'];
		qualityVerifyEvidence?: TaskQualityHooks['verifyTaskEvidence'];
	}): Promise<ExecutableTask> {
		const { runId, task, worktreeDir, packageJson, effectiveTaskPromptContext } = p;
		const authoredTestPaths = p.authoredTestPaths ?? [];
		const authoredPaths = taskAuthoredWritePaths(task);
		const minimal = new MinimalExecutor({
			governor: this.governor,
			runtimeStore: this.runtimeStore,
			artifactStore: this.artifactStore,
			roleRegistry: this.roleRegistry,
			execCli: this.execCli,
			completionValidator: composeCompletionValidator({
				worktreeDir,
				task,
				gitCli: this.gitCli,
				completionValidator: p.completionValidator,
				authoredPaths,
			}),
		});
		const auditGate = task.auditGate ?? Boolean(task.sliceId || authoredTestPaths.length > 0);
		const qualityVerifyEvidence = p.qualityVerifyEvidence;
		let minimalResult;
		try {
			minimalResult = await minimal.execute({
				runId,
				taskId: task.taskId,
				worktreeDir,
				verificationCommands: withContractPreservationCommands(
					resolveTaskVerificationSequence(task, packageJson),
					effectiveTaskPromptContext,
				),
				targetedVerificationCommand: effectiveTaskPromptContext?.targetedVerificationCommand ?? null,
				generatorCommand: effectiveTaskPromptContext?.generatorCommand ?? null,
				acceptanceEvidenceCommand: p.acceptanceEvidenceCommand,
				verifyCheckpointEvidence: qualityVerifyEvidence ? async () => {
					const candidate = captureTaskDelta({ task, worktreeDir, rootDir: this.rootDir, gitCli: this.gitCli, rawPatchHash: true });
					await qualityVerifyEvidence({ ...task, targetTreeSha: candidate.targetTreeSha, patchHash: candidate.patchHash }, worktreeDir);
				} : undefined,
				...p.preparation,
				authoredPaths: Array.isArray(task.authoredPaths) ? task.authoredPaths : [],
				authoredTestPaths,
				allowedWritePathPrefixes: authoredPaths,
				allowedPackages: p.allowedCommandPackages,
				specSummary: p.scopedSpecSummary,
				acceptanceCriteria: effectiveTaskPromptContext.acceptanceCriteria ?? p.acceptanceCriteria,
				agentsMd: p.agentsMd,
				auditGate,
			});
		} catch (error) {
			this.runtimeStore.updateTaskStatus(runId, task.taskId, { status: 'failed' });
			throw error;
		}
		if (minimalResult.status !== 'completed') {
			this.runtimeStore.updateTaskStatus(runId, task.taskId, { status: 'failed' });
			throw new SdlcError(
				'TASK_EXECUTION_FAILED',
				`Implementer failed for task ${task.taskId}: ${String(minimalResult.failureReason)}${minimalResult.lastSummary ? ` (implementer's last message: ${minimalResult.lastSummary})` : ''}`,
				{ taskId: task.taskId, failureReason: minimalResult.failureReason, lastSummary: minimalResult.lastSummary ?? null },
			);
		}
		try {
			if (p.qualityVerifyTask) {
				const candidate = captureTaskDelta({ task, worktreeDir, rootDir: this.rootDir, gitCli: this.gitCli, rawPatchHash: true });
				await p.qualityVerifyTask({ ...task, targetTreeSha: candidate.targetTreeSha, patchHash: candidate.patchHash }, worktreeDir);
			}
			return await this.finishTaskExecution({
				runId,
				task,
				worktreeDir,
				parentTreeSha: p.parentTreeSha,
				snapshot: p.snapshot,
				acceptEmptyDelta: true,
				rawPatchHash: Boolean(p.qualityVerifyTask),
			});
		} catch (error) {
			if (error && typeof error === 'object' && 'code' in error && error.code === 'PATH_CONTAINMENT_VIOLATION') {
				this.runtimeStore.updateTaskStatus(runId, task.taskId, { status: 'failed' });
			}
			throw error;
		}
	}

	async finishTaskExecution(p: {
		runId: string;
		task: ExecutableTask;
		worktreeDir: string;
		parentTreeSha: string;
		snapshot: TaskExecutorSnapshot | null;
		acceptEmptyDelta: boolean;
		rawPatchHash?: boolean;
	}): Promise<ExecutableTask> {
		const { runId, task, worktreeDir, parentTreeSha, snapshot, acceptEmptyDelta } = p;
		const delta = captureTaskDelta({ task, worktreeDir, rootDir: this.rootDir, gitCli: this.gitCli, rawPatchHash: p.rawPatchHash });
		if (!acceptEmptyDelta && delta.targetTreeSha === parentTreeSha) {
			this.runtimeStore.updateTaskStatus(runId, task.taskId, { status: 'failed' });
			throw new SdlcError('TASK_EXECUTION_FAILED', `Implementer produced no file changes for task ${task.taskId}`, {
				taskId: task.taskId,
			});
		}
		task.targetTreeSha = delta.targetTreeSha;
		task.patchHash = delta.patchHash;
		task.status = 'completed';
		this.runtimeStore.updateTaskStatus(runId, task.taskId, {
			status: 'completed',
			parentTreeSha,
			targetTreeSha: delta.targetTreeSha,
			patchHash: delta.patchHash,
		});
		const hasCompleted = this.runtimeStore
			.listEvents(runId)
			.some((e) => e.eventType === 'TASK_COMPLETED' && e.payload?.taskId === task.taskId);
		if (!hasCompleted) {
			this.runtimeStore.appendEvent(
				createEvent({
					eventType: 'TASK_COMPLETED',
					runId,
					runtimeRevision: snapshot?.runtimeRevision ?? 0,
					causalId: `complete-task-${task.taskId}`,
					payload: { taskId: task.taskId, targetTreeSha: delta.targetTreeSha, patchHash: delta.patchHash },
					now: this.runtime?.now ? this.runtime.now() : new Date(),
				}),
			);
			if (this.onBoundary) {
				await this.onBoundary('task_completed_transition_recorded', { runId, taskId: task.taskId });
			}
		}
		return task;
	}
}
