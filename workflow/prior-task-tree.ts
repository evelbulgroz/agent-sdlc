// Checks a halted run's completed task out into the replacement worktree.
// Reads the prior run and writes only the new run's handoff file.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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

function repositoryRelative(entry: unknown): entry is string {
	if (typeof entry !== 'string' || !entry || entry.startsWith('-') || entry.startsWith('/') || entry.includes('\\')) {
		return false;
	}
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

function recordedCheckout(file: string): PriorTaskCheckout | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (error: unknown) {
		throw new SdlcError('INVALID_INPUT', 'Prior task handoff is not a recorded tree checkout', {}, { cause: error });
	}
	if (!parsed || typeof parsed !== 'object') {
		throw new SdlcError('INVALID_INPUT', 'Prior task handoff is not a recorded tree checkout');
	}
	const checkout = parsed as PriorTaskCheckout;
	if (!Array.isArray(checkout.authoredPaths) || checkout.authoredPaths.length === 0) return null;
	if (!TREE_SHA.test(checkout.targetTreeSha ?? '') || checkout.authoredPaths.some((entry) => !repositoryRelative(entry))) {
		throw new SdlcError('INVALID_INPUT', 'Prior task handoff is not a recorded tree checkout');
	}
	return checkout;
}

function handoffFile(rootDir: string, runId: string): string | null {
	if (!runId) return null;
	try {
		return priorTaskHandoffPath(rootDir, runId);
	} catch (error: unknown) {
		if (
			error instanceof SdlcError &&
			(error.code === 'INVALID_CONTRACT' || error.code === 'RUN_NOT_FOUND' || error.code === 'PATH_OUTSIDE_ROOT')
		) {
			return null;
		}
		throw error;
	}
}

function gitBytes(gitCli: GitCliFn, args: readonly string[], options: Record<string, unknown>): Buffer {
	try {
		const result = gitCli('git', args, options);
		if (typeof result === 'string') return Buffer.from(result);
		return Buffer.isBuffer(result) ? result : Buffer.alloc(0);
	} catch (error: unknown) {
		throw new SdlcError('WORKTREE_FAILED', 'Prior task parent overlay failed', {}, { cause: error });
	}
}

function indexInfoFromLsTree(raw: Buffer): Buffer | null {
	const chunks: Buffer[] = [];
	let start = 0;
	for (let index = 0; index <= raw.length; index += 1) {
		if (index !== raw.length && raw[index] !== 0) continue;
		const record = raw.subarray(start, index);
		start = index + 1;
		if (record.length === 0) continue;
		const tab = record.indexOf(0x09);
		const head = (tab < 0 ? '' : record.subarray(0, tab).toString('utf8')).split(' ');
		const mode = head[0] ?? '';
		const sha = head[2] ?? '';
		if (tab < 0 || !/^[0-7]{6}$/.test(mode) || !TREE_SHA.test(sha)) {
			throw new SdlcError('INVALID_INPUT', 'Prior task handoff is not a recorded tree checkout');
		}
		chunks.push(Buffer.from(`${mode} ${sha}\t`), record.subarray(tab + 1), Buffer.from([0]));
	}
	return chunks.length === 0 ? null : Buffer.concat(chunks);
}

/**
 * Base tree plus the recorded prior-task paths. A missing handoff returns null.
 * The temp index is not the repository index, and this does not move HEAD.
 */
export function overlayPriorCheckoutTree({
	rootDir,
	runId,
	baseTreeSha,
	gitCli = execFileSync as GitCliFn,
}: {
	rootDir: string;
	runId: string;
	baseTreeSha: string;
	gitCli?: GitCliFn;
}): string | null {
	if (!TREE_SHA.test(baseTreeSha)) return null;
	const file = handoffFile(rootDir, runId);
	if (!file || !fs.existsSync(file)) return null;
	const checkout = recordedCheckout(file);
	if (!checkout) return null;
	const tmpIndex = path.join(os.tmpdir(), `agent-sdlc-prior-${crypto.randomUUID()}`);
	const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
	const gitOptions = { cwd: rootDir, env, stdio: ['pipe', 'pipe', 'pipe'] };
	try {
		gitBytes(gitCli, ['read-tree', baseTreeSha], gitOptions);
		for (const entry of checkout.authoredPaths) {
			gitBytes(gitCli, ['rm', '-r', '--cached', '--ignore-unmatch', '--', entry], gitOptions);
			const listed = gitBytes(gitCli, ['ls-tree', '-r', '-z', checkout.targetTreeSha, '--', entry], gitOptions);
			const info = indexInfoFromLsTree(listed);
			if (!info) throw new SdlcError('INVALID_INPUT', 'Prior task handoff is not a recorded tree checkout');
			gitBytes(gitCli, ['update-index', '-z', '--index-info'], { ...gitOptions, input: info });
		}
		const treeSha = gitBytes(gitCli, ['write-tree'], gitOptions).toString('utf8').trim();
		if (!TREE_SHA.test(treeSha)) throw new SdlcError('WORKTREE_FAILED', 'Prior task parent overlay failed');
		return treeSha;
	} finally {
		fs.rmSync(tmpIndex, { force: true });
		fs.rmSync(`${tmpIndex}.lock`, { force: true });
	}
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
	const file = handoffFile(rootDir, runId);
	if (!file || !fs.existsSync(file)) return;
	const checkout = recordedCheckout(file);
	if (!checkout) return;
	try {
		// checkout -- pathspec updates files the prior tree has and leaves deletions behind.
		// Remove the path first so a directory prefix matches the overlay parent.
		gitCli('git', ['rm', '-r', '--ignore-unmatch', '--', ...checkout.authoredPaths], {
			cwd: worktreeDir,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		gitCli('git', ['checkout', checkout.targetTreeSha, '--', ...checkout.authoredPaths], {
			cwd: worktreeDir,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (error: unknown) {
		throw new SdlcError('WORKTREE_FAILED', 'Prior task checkout failed', {}, { cause: error });
	}
}
