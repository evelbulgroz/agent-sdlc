import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadPolicy } from '@fitness-app/model-usage/policy';
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

export const DEFAULT_EXECUTOR_STEP_CEILING = 80;
const ABSOLUTE_EXECUTOR_STEP_CEILING = 100;
const STEPS_PER_FILE = 2;
const VERIFICATION_ALLOWANCE = 4;

export interface StepCapacityOptions {
	readonly stepsPerFile?: number;
	readonly verificationAllowance?: number;
	readonly defaultCeiling?: number;
	readonly absoluteCeiling?: number;
	readonly detailed?: boolean;
}

export interface DetailedStepCapacity {
	readonly requiredSteps: number;
	readonly stepCeiling: number;
	readonly allowedSteps: number;
}

export function calculateTaskStepCapacity(
	pathsOrCount: readonly unknown[] | number,
	options: StepCapacityOptions & { readonly detailed: true },
): DetailedStepCapacity;
export function calculateTaskStepCapacity(
	pathsOrCount: readonly unknown[] | number,
	options?: StepCapacityOptions & { readonly detailed?: false },
): number;
export function calculateTaskStepCapacity(
	pathsOrCount: readonly unknown[] | number,
	options: StepCapacityOptions = {},
): number | DetailedStepCapacity {
	const {
		stepsPerFile = STEPS_PER_FILE,
		verificationAllowance = VERIFICATION_ALLOWANCE,
		defaultCeiling = DEFAULT_EXECUTOR_STEP_CEILING,
		absoluteCeiling = ABSOLUTE_EXECUTOR_STEP_CEILING,
		detailed = false,
	} = options;
	const pathCount = Array.isArray(pathsOrCount)
		? pathsOrCount.length
		: typeof pathsOrCount === 'number' && Number.isFinite(pathsOrCount)
			? Math.max(0, Math.floor(pathsOrCount))
			: 0;
	const requiredSteps = pathCount * stepsPerFile + verificationAllowance;
	if (requiredSteps > absoluteCeiling) {
		throw new SdlcError(
			'CAPACITY_LIMIT_EXCEEDED',
			`Task requires at least ${requiredSteps} steps, which exceeds the absolute step ceiling of ${absoluteCeiling}`,
			{ requiredSteps, allowedSteps: absoluteCeiling, pathCount },
		);
	}
	const stepCeiling = Math.min(absoluteCeiling, Math.max(requiredSteps, defaultCeiling));
	return detailed ? { requiredSteps, stepCeiling, allowedSteps: absoluteCeiling } : stepCeiling;
}

export function resolveRunMaxPhysicalCalls({
	rootDir = REPOSITORY_ROOT,
	modelProfile = 'agent-sdlc-default',
	readFile = (filePath: string) => fs.readFileSync(filePath, 'utf8'),
}: { rootDir?: string; modelProfile?: string; readFile?: (filePath: string) => string } = {}): number {
	if (process.env.AGENT_SDLC_RUN_MAX_PHYSICAL_CALLS) {
		const envLimit = Number.parseInt(process.env.AGENT_SDLC_RUN_MAX_PHYSICAL_CALLS, 10);
		if (Number.isSafeInteger(envLimit) && envLimit > 0) return envLimit;
	}
	try {
		const hostPath = path.join(rootDir ?? REPOSITORY_ROOT, '.agents/model-usage-policy.json');
		const policyPath = fs.existsSync(hostPath) ? hostPath : loadPolicy.DEFAULT_BUNDLED_POLICY_PATH;
		const policy = JSON.parse(readFile(policyPath)) as {
			profiles?: Readonly<Record<string, { limits?: { runMaxPhysicalCalls?: unknown } } | undefined>>;
		};
		const limit = policy.profiles?.[modelProfile]?.limits?.runMaxPhysicalCalls;
		if (typeof limit === 'number' && limit > 0) return limit;
	} catch {
		// fallback to conservative default
	}
	return 250;
}

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
}

export interface ExecuteTaskOptions extends ExecuteTaskCommonOptions {
	readonly task: ExecutableTask;
	readonly taskPromptContext?: TaskPromptContextLike | null;
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

	async executeTaskPlan(opts: ExecuteTaskPlanOptions): Promise<{ status: 'COMPLETED'; tasks: ExecutableTask[] }> {
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
			const stored = storedMap.get(task.taskId);
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

		while (!liveTasks.every((t) => t.status === 'completed')) {
			const readyTasks = liveTasks.filter((t) => {
				if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') return false;
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

		const parentTreeSha = deriveParentTreeSha({ task, taskPlan, rootDir: this.rootDir, gitCli: this.gitCli, snapshot });
		const previousParentTreeSha = task.parentTreeSha;
		task.parentTreeSha = parentTreeSha;

		calculateTaskStepCapacity((task.pathPrefixes ?? []).length, {
			defaultCeiling: this.configuredMaxSteps ?? DEFAULT_EXECUTOR_STEP_CEILING,
		});

		await prepareTaskWorktree({
			task,
			taskPlan,
			authorization,
			snapshot,
			runId,
			worktreeDir,
			parentTreeSha,
			previousParentTreeSha,
			rootDir: this.rootDir,
			gitCli: this.gitCli,
			execCli: this.execCli,
			runtimeStore: this.runtimeStore,
			runtime: this.runtime,
			onBoundary: this.onBoundary,
		});

		const v = resolveTaskVerificationContext({
			task,
			taskPlan,
			worktreeDir,
			taskPromptContext,
			acceptanceCriteria,
			specSummary,
			gitCli: this.gitCli,
		});
		return await this.executeMinimalTask({
			...v,
			runId,
			task,
			worktreeDir,
			acceptanceCriteria,
			agentsMd,
			parentTreeSha,
			snapshot,
		});
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
				`Implementer failed for task ${task.taskId}: ${String(minimalResult.failureReason)}`,
				{ taskId: task.taskId, failureReason: minimalResult.failureReason },
			);
		}
		try {
			return await this.finishTaskExecution({
				runId,
				task,
				worktreeDir,
				parentTreeSha: p.parentTreeSha,
				snapshot: p.snapshot,
				acceptEmptyDelta: true,
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
	}): Promise<ExecutableTask> {
		const { runId, task, worktreeDir, parentTreeSha, snapshot, acceptEmptyDelta } = p;
		const delta = captureTaskDelta({ task, worktreeDir, rootDir: this.rootDir, gitCli: this.gitCli });
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
