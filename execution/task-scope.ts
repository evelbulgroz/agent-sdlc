/**
 * Scopes a monorepo-wide specSummary and touched surfaces to a single DAG task.
 * Filters touched surfaces by task.pathPrefixes and prepends an explicit task scope header.
 */
export interface TaskScopeTaskLike {
	readonly taskId?: string;
	readonly id?: string;
	readonly title?: string;
	readonly targetPackage?: string;
	readonly package?: string;
	readonly sliceId?: string | null;
	readonly pathPrefixes?: readonly string[];
	readonly authoredPaths?: readonly string[];
	readonly generatedOutputs?: readonly string[];
	readonly dependsOn?: readonly string[];
	status?: string;
}

export interface TaskScopePlanLike {
	readonly tasks?: readonly TaskScopeTaskLike[];
}

export interface TaskScopeAuthorizationLike {
	readonly allowedPackages?: readonly string[];
}

export function scopeSpecSummaryForTask({
	specSummary = '',
	task,
	siblingTestPaths = [],
}: {
	specSummary?: string;
	task?: TaskScopeTaskLike | null;
	siblingTestPaths?: readonly string[];
}): string {
	if (!task) {
		return specSummary || '';
	}
	let scopedSummary = specSummary || '';
	const prefixes = task.pathPrefixes ?? [];

	if (prefixes.length > 0 && scopedSummary.includes('Touched Surfaces:')) {
		const parts = scopedSummary.split('\n\n');
		const mappedParts = parts.map((part) => {
			if (!part.startsWith('Touched Surfaces:')) {
				return part;
			}
			const lines = part.split('\n');
			const header = lines[0] ?? 'Touched Surfaces:';
			const surfaces = lines.slice(1);
			const filteredSurfaces = surfaces.filter((line) => {
				const trimmed = line.replace(/^[-*\s]+/, '').trim();
				if (!trimmed) return false;
				return prefixes.some((prefix) => {
					const cleanPrefix = prefix.replace(/\/+$/, '');
					const cleanSurface = trimmed.replace(/\/+$/, '');
					return cleanSurface.startsWith(cleanPrefix) || cleanPrefix.startsWith(cleanSurface);
				});
			});
			if (filteredSurfaces.length > 0) {
				return [header, ...filteredSurfaces].join('\n');
			}
			return `${header}\n(Scoped to: ${prefixes.join(', ')})`;
		});
		scopedSummary = mappedParts.join('\n\n');
	}

	const mutationPaths = taskAuthoredWritePaths(task);
	const taskHeader = [
		`### Current Task Scope: ${task.taskId ?? ''} (${task.title || task.targetPackage || ''})`,
		`Target Package: ${task.targetPackage ?? ''}`,
		`Authorized Mutation Path Prefixes:`,
		...mutationPaths.map((p) => `- ${p}`),
		`Package-local files may be inspected for prior art, but do NOT modify files outside the authorized mutation path prefixes.`,
		...(Array.isArray(siblingTestPaths) && siblingTestPaths.length > 0
			? [
					`Earlier task(s) in slice '${String(task.sliceId ?? '')}' already authored and tested: ${siblingTestPaths.join(', ')}. Their @ac / @case citations count toward slice AC coverage — only test the behavior owned by your Authorized Mutation Path Prefixes in your spec files.`,
				]
			: []),
	].join('\n');

	return `${taskHeader}\n\n${scopedSummary}`;
}

export function taskReadPathPrefixes(task: TaskScopeTaskLike | null | undefined): string[] {
	const targetPackage = String(task?.targetPackage ?? '').trim().replace(/\/+$/, '');
	return targetPackage ? [targetPackage] : [...(task?.pathPrefixes ?? [])];
}

export function collectCumulativeTaskPackages(
	task: TaskScopeTaskLike | null | undefined,
	taskPlan?: TaskScopePlanLike | null,
	authorization: TaskScopeAuthorizationLike | null = null,
): string[] {
	const packages = new Set<string>();
	if (task?.targetPackage) packages.add(task.targetPackage);
	if (taskPlan?.tasks) {
		const taskMap = new Map(taskPlan.tasks.map((t) => [t.taskId ?? t.id ?? '', t]));
		const visited = new Set<string>();
		const collect = (taskId: string): void => {
			if (!taskId || visited.has(taskId)) return;
			visited.add(taskId);
			const t = taskMap.get(taskId);
			if (t) {
				const pkg = t.targetPackage ?? t.package;
				if (pkg) packages.add(pkg);
				for (const depId of t.dependsOn ?? []) collect(depId);
			}
		};
		for (const depId of task?.dependsOn ?? []) collect(depId);
	}
	if (authorization?.allowedPackages) {
		for (const pkg of authorization.allowedPackages) packages.add(pkg);
	}
	return Array.from(packages).sort();
}

export function taskAuthoredWritePaths(task: TaskScopeTaskLike): readonly string[] {
	const basePaths =
		task.authoredPaths && task.authoredPaths.length > 0
			? task.authoredPaths
			: (task.pathPrefixes ?? []);
	if (task.generatedOutputs && task.generatedOutputs.length > 0) {
		return [...new Set([...basePaths, ...task.generatedOutputs])];
	}
	return basePaths;
}
