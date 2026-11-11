// Multi-package authorization plans. Extracted so planTaskDag can call the retirement scan.

import path from 'node:path';
import { loadHostProfileOrFallback } from '../../host/host-profile.ts';
import { discoverWorkspace } from '../../host/workspace.ts';
import { type TaskPlan, canonicalJson, sha256, validateTaskPlan } from '../contracts.ts';
import { computeIsParallel, sortTasksTopologically } from './task-graph.ts';
import { deriveTaskId } from './task-readiness.ts';
import { type WorkspacePackagesScan, isContractProducerSurface } from './workspace-packages.ts';

export interface PackagePlanBranch {
	draft: { title?: string } | null;
	authorization: { taskManifestHash?: string | null };
	rootDir: string;
	workspacePackages: WorkspacePackagesScan | null;
	runId: string;
	baseCommitSha: string;
	allowedPackages: string[];
	allowedPathPrefixes: string[];
	resolveNow: () => string;
}

export function planPackagesFromAuthorization({
	draft,
	authorization,
	rootDir,
	workspacePackages,
	runId,
	baseCommitSha,
	allowedPackages,
	allowedPathPrefixes,
	resolveNow,
}: PackagePlanBranch): TaskPlan {
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
