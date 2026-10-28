import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RepositoryModelGovernor } from '../adapters/model-governor.ts';
import { ArtifactStore, assertAuthoritativeInputSafe } from '../persistence/artifacts.ts';
import {
	REPOSITORY_ROOT,
	type RunPaths,
	archiveRoot,
	archivedRunRelativePath,
	resolveRunPaths,
} from '../persistence/run-paths.ts';
import { RuntimeStore } from '../persistence/runtime-store.ts';
import { type TaskManifest, validateRunId } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { RoleRegistry } from '../roles/role-registry.ts';
import type { GitCliFn } from '../workflow/git-manager.ts';
import {
	type ExecCliFn,
	SdlcWorkflowRuntime,
	type SdlcWorkflowRuntimeOptions,
} from '../workflow/graph.ts';
import type { WorkflowModelGovernor } from '../workflow/node-helpers.ts';
import { parseTaskManifest } from '../workflow/specification.ts';
import type { ParsedArguments } from './arguments.ts';
import { StatusProjection } from './status-projection.ts';

export interface OpenContextOptions {
	readonly rootDir?: string;
	readonly runId: string;
	readonly governor?: WorkflowModelGovernor | null;
	readonly registry?: RoleRegistry | null;
	readonly onBoundary?: SdlcWorkflowRuntimeOptions['onBoundary'];
	readonly gitCli?: GitCliFn;
	readonly execCli?: ExecCliFn;
	readonly ghCli?: ExecCliFn | null;
	readonly localPolicyPath?: string | null;
}

export interface RunContext {
	readonly rootDir: string | undefined;
	readonly paths: RunPaths;
	readonly store: RuntimeStore;
	readonly registry: RoleRegistry;
	readonly artifacts: ArtifactStore;
	readonly runtime: SdlcWorkflowRuntime;
	readonly projection: StatusProjection;
	readonly gitCli: GitCliFn;
}

export function openContext({
	rootDir,
	runId,
	governor,
	registry,
	onBoundary,
	gitCli,
	execCli,
	ghCli,
	localPolicyPath = null,
}: OpenContextOptions): RunContext {
	const effectiveRoot = rootDir ?? REPOSITORY_ROOT;
	validateRunId(runId);
	if (fs.existsSync(path.join(archiveRoot(effectiveRoot), runId))) {
		const archiveRelPath = archivedRunRelativePath(runId);
		throw new SdlcError(
			'INVALID_INPUT',
			`Run '${runId}' is archived at ${archiveRelPath} and cannot be resumed or inspected as a live run`,
			{ runId, archivePath: archiveRelPath },
		);
	}
	const paths = resolveRunPaths(runId, effectiveRoot);
	const store = new RuntimeStore(paths.databasePath);
	try {
		const resolvedRegistry = registry ?? new RoleRegistry({ rootDir: effectiveRoot });
		const loaded = resolvedRegistry.load();
		const artifacts = new ArtifactStore({
			artifactsDir: paths.artifactsDir,
			runtimeStore: store,
			maxArtifactBytes: loaded.workflow.limits.maxArtifactBytes,
		});
		const resolvedGovernor =
			governor ?? new RepositoryModelGovernor({ rootDir: effectiveRoot, localPolicyPath });
		const runtime = new SdlcWorkflowRuntime({
			runtimeStore: store,
			artifactStore: artifacts,
			registry: resolvedRegistry,
			governor: resolvedGovernor,
			onBoundary,
			gitCli,
			execCli,
			ghCli,
		});
		const projection = new StatusProjection({
			rootDir: effectiveRoot,
			paths,
			runtimeStore: store,
			artifactStore: artifacts,
			checkpointer: runtime.checkpointer,
			onBoundary,
			gitCli,
			localPolicyPath,
		});
		return {
			rootDir,
			paths,
			store,
			registry: resolvedRegistry,
			artifacts,
			runtime,
			projection,
			gitCli: gitCli ?? (execFileSync as GitCliFn),
		};
	} catch (error: unknown) {
		store.close();
		throw error;
	}
}

export function resolveTaskManifest(
	parsed: ParsedArguments,
	{ rootDir, maxBytes }: { rootDir: string; maxBytes: number },
): Readonly<TaskManifest> | null {
	if (!parsed.values.has('--task-plan-file')) return null;
	const filename = path.resolve(rootDir, parsed.values.get('--task-plan-file') ?? '');
	const manifest = parseTaskManifest(readBoundedFile(filename, maxBytes));
	assertDerivedTaskTitlesFit(manifest);
	assertNoConcurrentSamePackageTasks(manifest);
	return manifest;
}

// The policy gate rejects same-package tasks with no dependency path between them; surface that at check-spec time.
function assertNoConcurrentSamePackageTasks(manifest: Readonly<TaskManifest>): void {
	const tasks = manifest?.tasks ?? [];
	const byId = new Map(tasks.map((task) => [task.taskId, task]));
	const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
		if (seen.has(from)) return false;
		seen.add(from);
		return (byId.get(from)?.dependsOn ?? []).some(
			(dependency) => dependency === target || reaches(dependency, target, seen),
		);
	};
	for (let i = 0; i < tasks.length; i++) {
		for (let j = i + 1; j < tasks.length; j++) {
			const a = tasks[i];
			const b = tasks[j];
			if (!a || !b) continue;
			if (a.targetPackage !== b.targetPackage) continue;
			if (reaches(a.taskId, b.taskId) || reaches(b.taskId, a.taskId)) continue;
			throw new SdlcError(
				'TASK_PLAN_INVALID',
				`Concurrent tasks '${a.taskId}' and '${b.taskId}' target package '${a.targetPackage}'; add a dependsOn path between them`,
			);
		}
	}
}

const MAX_DERIVED_TASK_TITLE_LENGTH = 256;

// The planner titles each task "<slice goal> - <taskId>"; reject overlong titles before a run starts.
function assertDerivedTaskTitlesFit(manifest: Readonly<TaskManifest>): void {
	const goals = new Map((manifest?.slices ?? []).map((slice) => [slice.sliceId, slice.goal]));
	for (const task of manifest?.tasks ?? []) {
		const length = `${goals.get(task.sliceId) ?? ''} - ${task.taskId}`.length;
		if (length > MAX_DERIVED_TASK_TITLE_LENGTH) {
			throw new SdlcError(
				'TASK_PLAN_INVALID',
				`Task '${task.taskId}' derived title is ${length} characters (max ${MAX_DERIVED_TASK_TITLE_LENGTH}); shorten slice '${task.sliceId}' goal`,
			);
		}
	}
}

export function resolveGoalText(
	parsed: ParsedArguments,
	{
		rootDir,
		maxGoalBytes,
		command,
	}: { rootDir: string; maxGoalBytes: number; command: string },
): string {
	const hasGoal = parsed.values.has('--goal');
	const hasGoalFile = parsed.values.has('--goal-file');
	if (hasGoal === hasGoalFile) {
		throw new SdlcError(
			'INVALID_INPUT',
			`${command} requires exactly one of --goal or --goal-file`,
		);
	}
	const goal = hasGoal
		? parsed.values.get('--goal')
		: readBoundedFile(
				path.resolve(rootDir, parsed.values.get('--goal-file') ?? ''),
				maxGoalBytes,
			);
	if (!goal || goal.trim().length === 0) {
		throw new SdlcError('INVALID_INPUT', 'Goal cannot be empty');
	}
	if (Buffer.byteLength(goal, 'utf8') > maxGoalBytes) {
		throw new SdlcError('INVALID_INPUT', 'Goal exceeds configured size limit');
	}
	assertAuthoritativeInputSafe(goal, 'Goal');
	return goal;
}

export function readBoundedFile(filename: string, maxBytes: number): string {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filename);
	} catch (error: unknown) {
		throw new SdlcError('INVALID_INPUT', `Cannot read file: ${filename}`, {}, { cause: error });
	}
	if (!stat.isFile() || stat.size > maxBytes) {
		throw new SdlcError('INVALID_INPUT', `File is not regular or exceeds ${maxBytes} bytes`);
	}
	return fs.readFileSync(filename, 'utf8');
}

export async function readStdin(
	stream: AsyncIterable<string | Buffer>,
	maxBytes: number,
): Promise<string> {
	let content = '';
	for await (const chunk of stream) {
		content += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
		if (Buffer.byteLength(content, 'utf8') > maxBytes) {
			throw new SdlcError('INVALID_INPUT', `stdin exceeds ${maxBytes} bytes`);
		}
	}
	if (content.length === 0) throw new SdlcError('INVALID_INPUT', 'stdin answer is empty');
	return content;
}
