// One pre-freeze closure over tasks marked retirement. The walker is called once.

import { taskAuthoredWritePaths } from '../execution/task-scope.ts';
import { SdlcError } from './errors.ts';
import { TASK_FEASIBILITY_LIMITS } from './task-planner/task-readiness.ts';
import { readStaticImportGraph, type UnresolvedStaticImport } from './static-import-graph.ts';

export interface RetirementTaskLike {
	readonly taskId: string;
	readonly targetPackage: string;
	readonly pathPrefixes: readonly string[];
	readonly authoredPaths?: readonly string[];
	readonly generatedOutputs?: readonly string[];
	readonly integrationOrder?: number;
	readonly retirement?: boolean;
}

export interface RetirementBlocker {
	readonly kind: 'unresolved_import' | 'outside_allowed_prefixes';
	readonly path: string;
	readonly taskId: string;
	readonly detail: string;
}

export interface RetirementExpansion<T extends RetirementTaskLike> {
	readonly tasks: readonly T[];
	readonly blockers: readonly RetirementBlocker[];
}

const blockersByHash = new Map<string, readonly RetirementBlocker[]>();

export function rememberRetirementBlockers(
	planPolicyHash: string,
	blockers: readonly RetirementBlocker[],
): void {
	if (blockers.length === 0) {
		blockersByHash.delete(planPolicyHash);
		return;
	}
	blockersByHash.set(planPolicyHash, Object.freeze([...blockers]));
}

export function retirementBlockersFor(planPolicyHash: string): readonly RetirementBlocker[] {
	return blockersByHash.get(planPolicyHash) ?? [];
}

export function expandRetirementPaths<T extends RetirementTaskLike>({
	tasks,
	rootDir,
	allowedPathPrefixes,
}: {
	tasks: readonly T[] | null | undefined;
	rootDir: string;
	allowedPathPrefixes: readonly string[] | null | undefined;
}): RetirementExpansion<T> {
	const list = Array.isArray(tasks) ? [...tasks] : [];
	const retirement = list.filter((task) => task.retirement === true);
	if (retirement.length === 0) {
		return Object.freeze({ tasks: Object.freeze(list), blockers: Object.freeze([]) });
	}
	const prefixes = Array.isArray(allowedPathPrefixes) ? allowedPathPrefixes : [];
	const graph = readStaticImportGraph({
		rootDir,
		roots: [...new Set(retirement.map((task) => task.targetPackage))],
	});
	const union = retirement.flatMap((task) => [...taskAuthoredWritePaths(task)]);
	const blockers = unresolvedBlockers(retirement, union, graph.unresolved);
	if (blockers.length > 0) {
		return Object.freeze({ tasks: Object.freeze(list), blockers: Object.freeze(blockers) });
	}
	const importersByFile = new Map<string, string[]>();
	for (const edge of graph.imports) {
		const current = importersByFile.get(edge.resolved) ?? [];
		current.push(edge.importer);
		importersByFile.set(edge.resolved, current);
	}
	const additions = new Map<string, string[]>();
	for (const [candidate, importers] of importersByFile) {
		if (coveredBy(candidate, union)) continue;
		if (importers.length === 0 || importers.some((importer) => !coveredBy(importer, union))) continue;
		if (!insidePrefixes(candidate, prefixes)) {
			const owner = assignOwner(retirement, importers);
			blockers.push({
				kind: 'outside_allowed_prefixes',
				path: candidate,
				taskId: owner?.taskId ?? retirement[0]?.taskId ?? '',
				detail: `Sibling '${candidate}' is outside allowedPathPrefixes`,
			});
			continue;
		}
		const owner = assignOwner(retirement, importers);
		if (!owner) continue;
		const bucket = additions.get(owner.taskId) ?? [];
		if (!bucket.includes(candidate)) bucket.push(candidate);
		additions.set(owner.taskId, bucket);
	}
	if (blockers.length > 0 && additions.size === 0) {
		return Object.freeze({ tasks: Object.freeze(list), blockers: Object.freeze(blockers) });
	}
	const expanded = list.map((task) => appendPaths(task, additions.get(task.taskId) ?? []));
	assertWithinCeilings(expanded.filter((task) => additions.has(task.taskId)));
	return Object.freeze({ tasks: Object.freeze(expanded), blockers: Object.freeze(blockers) });
}

function unresolvedBlockers(
	retirement: readonly RetirementTaskLike[],
	union: readonly string[],
	unresolved: readonly UnresolvedStaticImport[],
): RetirementBlocker[] {
	const blockers: RetirementBlocker[] = [];
	for (const hit of unresolved) {
		if (!coveredBy(hit.file, union)) continue;
		const task = retirement.find((entry) => coveredBy(hit.file, [...taskAuthoredWritePaths(entry)]));
		const label = hit.specifier ?? hit.file;
		blockers.push({
			kind: 'unresolved_import',
			path: hit.specifier ?? hit.file,
			taskId: task?.taskId ?? '',
			detail: `Unresolved ${hit.reason} import '${label}' in '${hit.file}'`,
		});
	}
	return blockers;
}

function assignOwner(
	retirement: readonly RetirementTaskLike[],
	importers: readonly string[],
): RetirementTaskLike | null {
	let best: { task: RetirementTaskLike; count: number; order: number } | null = null;
	for (const task of retirement) {
		const writeSet = [...taskAuthoredWritePaths(task)];
		const count = importers.filter((importer) => coveredBy(importer, writeSet)).length;
		if (count === 0) continue;
		const order = task.integrationOrder ?? Number.MAX_SAFE_INTEGER;
		if (!best || count > best.count || (count === best.count && order < best.order)) {
			best = { task, count, order };
		}
	}
	return best?.task ?? null;
}

function appendPaths<T extends RetirementTaskLike>(task: T, added: readonly string[]): T {
	if (added.length === 0) return task;
	const pathPrefixes = [...task.pathPrefixes];
	for (const entry of added) {
		if (!pathPrefixes.includes(entry)) pathPrefixes.push(entry);
	}
	const authoredPaths = task.authoredPaths && task.authoredPaths.length > 0
		? [...task.authoredPaths]
		: null;
	if (authoredPaths) {
		for (const entry of added) {
			if (!authoredPaths.includes(entry)) authoredPaths.push(entry);
		}
	}
	return authoredPaths ? { ...task, pathPrefixes, authoredPaths } : { ...task, pathPrefixes };
}

function assertWithinCeilings(tasks: readonly RetirementTaskLike[]): void {
	for (const task of tasks) {
		if (task.pathPrefixes.length > TASK_FEASIBILITY_LIMITS.pathPrefixes) {
			throw new SdlcError(
				'TASK_DECOMPOSITION_REQUIRED',
				`Task decomposition required; exceeded limits: ${task.taskId}: pathPrefixes=${task.pathPrefixes.length} (max ${TASK_FEASIBILITY_LIMITS.pathPrefixes})`,
			);
		}
		const authored = task.authoredPaths?.length ?? 0;
		if (authored > TASK_FEASIBILITY_LIMITS.authoredPaths) {
			throw new SdlcError(
				'TASK_DECOMPOSITION_REQUIRED',
				`Task decomposition required; exceeded limits: ${task.taskId}: authoredPaths=${authored} (max ${TASK_FEASIBILITY_LIMITS.authoredPaths})`,
			);
		}
	}
}

function coveredBy(file: string, writePaths: readonly string[]): boolean {
	const norm = normalize(file);
	return writePaths.some((raw) => {
		const prefix = normalize(raw);
		return norm === prefix || norm.startsWith(`${prefix}/`);
	});
}

function insidePrefixes(file: string, prefixes: readonly string[]): boolean {
	return coveredBy(file, prefixes);
}

function normalize(value: string): string {
	return value.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}
