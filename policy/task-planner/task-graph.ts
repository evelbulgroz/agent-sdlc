import { SdlcError } from '../errors.ts';

export interface GraphTask {
	taskId: string;
	dependsOn: readonly string[];
	[key: string]: unknown;
}

export function taskReaches(
	taskById: ReadonlyMap<string, { dependsOn?: readonly string[] }>,
	fromId: string,
	targetIds: ReadonlySet<string> | string,
	visited: Set<string> = new Set(),
): boolean {
	const targets =
		targetIds instanceof Set ? targetIds : new Set<string>([targetIds as string]);
	if (targets.has(fromId)) return true;
	if (visited.has(fromId)) return false;
	visited.add(fromId);
	const task = taskById.get(fromId);
	return (task?.dependsOn ?? []).some((dependencyId) =>
		taskReaches(taskById, dependencyId, targets, visited),
	);
}

/** True when two tasks in the sorted list have no dependency path either way. */
export function computeIsParallel<T extends GraphTask>(sortedTasks: readonly T[]): boolean {
	const taskById = new Map(sortedTasks.map((task) => [task.taskId, task]));
	return sortedTasks.some((left, index) =>
		sortedTasks.slice(index + 1).some(
			(right) =>
				!taskReaches(taskById, left.taskId, new Set([right.taskId])) &&
				!taskReaches(taskById, right.taskId, new Set([left.taskId])),
		),
	);
}

/**
 * Deterministically topologically sorts DAG tasks with lexicographical tie-breaking.
 * Detects cycles and throws SdlcError('POLICY_VIOLATION', 'Cyclic task dependencies detected').
 */
export function sortTasksTopologically<T extends GraphTask>(
	tasks: readonly T[],
): Array<T & { integrationOrder: number }> {
	const taskMap = new Map(tasks.map((t) => [t.taskId, t]));
	const inDegree = new Map<string, number>();
	const adj = new Map<string, string[]>();

	for (const task of tasks) {
		inDegree.set(task.taskId, 0);
		adj.set(task.taskId, []);
	}

	for (const task of tasks) {
		for (const depId of task.dependsOn) {
			if (!taskMap.has(depId)) {
				throw new SdlcError(
					'TASK_PLAN_INVALID',
					`Task '${task.taskId}' depends on unknown task '${depId}'`,
				);
			}
			const list = adj.get(depId);
			if (list) list.push(task.taskId);
			inDegree.set(task.taskId, (inDegree.get(task.taskId) ?? 0) + 1);
		}
	}

	const readyQueue = tasks
		.filter((t) => (inDegree.get(t.taskId) ?? 0) === 0)
		.map((t) => t.taskId)
		.sort();

	const sortedTaskIds: string[] = [];

	while (readyQueue.length > 0) {
		const currentId = readyQueue.shift();
		if (currentId === undefined) break;
		sortedTaskIds.push(currentId);

		const neighbors = adj.get(currentId) ?? [];
		neighbors.sort();
		for (const nextId of neighbors) {
			const newDeg = (inDegree.get(nextId) ?? 0) - 1;
			inDegree.set(nextId, newDeg);
			if (newDeg === 0) {
				readyQueue.push(nextId);
				readyQueue.sort();
			}
		}
	}

	if (sortedTaskIds.length !== tasks.length) {
		throw new SdlcError(
			'POLICY_VIOLATION',
			'Cyclic task dependencies detected in task plan',
		);
	}

	return sortedTaskIds.map((taskId, index) => {
		const task = taskMap.get(taskId);
		if (!task) {
			throw new SdlcError('TASK_PLAN_INVALID', `Unknown task '${taskId}'`);
		}
		return {
			...task,
			integrationOrder: index,
		};
	});
}
