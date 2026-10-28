// Pure status.json document. Git and store reads stay with the caller.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { HostVerifyConfig } from '../host/verify-config.ts';
import {
	type ContinuationRecord,
	type HostInvocationRecord,
	type RuntimeState,
	type TaskPlan,
	sha256,
} from '../policy/contracts.ts';
import type { GitCliFn } from '../workflow/git-manager.ts';
import type { CandidateLearningItem } from './projection-artifacts.ts';

function gitText(
	gitCli: GitCliFn,
	args: readonly string[],
	options: Record<string, unknown>,
): string {
	const result = gitCli('git', args, options);
	return typeof result === 'string' ? result : result.toString('utf8');
}

export interface ProjectedTaskItem {
	id: string;
	title: string;
	status: 'completed' | 'in_progress' | 'blocked' | 'cancelled' | 'pending';
	package: string;
	sliceId: string | null;
	complexityScore: number | null;
	exceededLimits: readonly unknown[];
	changeClass: string | null;
	highRisk: boolean;
	maxAutonomousRepairs: number;
	humanReviewEvidence: string;
	worktreeSubdir: string | null;
	targetTreeSha: string | null;
	failureMetadata?: Record<string, unknown>;
}

export function projectTasks(
	taskPlan: Readonly<TaskPlan> | null | undefined,
	state: Readonly<RuntimeState>,
): ProjectedTaskItem[] {
	return taskPlan
		? taskPlan.tasks.map((task) => {
				const taskRec = task as { failureMetadata?: Record<string, unknown> };
				const lastErrMeta = state.lastError?.metadata;
				const failureMetadata =
					taskRec.failureMetadata ??
					(lastErrMeta?.taskId === task.taskId
						? lastErrMeta
						: (task.status === 'blocked' || task.status === 'failed') && lastErrMeta
							? lastErrMeta
							: null);
				return {
					id: task.taskId,
					title: task.title || `Task ${task.taskId}`,
					status: mapToSchemaV1TaskStatus(task.status),
					package: task.targetPackage,
					sliceId: task.sliceId ?? null,
					complexityScore: task.complexityScore ?? null,
					exceededLimits: task.exceededLimits ?? [],
					changeClass: task.changeClass ?? null,
					highRisk: task.highRisk === true,
					maxAutonomousRepairs: task.maxAutonomousRepairs ?? 2,
					humanReviewEvidence:
						task.humanReviewEvidence ??
						(task.highRisk ? 'required_pending' : 'not_required'),
					worktreeSubdir: task.worktreeSubdir || null,
					targetTreeSha: task.targetTreeSha || null,
					...(failureMetadata ? { failureMetadata } : {}),
				};
			})
		: [];
}

export function projectTaskProgress(
	taskPlan: Readonly<TaskPlan> | null | undefined,
	tasks: readonly ProjectedTaskItem[],
	state: Readonly<RuntimeState>,
) {
	const completedIds = new Set(
		taskPlan?.tasks
			.filter((task) => task.status === 'completed')
			.map((task) => task.taskId) ?? [],
	);
	const nextReadyTask =
		taskPlan?.tasks.find(
			(task) =>
				task.status !== 'completed' &&
				task.status !== 'cancelled' &&
				task.dependsOn.every((dependency) => completedIds.has(dependency)),
		) ?? null;
	return {
		slices: (taskPlan?.slices ?? []).map((slice) => ({
			...slice,
			taskIds: taskPlan
				? taskPlan.tasks
						.filter((task) => task.sliceId === slice.sliceId)
						.map((task) => task.taskId)
				: [],
		})),
		completedCheckpoints: tasks
			.filter((task) => task.status === 'completed' && task.targetTreeSha)
			.map((task) => ({
				taskId: task.id,
				sliceId: task.sliceId,
				targetTreeSha: task.targetTreeSha,
			})),
		nextReadyTask: nextReadyTask?.taskId ?? null,
		featureNonExposed: state.state !== 'DONE',
	};
}

export function mapToSchemaV1TaskStatus(
	status: unknown,
): 'completed' | 'in_progress' | 'blocked' | 'cancelled' | 'pending' {
	switch (status) {
		case 'completed':
		case 'done':
			return 'completed';
		case 'in_progress':
		case 'running':
			return 'in_progress';
		case 'blocked':
		case 'failed':
			return 'blocked';
		case 'cancelled':
			return 'cancelled';
		case 'pending':
		default:
			return 'pending';
	}
}

function projectedPhase(
	state: string,
): 'blocked' | 'escalated' | 'done' | 'implement' | 'review' | 'verify' | 'repair' | 'spec' {
	if (['BLOCKED', 'BUDGET_EXHAUSTED', 'FAILED', 'CANCELLED'].includes(state)) return 'blocked';
	if (state === 'ESCALATED') return 'escalated';
	if (state === 'DONE') return 'done';
	if (
		[
			'PLANNING_TASKS',
			'EVALUATING_POLICY',
			'PREPARING_WORKSPACE',
			'HYDRATING_WORKSPACE',
			'EXECUTING_IMPLEMENTATION',
		].includes(state)
	) {
		return 'implement';
	}
	if (
		[
			'RECONCILING_INTEGRATION',
			'SNAPSHOT_GENERATION',
			'REVIEWING_GENERATION',
			'READY_FOR_GIT_APPROVAL',
		].includes(state)
	) {
		return 'review';
	}
	if (
		[
			'VERIFYING_PREFLIGHT',
			'REVIEWING_QA',
			'COMMITTING_CHANGES',
			'VERIFYING_COMMITTED_TREE',
		].includes(state)
	) {
		return 'verify';
	}
	if (state === 'REPAIRING_FAILURE') {
		return 'repair';
	}
	return 'spec';
}

function projectedOwner(
	state: string,
	hasPendingInterrupt = false,
): 'human' | 'orchestrator:idle' | 'orchestrator:agent-sdlc' {
	if (
		hasPendingInterrupt ||
		[
			'WAITING_FOR_ANSWERS',
			'WAITING_FOR_APPROVAL',
			'WAITING_FOR_AUTHORIZATION',
			'READY_FOR_GIT_APPROVAL',
			'ESCALATED',
		].includes(state)
	) {
		return 'human';
	}
	if (['SPEC_APPROVED', 'SPEC_REJECTED', 'CANCELLED', 'DONE'].includes(state)) {
		return 'orchestrator:idle';
	}
	return 'orchestrator:agent-sdlc';
}

function projectedBlockedReason(state: Readonly<RuntimeState>): string | null {
	if (state.state === 'CANCELLED') return 'RUN_CANCELLED';
	return ['BLOCKED', 'BUDGET_EXHAUSTED', 'FAILED'].includes(state.state)
		? (state.blockedReason ?? state.lastError?.code ?? 'RUN_FAILED')
		: null;
}

export interface GitMetadataRecord {
	branch: string;
	headSha: string;
	worktreePath: string | null;
	dirty: boolean;
}

export function gitMetadata(
	rootDir: string,
	worktreePath: string | null = null,
	gitCli: GitCliFn = execFileSync as GitCliFn,
): GitMetadataRecord {
	const targetDir = worktreePath && fs.existsSync(worktreePath) ? worktreePath : rootDir;
	const isWorktree = targetDir !== rootDir;
	try {
		const headSha = gitText(gitCli, ['rev-parse', 'HEAD'], {
			cwd: targetDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		}).trim();
		const branch = gitText(gitCli, ['branch', '--show-current'], {
			cwd: targetDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		}).trim();
		const dirty =
			gitText(gitCli, ['status', '--porcelain'], {
				cwd: targetDir,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			}).trim().length > 0;
		return {
			branch: branch || 'detached',
			headSha,
			worktreePath: isWorktree ? worktreePath : null,
			dirty,
		};
	} catch {
		return {
			branch: 'unknown',
			headSha: 'unknown',
			worktreePath: isWorktree ? worktreePath : null,
			dirty: true,
		};
	}
}

export function projectionHash(status: {
	orchestration: { projectionHash: string | null } & Record<string, unknown>;
} & Record<string, unknown>): string {
	const copy = structuredClone(status);
	copy.orchestration.projectionHash = null;
	return sha256(copy);
}

export function buildStatusDocument({
	state,
	reservation,
	auth,
	taskPlan,
	continuation,
	hostInvocation,
	falseEconomyDiagnostics = [],
	candidateLearnings = [],
	rootDir,
	runDir,
	eventLogHash = null,
	gitCommitSha = null,
	verify,
}: {
	state: Readonly<RuntimeState>;
	reservation: {
		projectionRevision: number;
		updatedAt: string;
		git: GitMetadataRecord;
	};
	auth: { allowedPackages?: readonly string[]; baseCommitSha?: string } | null | undefined;
	taskPlan: Readonly<TaskPlan> | null | undefined;
	continuation: Readonly<ContinuationRecord>;
	hostInvocation: Readonly<HostInvocationRecord>;
	falseEconomyDiagnostics?: readonly unknown[];
	candidateLearnings?: readonly CandidateLearningItem[];
	rootDir: string;
	runDir: string;
	eventLogHash?: string | null;
	gitCommitSha?: string | null;
	verify?: Readonly<HostVerifyConfig> | null;
}) {
	const tasks = projectTasks(taskPlan, state);
	const taskProgress = projectTaskProgress(taskPlan, tasks, state);
	const baseSha = auth?.baseCommitSha ?? 'HEAD';
	const verifiedCommand = verify
		? verify.argv.map((token) => token.replaceAll('{baseSha}', baseSha)).join(' ')
		: `pnpm run agent:preflight -- --base ${baseSha}`;
	const verifiedResultFile = verify
		? (verify.resultPath ?? null)
		: 'tools/.agent-preflight-last.json';
	const baseStatus: {
		schemaVersion: number;
		runId: string;
		revision: number;
		updatedAt: string;
		git: GitMetadataRecord;
		lane: string;
		phase: string;
		activeOwner: string;
		risk: string;
		blockedReason: string | null;
		continuation: Readonly<ContinuationRecord>;
		hostInvocation: Readonly<HostInvocationRecord>;
		retry: { count: number; maxRetries: number; source: string };
		packages: readonly string[];
		changeClass: string;
		skillsUsed: string[];
		verification: Record<string, unknown>;
		tasks: ProjectedTaskItem[];
		taskProgress: ReturnType<typeof projectTaskProgress>;
		orchestration: {
			mode: string;
			schemaVersion: string;
			runtimeRevision: number;
			state: string;
			eventLogHash: string | null;
			draftHash: string | null;
			pendingInterruptId: string | null;
			projectionHash: string | null;
		};
		diagnostics?: { falseEconomy: readonly unknown[] };
		candidateLearnings?: readonly CandidateLearningItem[];
		proposedLearnings?: Array<Record<string, unknown>>;
	} = {
		schemaVersion: 1,
		runId: state.runId,
		revision: reservation.projectionRevision,
		updatedAt: reservation.updatedAt,
		git: reservation.git,
		lane: 'agent',
		phase: projectedPhase(state.state),
		activeOwner: projectedOwner(state.state, Boolean(state.pendingInterruptId)),
		risk: taskPlan?.tasks.some((task) => task.highRisk) ? 'high' : 'normal',
		blockedReason: projectedBlockedReason(state),
		continuation,
		hostInvocation,
		retry: {
			count: state.semanticRepairsCount ?? 0,
			maxRetries: 2,
			source: 'runtime.sqlite',
		},
		packages: auth?.allowedPackages ?? [],
		changeClass:
			taskPlan && taskPlan.tasks.length > 0
				? (() => {
						const classes = new Set(
							taskPlan.tasks
								.map((task) => task.changeClass)
								.filter((c): c is NonNullable<typeof c> => Boolean(c)),
						);
						return classes.size > 1 ? 'E' : ([...classes][0] ?? 'B');
					})()
				: 'B',
		skillsUsed: auth
			? ['specification-workflow', 'implementation-workflow']
			: ['specification-workflow'],
		verification:
			state.state === 'READY_FOR_GIT_APPROVAL' || state.state === 'DONE'
				? {
						lastCommand: verifiedCommand,
						lastResult: 'pass',
						lastExitCode: 0,
						lastRanAt: state.updatedAt,
						preflight: {
							status: 'OK',
							changeClass: 'B',
							gitHeadSha:
								state.state === 'DONE'
									? reservation.git.headSha &&
										reservation.git.headSha.length === 40
										? reservation.git.headSha
										: (gitCommitSha ?? auth?.baseCommitSha ?? null)
									: (auth?.baseCommitSha ?? null),
							resultFile: verifiedResultFile,
							finishedAt: state.updatedAt,
						},
					}
				: {
						lastCommand: null,
						lastResult: 'not_run',
						lastExitCode: null,
						lastRanAt: null,
						preflight: {
							status: null,
							changeClass: null,
							gitHeadSha: null,
							resultFile: verifiedResultFile,
							finishedAt: null,
						},
					},
		tasks,
		taskProgress,
		orchestration: {
			mode: 'langgraph',
			schemaVersion: '1.0.0',
			runtimeRevision: state.runtimeRevision,
			state: state.state,
			eventLogHash: null,
			draftHash: state.draftHash,
			pendingInterruptId: state.pendingInterruptId,
			projectionHash: null,
		},
	};
	if (falseEconomyDiagnostics.length > 0) {
		baseStatus.diagnostics = {
			falseEconomy: falseEconomyDiagnostics,
		};
	}
	if (candidateLearnings.length > 0) {
		baseStatus.candidateLearnings = candidateLearnings;
		const batchPath = path.relative(
			rootDir,
			path.join(runDir, 'candidate-learnings.json'),
		);
		baseStatus.proposedLearnings = [
			{
				key: 'candidate-learnings-batch',
				command: `pnpm run agent:learn -- add --file ${batchPath}`,
				count: candidateLearnings.length,
			},
			...candidateLearnings.map((candidate) => ({
				key: candidate.key,
				command: `pnpm run agent:learn -- add '${JSON.stringify({
					type: candidate.type,
					key: candidate.key,
					scope: candidate.scope,
					query: candidate.query,
					insight: candidate.insight,
					confidence: candidate.confidence,
					source: candidate.source,
				}).replaceAll("'", "'\"'\"'")}'`,
			})),
		];
	}
	baseStatus.orchestration.eventLogHash = eventLogHash;
	baseStatus.orchestration.projectionHash = projectionHash(baseStatus);
	return baseStatus;
}
