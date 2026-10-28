// Task planner facade. planTaskDag keeps one helper per branch and the original hash shape.

import path from 'node:path';
import { loadHostProfileOrFallback } from '../host/host-profile.ts';
import { discoverWorkspace } from '../host/workspace.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import {
	type TaskManifest,
	type TaskPlan,
	canonicalJson,
	sha256,
	validateRunId,
	validateTaskPlan,
} from './contracts.ts';
import { SdlcError } from './errors.ts';
import { computeIsParallel, sortTasksTopologically } from './task-planner/task-graph.ts';
import { type ReadinessDraftLike, deriveTaskId, evaluateTaskReadiness } from './task-planner/task-readiness.ts';
import { type WorkspacePackagesScan, isContractProducerSurface } from './task-planner/workspace-packages.ts';

export {
	DEFAULT_SHADOW_PATHS,
	TASK_FEASIBILITY_LIMITS,
	classifyTaskChange,
	deriveTaskId,
	evaluateTaskReadiness,
} from './task-planner/task-readiness.ts';
export { sortTasksTopologically } from './task-planner/task-graph.ts';
export {
	type WorkspacePackageEntry,
	assertContractPreservingIntegration,
	contractArtifactPaths,
	contractVerificationCommandsForTask,
	isContractPreservingRefactor,
	isContractProducerSurface,
	missingContractCommands,
	scanWorkspacePackages,
} from './task-planner/workspace-packages.ts';

export interface PlannerAuthorizationLike {
	runId: string;
	baseCommitSha: string;
	taskManifestHash?: string | null;
	allowedPackages?: readonly string[];
	allowedPathPrefixes?: readonly string[];
}

export interface PlannerDraftInput {
	goal?: string;
	title?: string;
	acceptanceCriteria?: readonly string[];
	touchedSurfaces?: readonly string[];
}

interface PlanBranchContext {
	draft: PlannerDraftInput | null;
	taskManifest: TaskManifest | null;
	authorization: PlannerAuthorizationLike;
	rootDir: string;
	workspacePackages: WorkspacePackagesScan | null;
	runId: string;
	baseCommitSha: string;
	allowedPackages: string[];
	allowedPathPrefixes: string[];
	resolveNow: () => string;
}

export function planTaskDag({
	draft = null,
	taskManifest = null,
	authorization,
	rootDir = REPOSITORY_ROOT,
	workspacePackages = null,
	now = () => new Date().toISOString(),
}: {
	draft?: PlannerDraftInput | null;
	taskManifest?: TaskManifest | null;
	authorization?: PlannerAuthorizationLike | null;
	rootDir?: string;
	workspacePackages?: WorkspacePackagesScan | null;
	now?: (() => string | Date) | Date | string;
}): TaskPlan {
	if (!authorization) {
		throw new SdlcError('TASK_PLAN_INVALID', 'Authorization is required for task planning');
	}

	const runId = validateRunId(authorization.runId);
	const baseCommitSha = authorization.baseCommitSha;
	if (typeof baseCommitSha !== 'string' || !/^[a-f0-9]{40}$/.test(baseCommitSha)) {
		throw new SdlcError('TASK_PLAN_INVALID', `Invalid baseCommitSha: ${baseCommitSha}`);
	}

	const rawAllowedPackages = Array.isArray(authorization.allowedPackages)
		? authorization.allowedPackages
		: [];
	const allowedPackages = Array.from(new Set(rawAllowedPackages.filter(Boolean)));
	const allowedPathPrefixes = Array.isArray(authorization.allowedPathPrefixes)
		? [...authorization.allowedPathPrefixes]
		: [];

	const resolveNow = (): string => {
		if (typeof now === 'function') {
			const res = now();
			return res instanceof Date ? res.toISOString() : String(res);
		}
		if (now instanceof Date) return now.toISOString();
		if (typeof now === 'string') return now;
		return new Date().toISOString();
	};

	if (allowedPackages.length === 0 && allowedPathPrefixes.length === 0) {
		throw new SdlcError(
			'TASK_PLAN_INVALID',
			'Authorization must allow at least one package or path prefix',
		);
	}

	const branch: PlanBranchContext = {
		draft,
		taskManifest,
		authorization,
		rootDir,
		workspacePackages: workspacePackages ?? discoverWorkspace(rootDir),
		runId,
		baseCommitSha,
		allowedPackages,
		allowedPathPrefixes,
		resolveNow,
	};
	if (taskManifest) return planManifestTasks(branch);
	if (allowedPackages.length <= 1) return planSinglePackageTask(branch);
	return planPackageTasks(branch);
}

function asReadinessDraft(draft: PlannerDraftInput | null): ReadinessDraftLike {
	return {
		goal: draft?.goal ?? '',
		title: draft?.title,
		acceptanceCriteria: draft?.acceptanceCriteria ?? [],
		touchedSurfaces: draft?.touchedSurfaces ?? [],
	};
}

function planManifestTasks({
	draft,
	taskManifest,
	authorization,
	rootDir,
	workspacePackages,
	runId,
	baseCommitSha,
	allowedPackages,
	allowedPathPrefixes,
	resolveNow,
}: PlanBranchContext): TaskPlan {
	const readiness = evaluateTaskReadiness({
		draft: asReadinessDraft(draft),
		taskManifest,
		rootDir,
		workspacePackages: workspacePackages ?? discoverWorkspace(rootDir),
	});
	const authorizationPrefixes = allowedPathPrefixes.map((prefix) =>
		prefix.replace(/\/+$/, ''),
	);
	for (const task of readiness.tasks) {
		if (!allowedPackages.includes(task.targetPackage)) {
			throw new SdlcError(
				'TASK_PLAN_INVALID',
				`Task '${task.taskId}' targets unauthorized package '${task.targetPackage}'`,
			);
		}
		for (const candidate of [
			...task.authoredPaths,
			...task.pathPrefixes,
			...task.generatedOutputs,
		]) {
			const contained =
				(candidate === 'pnpm-lock.yaml' && task.dependencyMutations.length > 0) ||
				authorizationPrefixes.some(
					(prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`),
				);
			if (!contained) {
				throw new SdlcError(
					'TASK_PLAN_INVALID',
					`Task '${task.taskId}' path '${candidate}' widens authorization`,
				);
			}
		}
	}
	const taskDefinitions = readiness.tasks.map((task) => ({
		...structuredClone(task),
		title: `${readiness.slices.find((slice) => slice.sliceId === task.sliceId)?.goal ?? draft?.goal ?? ''} - ${task.taskId}`,
		status: 'pending' as const,
		integrationOrder: 0,
		worktreeSubdir: readiness.tasks.length === 1 ? 'worktree' : `worktrees/${task.taskId}`,
		baseCommitSha,
		parentTreeSha: null,
		parentCommitSha: null,
		targetTreeSha: null,
		patchHash: null,
		failurePacketArtifact: null,
		repairCount: 0,
	}));
	const sortedTasks = sortTasksTopologically(taskDefinitions);
	const isParallel = computeIsParallel(sortedTasks);
	const integrationOrder = sortedTasks.map((task) => task.taskId);
	const planPolicyHash = sha256({
		runId,
		baseCommitSha,
		taskManifestHash: authorization.taskManifestHash,
		slices: readiness.slices,
		tasks: sortedTasks.map((task) => ({
			taskId: task.taskId,
			sliceId: task.sliceId,
			targetPackage: task.targetPackage,
			authoredPaths: task.authoredPaths,
			pathPrefixes: task.pathPrefixes,
			generatedOutputs: task.generatedOutputs,
			dependsOn: task.dependsOn,
			integrationOrder: task.integrationOrder,
			complexityScore: task.complexityScore,
			changeClass: task.changeClass,
			highRisk: task.highRisk,
			maxAutonomousRepairs: task.maxAutonomousRepairs,
			humanReviewEvidence: task.humanReviewEvidence,
			shadowPaths: task.shadowPaths,
			verificationCommand: task.verificationCommand,
		})),
		isParallel,
	});
	return validateTaskPlan({
		schemaVersion: '1.0.0',
		runId,
		planPolicyHash,
		taskManifestHash: authorization.taskManifestHash,
		baseCommitSha,
		slices: readiness.slices,
		tasks: sortedTasks,
		integrationOrder,
		isParallel,
		createdAt: resolveNow(),
	});
}

function planSinglePackageTask({
	draft,
	authorization,
	rootDir,
	workspacePackages,
	runId,
	baseCommitSha,
	allowedPackages,
	allowedPathPrefixes,
	resolveNow,
}: PlanBranchContext): TaskPlan {
	const targetPackage =
		allowedPackages[0] ??
		(allowedPathPrefixes[0] ? allowedPathPrefixes[0].replace(/\/.*$/, '') : 'monorepo');
	const readiness =
		draft?.goal &&
		Array.isArray(draft.acceptanceCriteria) &&
		Array.isArray(draft.touchedSurfaces)
			? evaluateTaskReadiness({
					draft: asReadinessDraft(draft),
					rootDir,
					workspacePackages: workspacePackages ?? discoverWorkspace(rootDir),
				})
			: null;
	const readinessTask =
		readiness?.tasks.find((task) => task.targetPackage === targetPackage) ?? null;
	if (readiness && (!readinessTask || readiness.tasks.length !== 1)) {
		throw new SdlcError(
			'TASK_PLAN_INVALID',
			`Manifest-less single-package authorization for '${targetPackage}' does not match the derived task scope`,
		);
	}
	const singleTask = {
		...(readinessTask ? structuredClone(readinessTask) : {}),
		taskId: 'task-0',
		title: draft?.title ?? `Implement changes for ${targetPackage}`,
		targetPackage,
		pathPrefixes:
			readinessTask?.pathPrefixes ??
			(allowedPathPrefixes.length > 0 ? allowedPathPrefixes : [targetPackage]),
		dependsOn: [],
		status: 'pending' as const,
		integrationOrder: 0,
		worktreeSubdir: 'worktree',
		baseCommitSha,
		parentTreeSha: null,
		targetTreeSha: null,
		patchHash: null,
		failurePacketArtifact: null,
		repairCount: 0,
	};

	const tasks = [singleTask];
	const isParallel = false;
	const planPolicyHash = sha256(
		canonicalJson({
			runId,
			baseCommitSha,
			taskManifestHash: authorization.taskManifestHash ?? null,
			tasks: tasks.map((t) => ({
				taskId: t.taskId,
				targetPackage: t.targetPackage,
				pathPrefixes: t.pathPrefixes,
				dependsOn: t.dependsOn,
				integrationOrder: t.integrationOrder,
			})),
			isParallel,
		}),
	);

	return validateTaskPlan({
		schemaVersion: '1.0.0',
		runId,
		planPolicyHash,
		taskManifestHash: authorization.taskManifestHash ?? null,
		baseCommitSha,
		...(readiness ? { slices: readiness.slices } : {}),
		tasks,
		integrationOrder: ['task-0'],
		isParallel,
		createdAt: resolveNow(),
	});
}

function planPackageTasks({
	draft,
	authorization,
	rootDir,
	workspacePackages,
	runId,
	baseCommitSha,
	allowedPackages,
	allowedPathPrefixes,
	resolveNow,
}: PlanBranchContext): TaskPlan {
	const { packageMap, pathToPackage } = workspacePackages ?? discoverWorkspace(rootDir);
	const packageToTaskId = new Map<string, string>();
	const taskDefinitions = allowedPackages.map((pkgPath) => {
		const taskId = deriveTaskId(pkgPath);
		packageToTaskId.set(pkgPath, taskId);

		let scopedPrefixes = allowedPathPrefixes.filter(
			(prefix) => prefix.startsWith(pkgPath) || prefix === pkgPath,
		);
		if (scopedPrefixes.length === 0) {
			scopedPrefixes = [pkgPath.endsWith('/') ? pkgPath : `${pkgPath}/`];
		}
		if (
			allowedPathPrefixes.includes('pnpm-lock.yaml') &&
			(scopedPrefixes.some(
				(p) => p.endsWith('package.json') || p.replace(/\/+$/, '') === pkgPath,
			) ||
				(!allowedPathPrefixes.some((p) => p.endsWith('package.json')) &&
					pkgPath === allowedPackages[0]))
		) {
			scopedPrefixes.push('pnpm-lock.yaml');
		}

		return {
			taskId,
			title: draft?.title
				? `${draft.title} - ${path.basename(pkgPath)}`
				: `Implement ${path.basename(pkgPath)} changes`,
			targetPackage: pkgPath,
			pathPrefixes: scopedPrefixes,
			dependsOn: [] as string[],
			status: 'pending' as const,
			integrationOrder: 0,
			worktreeSubdir: `worktrees/${taskId}`,
			baseCommitSha,
			parentTreeSha: null,
			targetTreeSha: null,
			patchHash: null,
			failurePacketArtifact: null,
			repairCount: 0,
		};
	});

	const resolvedProfile = loadHostProfileOrFallback(rootDir);
	const contractRules = resolvedProfile.policy?.contractProducerRules;
	const sharedPackagePrefixes = contractRules?.sharedPackagePrefixes ?? ['packages/'];
	const producerPrefixes = contractRules?.producerPrefixes ?? [];
	const consumerPackages = contractRules?.consumerPackages ?? [];
	const consumerPrefixes = contractRules?.consumerPrefixes ?? [];

	for (const task of taskDefinitions) {
		const pkgName = pathToPackage.get(task.targetPackage);
		const pkgData = pkgName ? (packageMap.get(pkgName) ?? null) : null;
		const declaredDeps: Record<string, string | undefined> = pkgData
			? {
					...pkgData.pkgJson.dependencies,
					...pkgData.pkgJson.devDependencies,
					...pkgData.pkgJson.peerDependencies,
				}
			: {};

		const dependsOnSet = new Set<string>();

		for (const otherTask of taskDefinitions) {
			if (otherTask.taskId === task.taskId) continue;

			const otherPkgName = pathToPackage.get(otherTask.targetPackage);
			if (otherPkgName && declaredDeps[otherPkgName]) {
				dependsOnSet.add(otherTask.taskId);
			}
			if (
				sharedPackagePrefixes.some((sp) => otherTask.targetPackage.startsWith(sp)) &&
				otherPkgName &&
				declaredDeps[otherPkgName]
			) {
				dependsOnSet.add(otherTask.taskId);
			}

			const otherPkgData = otherPkgName ? (packageMap.get(otherPkgName) ?? null) : null;
			const isOtherProducer =
				producerPrefixes.some((pp) => otherTask.targetPackage.startsWith(pp)) &&
				isContractProducerSurface(
					otherTask.pathPrefixes,
					otherTask.targetPackage,
					otherPkgData,
					{ rootDir, profile: resolvedProfile },
				);

			const isThisConsumer =
				consumerPackages.includes(task.targetPackage) ||
				consumerPrefixes.some((cp) => task.targetPackage.startsWith(cp));

			if (isOtherProducer && (isThisConsumer || (otherPkgName && declaredDeps[otherPkgName]))) {
				dependsOnSet.add(otherTask.taskId);
			}
		}

		task.dependsOn = Array.from(dependsOnSet).sort();
	}

	const semanticOrder = sortTasksTopologically(taskDefinitions);
	let previousRootManifestTask: (typeof semanticOrder)[number] | null = null;
	for (const task of semanticOrder) {
		const ownsRootManifest = task.pathPrefixes.some((prefix) =>
			/^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(prefix),
		);
		if (!ownsRootManifest) continue;

		if (
			previousRootManifestTask &&
			!task.dependsOn.includes(previousRootManifestTask.taskId)
		) {
			task.dependsOn.push(previousRootManifestTask.taskId);
			task.dependsOn.sort();
		}
		previousRootManifestTask = task;
	}

	const sortedTasks = sortTasksTopologically(taskDefinitions);
	const isParallel = computeIsParallel(sortedTasks);

	const planPolicyHash = sha256(
		canonicalJson({
			runId,
			baseCommitSha,
			taskManifestHash: authorization.taskManifestHash ?? null,
			tasks: sortedTasks.map((t) => ({
				taskId: t.taskId,
				targetPackage: t.targetPackage,
				pathPrefixes: t.pathPrefixes,
				dependsOn: t.dependsOn,
				integrationOrder: t.integrationOrder,
			})),
			isParallel,
		}),
	);

	return validateTaskPlan({
		schemaVersion: '1.0.0',
		runId,
		planPolicyHash,
		taskManifestHash: authorization.taskManifestHash ?? null,
		baseCommitSha,
		tasks: sortedTasks,
		integrationOrder: sortedTasks.map((t) => t.taskId),
		isParallel,
		createdAt: resolveNow(),
	});
}
