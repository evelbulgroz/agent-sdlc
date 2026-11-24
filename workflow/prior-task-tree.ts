// Checks a halted run's completed task out into the replacement worktree.
// Reads the prior run and writes only the new run's handoff file.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { computeContinuation } from '../cli/continuation.ts';
import { projectHostInvocation } from '../cli/host-invocation.ts';
import { RuntimeStore } from '../persistence/runtime-store.ts';
import { resolveRunPaths } from '../persistence/run-paths.ts';
import type { TaskManifest } from '../policy/contracts/planning-schema.ts';
import { SdlcError } from '../policy/errors.ts';
import type { GitCliFn } from './git-manager.ts';

export interface PriorTaskCheckout {
	readonly priorRunId: string;
	readonly priorTaskId: string;
	readonly targetTreeSha: string;
	readonly authoredPaths: readonly string[];
}

const TREE_SHA = /^[a-f0-9]{40}$/;

function repositoryRelative(entry: string): boolean {
	if (!entry || entry.startsWith('-') || entry.startsWith('/') || entry.includes('\\')) return false;
	return entry.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function priorTaskFlags(
	priorRun: string | null | undefined,
	priorTask: string | null | undefined,
): { priorRunId: string; priorTaskId: string } | null {
	const priorRunId = typeof priorRun === 'string' ? priorRun.trim() : '';
	const priorTaskId = typeof priorTask === 'string' ? priorTask.trim() : '';
	if (!priorRunId && !priorTaskId) return null;
	if (!priorRunId || !priorTaskId) {
		throw new SdlcError('INVALID_INPUT', '--prior-run and --prior-task are required together');
	}
	return { priorRunId, priorTaskId };
}

function covers(completed: string, candidate: string): boolean {
	const base = completed.replace(/\/+$/, '');
	const prefix = candidate.replace(/\/+$/, '');
	if (!base || !prefix) return false;
	return prefix === base || prefix.startsWith(`${base}/`) || base.startsWith(`${prefix}/`);
}

export function omitCompletedAuthoredPaths(
	manifest: Readonly<TaskManifest> | null,
	completedPaths: readonly string[],
): Readonly<TaskManifest> | null {
	if (!manifest || completedPaths.length === 0) return manifest;
	const tasks = manifest.tasks.map((task) => {
		const outside = (entry: string) => !completedPaths.some((completed) => covers(completed, entry));
		const authoredPaths = task.authoredPaths.filter(outside);
		if (authoredPaths.length === 0) {
			throw new SdlcError('INVALID_INPUT', `Replacement task '${task.taskId}' has no authored paths outside the completed task`);
		}
		const generatedOutputs = Array.isArray(task.generatedOutputs) ? task.generatedOutputs.filter(outside) : task.generatedOutputs;
		return { ...task, authoredPaths, ...(generatedOutputs === undefined ? {} : { generatedOutputs }) };
	});
	return { ...manifest, tasks };
}

export function loadPriorTaskCheckout({
	rootDir,
	priorRunId,
	priorTaskId,
	gitCli = execFileSync as GitCliFn,
}: {
	rootDir: string;
	priorRunId: string;
	priorTaskId: string;
	gitCli?: GitCliFn;
}): PriorTaskCheckout {
	const paths = resolveRunPaths(priorRunId, rootDir, { mustExist: false });
	if (!fs.existsSync(paths.databasePath)) {
		throw new SdlcError('INVALID_INPUT', `Prior run '${priorRunId}' was not found`);
	}
	const store = new RuntimeStore(paths.databasePath);
	try {
		const state = store.getRun(priorRunId);
		const continuation = computeContinuation(state);
		const card = projectHostInvocation(state);
		if (card.retry.allowed) {
			throw new SdlcError('INVALID_INPUT', 'Prior run retry is still allowed');
		}
		if (continuation.reason !== 'HALTED') {
			throw new SdlcError('INVALID_INPUT', 'Prior run is not halted');
		}
		const plan = store.getTaskPlan(priorRunId);
		const task = plan?.tasks.find((item) => item.taskId === priorTaskId) ?? null;
		if (!task) throw new SdlcError('INVALID_INPUT', `Prior task '${priorTaskId}' was not found`);
		if (task.status !== 'completed') {
			throw new SdlcError('INVALID_INPUT', 'Prior task verification did not pass');
		}
		const targetTreeSha = task.targetTreeSha ?? '';
		if (!TREE_SHA.test(targetTreeSha)) {
			throw new SdlcError('INVALID_INPUT', 'Prior task targetTreeSha is missing');
		}
		const kind = gitObjectKind(gitCli, rootDir, targetTreeSha);
		if (kind !== 'tree') {
			throw new SdlcError('INVALID_INPUT', 'Prior task targetTreeSha is not a tree');
		}
		const authoredPaths = [...(task.authoredPaths ?? [])];
		if (authoredPaths.some((entry) => !repositoryRelative(entry))) {
			throw new SdlcError('INVALID_INPUT', 'Prior task authored path is not repository-relative');
		}
		return { priorRunId, priorTaskId, targetTreeSha, authoredPaths };
	} finally {
		store.close();
	}
}

function gitObjectKind(gitCli: GitCliFn, rootDir: string, sha: string): string | null {
	try {
		const result = gitCli('git', ['cat-file', '-t', sha], {
			cwd: rootDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return (typeof result === 'string' ? result : result.toString('utf8')).trim();
	} catch {
		return null;
	}
}

export function priorTaskHandoffPath(rootDir: string, runId: string): string {
	return path.join(resolveRunPaths(runId, rootDir, { mustExist: false }).runtimeDir, 'prior-task.json');
}

export function writePriorTaskHandoff(rootDir: string, runId: string, checkout: PriorTaskCheckout): void {
	fs.writeFileSync(priorTaskHandoffPath(rootDir, runId), `${JSON.stringify(checkout)}\n`, { mode: 0o600 });
}

export function checkoutRecordedPriorTask({
	rootDir,
	runId,
	worktreeDir,
	gitCli = execFileSync as GitCliFn,
}: {
	rootDir: string;
	runId: string;
	worktreeDir: string;
	gitCli?: GitCliFn;
}): void {
	const file = priorTaskHandoffPath(rootDir, runId);
	if (!fs.existsSync(file)) return;
	const checkout = JSON.parse(fs.readFileSync(file, 'utf8')) as PriorTaskCheckout;
	if (!Array.isArray(checkout.authoredPaths) || checkout.authoredPaths.length === 0) return;
	if (!TREE_SHA.test(checkout.targetTreeSha ?? '') || checkout.authoredPaths.some((entry) => !repositoryRelative(entry))) {
		throw new SdlcError('INVALID_INPUT', 'Prior task handoff is not a recorded tree checkout');
	}
	try {
		gitCli('git', ['checkout', checkout.targetTreeSha, '--', ...checkout.authoredPaths], {
			cwd: worktreeDir,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (error: unknown) {
		throw new SdlcError('WORKTREE_FAILED', 'Prior task checkout failed', {}, { cause: error });
	}
}
