import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { removeWorktree } from '../workflow/worktrees.ts';
import { REPOSITORY_ROOT, liveRunRoot } from './run-paths.ts';

export type GitCliFn = (
	command: string,
	args: readonly string[],
	options?: Record<string, unknown>,
) => string | Buffer;

export interface SkippedWorktreeEntry {
	worktreeDir: string;
	reason: string;
}

export interface CleanMergedWorktreesResult {
	runId: string;
	ok: boolean;
	skipped: boolean;
	removedWorktrees: readonly string[];
	skippedWorktrees: readonly SkippedWorktreeEntry[];
}

function errorMessageOf(error: unknown): string | undefined {
	if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
		return error.message;
	}
	return undefined;
}

function collectRunWorktreeDirs(runDir: string): string[] {
	const dirs: string[] = [];
	const singleDir = path.join(runDir, 'worktree');
	if (fs.existsSync(singleDir)) {
		dirs.push(singleDir);
	}
	const multiRoot = path.join(runDir, 'worktrees');
	if (fs.existsSync(multiRoot)) {
		try {
			const entries = fs
				.readdirSync(multiRoot, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
				.map((entry) => entry.name)
				.sort((left, right) => {
					if (left === 'integration') return 1;
					if (right === 'integration') return -1;
					return left.localeCompare(right);
				});
			for (const name of entries) {
				dirs.push(path.join(multiRoot, name));
			}
		} catch {
			// Ignore unreadable directory; handled below.
		}
	}
	return dirs;
}

function removeSingleWorktreeViaGit(
	runId: string,
	worktreeDir: string,
	{ rootDir, gitCli }: { rootDir: string; gitCli: GitCliFn },
): void {
	let removeError: unknown = null;
	const wrappedGitCli: GitCliFn = (command, args, options) => {
		const isWorktreeRemove =
			Array.isArray(args) && args.includes('worktree') && args.includes('remove');
		const isWorktreePrune =
			Array.isArray(args) && args.includes('worktree') && args.includes('prune');
		if (isWorktreeRemove) {
			try {
				return gitCli(command, args, options);
			} catch (error: unknown) {
				removeError = error;
				throw error;
			}
		}
		if (isWorktreePrune) {
			const pruneResult = gitCli(command, args, options);
			if (removeError || fs.existsSync(worktreeDir)) {
				const err: Error & { code?: string } = new Error(
					errorMessageOf(removeError) ||
						`Worktree directory remains after git worktree remove: ${worktreeDir}`,
				);
				err.code = 'WORKTREE_REMAINS';
				throw err;
			}
			return pruneResult;
		}
		return gitCli(command, args, options);
	};

	removeWorktree(runId, {
		rootDir,
		force: true,
		worktreeDir,
		gitCli: wrappedGitCli as typeof execFileSync,
	});
}

export function cleanMergedRunWorktrees(
	runId: string,
	{
		rootDir = REPOSITORY_ROOT,
		runDir = path.join(liveRunRoot(rootDir), runId),
		gitCli = execFileSync as GitCliFn,
	}: {
		rootDir?: string;
		runDir?: string;
		gitCli?: GitCliFn;
	} = {},
): Readonly<CleanMergedWorktreesResult> {
	const worktreeDirs = collectRunWorktreeDirs(runDir);
	const removed: string[] = [];
	const skipped: SkippedWorktreeEntry[] = [];

	for (const worktreeDir of worktreeDirs) {
		try {
			removeSingleWorktreeViaGit(runId, worktreeDir, { rootDir, gitCli });
			removed.push(worktreeDir);
		} catch (error: unknown) {
			skipped.push({
				worktreeDir,
				reason: errorMessageOf(error) ?? 'worktree-remove-failed',
			});
		}
	}

	const multiRoot = path.join(runDir, 'worktrees');
	if (fs.existsSync(multiRoot) && skipped.length === 0) {
		try {
			const remaining = fs.readdirSync(multiRoot);
			if (remaining.length === 0) {
				fs.rmdirSync(multiRoot);
			}
		} catch {
			// Leave non-empty container intact.
		}
	}

	try {
		gitCli('git', ['-C', rootDir, 'worktree', 'prune'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch {
		// Ignore final prune warning if gitCli already pruned.
	}

	return Object.freeze({
		runId,
		ok: skipped.length === 0,
		skipped: skipped.length > 0,
		removedWorktrees: Object.freeze(removed),
		skippedWorktrees: Object.freeze(skipped),
	});
}
