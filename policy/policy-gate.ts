import {
	type HostProfile,
	loadHostProfileOrFallback,
} from '../host/host-profile.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { SdlcError } from './errors.ts';
import {
	type WorkspacePackagesScan,
	isContractProducerSurface,
	scanWorkspacePackages,
} from './task-planner/workspace-packages.ts';

export interface PolicyGateTask {
	taskId: string;
	targetPackage: string;
	pathPrefixes: readonly string[];
	authoredPaths?: readonly string[];
	generatedOutputs?: readonly string[];
	dependsOn: readonly string[];
}

export interface PolicyViolation {
	message: string;
	metadata: Record<string, unknown>;
	code: string;
}

export function buildReachability(
	tasks: readonly PolicyGateTask[],
): (fromId: string, targetId: string) => boolean {
	const taskMap = new Map(tasks.map((t) => [t.taskId, t]));
	const memo = new Map<string, boolean>();

	function reaches(fromId: string, targetId: string): boolean {
		if (fromId === targetId) return true;
		const key = `${fromId}->${targetId}`;
		const cached = memo.get(key);
		if (cached !== undefined) return cached;

		const task = taskMap.get(fromId);
		if (!task) {
			memo.set(key, false);
			return false;
		}

		for (const depId of task.dependsOn) {
			if (depId === targetId || reaches(depId, targetId)) {
				memo.set(key, true);
				return true;
			}
		}

		memo.set(key, false);
		return false;
	}

	return reaches;
}

export function evaluatePolicyGate({
	taskPlan,
	authorization,
	rootDir = REPOSITORY_ROOT,
	workspacePackages = null,
	throwOnError = true,
}: {
	taskPlan?: {
		tasks?: readonly PolicyGateTask[];
		integrationOrder?: readonly string[];
	} | null;
	authorization?: { allowedPackages?: readonly string[] } | null;
	rootDir?: string;
	workspacePackages?: WorkspacePackagesScan | null;
	throwOnError?: boolean;
}): { passed: boolean; violations: PolicyViolation[]; evaluatedAt?: string } {
	const violations: PolicyViolation[] = [];

	const reportViolation = (
		message: string,
		metadata: Record<string, unknown> = {},
		code = 'POLICY_VIOLATION',
	): void => {
		violations.push({ message, metadata, code });
		if (throwOnError) {
			throw new SdlcError(code, message, metadata);
		}
	};

	if (!taskPlan || !Array.isArray(taskPlan.tasks) || taskPlan.tasks.length === 0) {
		reportViolation('Task plan is empty or invalid');
		return { passed: false, violations };
	}

	const tasks = taskPlan.tasks;
	const taskMap = new Map(tasks.map((t) => [t.taskId, t]));

	const visited = new Set<string>();
	const recStack = new Set<string>();

	function checkCycle(taskId: string, path: string[] = []): void {
		visited.add(taskId);
		recStack.add(taskId);

		const task = taskMap.get(taskId);
		if (task) {
			for (const depId of task.dependsOn) {
				if (!taskMap.has(depId)) {
					reportViolation(`Task '${taskId}' depends on unknown task '${depId}'`, { taskId, depId });
					return;
				}
				if (!visited.has(depId)) {
					checkCycle(depId, [...path, taskId]);
				} else if (recStack.has(depId)) {
					reportViolation('Cyclic task dependencies detected in task plan', {
						cycle: [...path, taskId, depId],
					});
					return;
				}
			}
		}

		recStack.delete(taskId);
	}

	for (const task of tasks) {
		if (!visited.has(task.taskId)) {
			checkCycle(task.taskId);
		}
	}

	const isReachable = buildReachability(tasks);

	if (authorization) {
		const allowedPkgs = new Set(authorization.allowedPackages ?? []);
		for (const task of tasks) {
			if (
				allowedPkgs.size > 0 &&
				!allowedPkgs.has(task.targetPackage) &&
				task.targetPackage !== 'monorepo'
			) {
				reportViolation(
					`Task '${task.taskId}' targets unauthorized package '${task.targetPackage}'`,
					{ taskId: task.taskId, targetPackage: task.targetPackage },
				);
			}
		}
	}

	const resolvedProfile: Readonly<HostProfile> = loadHostProfileOrFallback(rootDir);
	const protectedBaselinePaths = resolvedProfile.policy?.protectedBaselinePaths ?? [];
	const contractRules = resolvedProfile.policy?.contractProducerRules;
	const sharedPackagePrefixes = contractRules?.sharedPackagePrefixes ?? ['packages/'];
	const producerPrefixes = contractRules?.producerPrefixes ?? [];
	const consumerPackages = contractRules?.consumerPackages ?? [];
	const consumerPrefixes = contractRules?.consumerPrefixes ?? [];

	for (const task of tasks) {
		for (const prefix of task.pathPrefixes) {
			const cleanPrefix = prefix.replace(/^\.?\//, '').replace(/\/+$/, '');
			const hitsBaseline = protectedBaselinePaths.some((basePath) => {
				const cleanBase = basePath.replace(/^\.?\//, '').replace(/\/+$/, '');
				return (
					cleanPrefix === cleanBase ||
					cleanPrefix.startsWith(`${cleanBase}/`) ||
					cleanPrefix.includes(cleanBase)
				);
			});
			if (hitsBaseline) {
				reportViolation(`Modification of quality baselines is forbidden: '${prefix}'`, {
					taskId: task.taskId,
					prefix,
				});
			}
		}
	}

	for (let i = 0; i < tasks.length; i++) {
		for (let j = i + 1; j < tasks.length; j++) {
			const t1 = tasks[i];
			const t2 = tasks[j];

			const isConcurrent =
				!isReachable(t1.taskId, t2.taskId) && !isReachable(t2.taskId, t1.taskId);

			if (isConcurrent) {
				if (t1.targetPackage === t2.targetPackage) {
					reportViolation(
						`Multiple concurrent tasks targeting the same package '${t1.targetPackage}': '${t1.taskId}' and '${t2.taskId}'`,
						{ task1: t1.taskId, task2: t2.taskId, targetPackage: t1.targetPackage },
						'TASK_PLAN_INVALID',
					);
				}

				const ownedPaths1 = [
					...(t1.pathPrefixes ?? []),
					...(t1.authoredPaths ?? []),
					...(t1.generatedOutputs ?? []),
				];
				const ownedPaths2 = [
					...(t2.pathPrefixes ?? []),
					...(t2.authoredPaths ?? []),
					...(t2.generatedOutputs ?? []),
				];
				for (const p1 of ownedPaths1) {
					const norm1 = p1.replace(/\/+$/, '');
					for (const p2 of ownedPaths2) {
						const norm2 = p2.replace(/\/+$/, '');
						if (
							norm1 === norm2 ||
							norm1.startsWith(`${norm2}/`) ||
							norm2.startsWith(`${norm1}/`)
						) {
							reportViolation(
								`Concurrent tasks '${t1.taskId}' and '${t2.taskId}' have overlapping owned paths: '${p1}' and '${p2}'`,
								{ task1: t1.taskId, task2: t2.taskId, prefix1: p1, prefix2: p2 },
								'TASK_PLAN_INVALID',
							);
						}
					}
				}

				const isRoot1 = ownedPaths1.some((p) =>
					/^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(p),
				);
				const isRoot2 = ownedPaths2.some((p) =>
					/^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(p),
				);
				if (isRoot1 && isRoot2) {
					reportViolation(
						`Multiple concurrent tasks targeting root manifests are forbidden: '${t1.taskId}' and '${t2.taskId}'`,
						{ task1: t1.taskId, task2: t2.taskId },
						'TASK_PLAN_INVALID',
					);
				}
			}
		}
	}

	const { packageMap, pathToPackage } = workspacePackages ?? scanWorkspacePackages(rootDir);

	for (const task of tasks) {
		const pkgName = pathToPackage.get(task.targetPackage);
		const pkgData = pkgName ? (packageMap.get(pkgName) ?? null) : null;
		const declaredDeps: Record<string, string | undefined> = pkgData
			? {
					...pkgData.pkgJson.dependencies,
					...pkgData.pkgJson.devDependencies,
					...pkgData.pkgJson.peerDependencies,
				}
			: {};

		for (const otherTask of tasks) {
			if (otherTask.taskId === task.taskId) continue;

			if (sharedPackagePrefixes.some((sp) => otherTask.targetPackage.startsWith(sp))) {
				const otherPkgName = pathToPackage.get(otherTask.targetPackage);
				if (otherPkgName && declaredDeps[otherPkgName]) {
					if (!isReachable(task.taskId, otherTask.taskId)) {
						reportViolation(
							`Consumer task '${task.taskId}' must be serialized after shared package task '${otherTask.taskId}'`,
							{ consumerTaskId: task.taskId, sharedTaskId: otherTask.taskId },
						);
					}
				}
			}

			const otherPkgName = pathToPackage.get(otherTask.targetPackage);
			const otherPkgData = otherPkgName ? (packageMap.get(otherPkgName) ?? null) : null;
			const isOtherProducer =
				producerPrefixes.some((pp) => otherTask.targetPackage.startsWith(pp)) &&
				isContractProducerSurface(otherTask.pathPrefixes, otherTask.targetPackage, otherPkgData, {
					rootDir,
					profile: resolvedProfile,
				});

			const isThisConsumer =
				consumerPackages.includes(task.targetPackage) ||
				consumerPrefixes.some((cp) => task.targetPackage.startsWith(cp));

			if (isOtherProducer && (isThisConsumer || (otherPkgName && declaredDeps[otherPkgName]))) {
				if (!isReachable(task.taskId, otherTask.taskId)) {
					reportViolation(
						`Contract consumer task '${task.taskId}' must be serialized after contract producer task '${otherTask.taskId}'`,
						{ consumerTaskId: task.taskId, producerTaskId: otherTask.taskId },
					);
				}
			}
		}
	}

	const orderList = Array.isArray(taskPlan.integrationOrder) ? taskPlan.integrationOrder : [];
	const orderIndex = new Map(orderList.map((id, idx) => [id, idx]));

	for (const task of tasks) {
		const taskIdx = orderIndex.get(task.taskId);
		if (taskIdx === undefined) {
			reportViolation(`Task '${task.taskId}' missing from integrationOrder`, {
				taskId: task.taskId,
			});
			continue;
		}

		for (const depId of task.dependsOn) {
			const depIdx = orderIndex.get(depId);
			if (depIdx === undefined) {
				reportViolation(`Dependency '${depId}' missing from integrationOrder`, { depId });
			} else if (depIdx >= taskIdx) {
				reportViolation(
					`Integration order violates dependency: '${depId}' (order ${depIdx}) must precede '${task.taskId}' (order ${taskIdx})`,
					{ taskId: task.taskId, depId, taskIndex: taskIdx, depIndex: depIdx },
				);
			}
		}
	}

	return {
		passed: violations.length === 0,
		violations,
		evaluatedAt: new Date().toISOString(),
	};
}
