import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SdlcError } from '../policy/errors.ts';
import type { DeltaTaskLike, GitCliFn } from './task-tree-delta.ts';

export interface ClosureSlice {
	readonly sliceId: string;
	readonly kind: 'enabling' | 'vertical' | 'activation';
	readonly dependsOn: readonly string[];
}

export interface ClosureTask extends DeltaTaskLike {
	readonly sliceId?: string | null;
	readonly status?: string;
}

export interface ClosurePlan {
	readonly tasks: readonly ClosureTask[];
	readonly slices: readonly ClosureSlice[];
	readonly integrationOrder: readonly string[];
}

function fail(message: string): never {
	throw new SdlcError('TASK_PLAN_INVALID', message);
}

export function predecessorSliceIds(plan: ClosurePlan, sliceId: string): string[] {
	const slices = new Map(plan.slices.map(slice => [slice.sliceId, slice]));
	const result = new Set<string>();
	const visiting = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) fail(`Cycle in slice closure at '${id}'`);
		if (result.has(id)) return;
		const slice = slices.get(id);
		if (!slice) fail(`Unknown slice '${id}'`);
		visiting.add(id);
		for (const predecessor of slice.dependsOn) visit(predecessor);
		visiting.delete(id);
		result.add(id);
	};
	const own = slices.get(sliceId);
	if (!own) fail(`Unknown slice '${sliceId}'`);
	for (const id of own.dependsOn) visit(id);
	return [...result];
}

export function eligibleParentTasks(plan: ClosurePlan, taskId: string): ClosureTask[] {
	const tasks = new Map(plan.tasks.map(task => [task.taskId, task]));
	const own = tasks.get(taskId);
	if (!own?.sliceId) fail(`Task '${taskId}' requires a slice`);
	const predecessors = new Set(predecessorSliceIds(plan, own.sliceId));
	const ids = new Set(plan.tasks.filter(task => task.sliceId && predecessors.has(task.sliceId))
		.map(task => task.taskId));
	const visiting = new Set<string>();
	const addLocal = (id: string): void => {
		if (visiting.has(id)) fail(`Cycle in task closure at '${id}'`);
		if (ids.has(id)) return;
		const task = tasks.get(id);
		if (!task) fail(`Unknown local dependency '${id}'`);
		if (task.sliceId !== own.sliceId) fail(`Task edge '${id}' is outside its declared slice closure`);
		visiting.add(id);
		for (const dependency of task.dependsOn ?? []) addLocal(dependency);
		visiting.delete(id);
		ids.add(id);
	};
	for (const id of own.dependsOn ?? []) addLocal(id);
	return orderedTasks(plan, ids);
}

export function sliceClosureTasks(plan: ClosurePlan, sliceId: string): ClosureTask[] {
	const slices = new Set([...predecessorSliceIds(plan, sliceId), sliceId]);
	return orderedTasks(plan, new Set(plan.tasks.filter(task => task.sliceId && slices.has(task.sliceId))
		.map(task => task.taskId)));
}

function orderedTasks(plan: ClosurePlan, ids: ReadonlySet<string>): ClosureTask[] {
	const tasks = new Map(plan.tasks.map(task => [task.taskId, task]));
	if (new Set(plan.integrationOrder).size !== plan.integrationOrder.length) fail('Duplicate integration order');
	const result = plan.integrationOrder.filter(id => ids.has(id)).map(id => {
		const task = tasks.get(id);
		if (!task) fail(`Unknown ordered task '${id}'`);
		return task;
	});
	if (result.length !== ids.size) fail('Integration order omits closure tasks');
	return result;
}

export function assertEligiblePredecessors(
	plan: ClosurePlan,
	sliceId: string,
	statusFor: (sliceId: string) => string | null,
): void {
	for (const id of predecessorSliceIds(plan, sliceId)) {
		const slice = plan.slices.find(entry => entry.sliceId === id);
		if (!slice) fail(`Unknown predecessor slice '${id}'`);
		const expected = slice.kind === 'enabling' ? 'verified' : 'accepted';
		if (statusFor(id) !== expected) {
			throw new SdlcError('POLICY_VIOLATION', `Predecessor '${id}' has no eligible ${expected} closure`);
		}
	}
}

export function materializeClosureTree({
	baseTreeSha, tasks, rootDir, gitCli,
}: {
	baseTreeSha: string; tasks: readonly ClosureTask[]; rootDir: string; gitCli: GitCliFn;
}): string {
	const index = path.join(rootDir, '.git', `sdlc-closure-${crypto.randomUUID()}.index`);
	// Git worktree .git is a file; resolve the common Git directory before creating an index.
	const gitDir = String(gitCli('git', ['rev-parse', '--git-common-dir'], {
		cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
	})).trim();
	const indexPath = path.join(path.resolve(rootDir, gitDir), path.basename(index));
	const env = { ...process.env, GIT_INDEX_FILE: indexPath };
	const opts = { cwd: rootDir, env, stdio: ['ignore', 'pipe', 'pipe'] as const };
	try {
		gitCli('git', ['read-tree', baseTreeSha], opts);
		for (const task of tasks) {
			if (task.status !== 'completed' || !task.parentTreeSha || !task.targetTreeSha) {
				throw new SdlcError('TASK_EXECUTION_FAILED', `Closure task '${task.taskId}' has no completed delta`);
			}
			const patch = gitCli('git', ['diff-tree', '-r', '-p', '--binary', task.parentTreeSha, task.targetTreeSha], opts);
			const actualHash = crypto.createHash('sha256').update(patch).digest('hex');
			// Historical empty deltas may omit a hash; new completed revisions cannot.
			if (!task.patchHash || task.patchHash !== actualHash) {
				throw new SdlcError('INVALID_CONTRACT', `Closure task '${task.taskId}' delta hash mismatch`);
			}
			const files = String(gitCli('git', ['diff-tree', '-r', '--name-only', task.parentTreeSha, task.targetTreeSha], opts))
				.trim().split('\n').filter(Boolean);
			const paths = [
				...(task.authoredPaths ?? task.pathPrefixes),
				...(task.generatedOutputs ?? []),
				...(task.removedPaths ?? []),
			];
			for (const file of files) {
				if (!paths.some(prefix => file === prefix || file.startsWith(`${prefix.replace(/\/$/, '')}/`))) {
					throw new SdlcError('PATH_CONTAINMENT_VIOLATION', `Closure delta escapes task '${task.taskId}'`);
				}
			}
			if (patch.length) {
				try {
					const applyOptions = { ...opts, input: patch, stdio: ['pipe', 'pipe', 'pipe'] };
					gitCli('git', ['apply', '--cached', '--check', '--binary', '-'], applyOptions);
					gitCli('git', ['apply', '--cached', '--binary', '-'], applyOptions);
				} catch (cause) {
					throw new SdlcError('RECONCILIATION_CONFLICT', `Closure delta conflict for '${task.taskId}'`,
						{ taskId: task.taskId }, { cause });
				}
			}
		}
		const tree = String(gitCli('git', ['write-tree'], { ...opts, encoding: 'utf8' })).trim();
		if (!/^[a-f0-9]{40}$/.test(tree)) throw new SdlcError('INVALID_CONTRACT', 'Invalid closure tree');
		return tree;
	} finally {
		if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
		if (fs.existsSync(`${indexPath}.lock`)) fs.unlinkSync(`${indexPath}.lock`);
	}
}
