import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { validateRunId } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { REPOSITORY_ROOT, resolveRunPaths } from '../persistence/run-paths.ts';
import type { GitCliFn } from './git-manager.ts';

function gitText(
	gitCli: GitCliFn,
	args: readonly string[],
	options: Record<string, unknown>,
): string {
	const result = gitCli('git', args, options);
	return typeof result === 'string' ? result : result.toString('utf8');
}

export function resolveWorktreeDir(
	runId: string,
	rootDir = REPOSITORY_ROOT,
	worktreeSubdir: string | null = null,
): string {
	validateRunId(runId);
	const paths = resolveRunPaths(runId, rootDir, { mustExist: false });
	if (worktreeSubdir && worktreeSubdir !== 'worktree') {
		return path.join(paths.runtimeDir, worktreeSubdir);
	}
	return path.join(paths.runtimeDir, 'worktree');
}

export function resolveTaskWorktreeDir(
	runId: string,
	taskId: string,
	rootDir = REPOSITORY_ROOT,
): string {
	validateRunId(runId);
	if (!taskId || typeof taskId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(taskId)) {
		throw new SdlcError('TASK_PLAN_INVALID', `Invalid taskId: ${String(taskId)}`, { taskId });
	}
	const paths = resolveRunPaths(runId, rootDir, { mustExist: false });
	return path.join(paths.runtimeDir, 'worktrees', taskId);
}

export function resolveIntegrationWorktreeDir(
	runId: string,
	rootDir = REPOSITORY_ROOT,
): string {
	validateRunId(runId);
	const paths = resolveRunPaths(runId, rootDir, { mustExist: false });
	return path.join(paths.runtimeDir, 'worktrees', 'integration');
}

export function createSyntheticCommit({
	parentTreeSha,
	baseCommitSha,
	message,
	rootDir = REPOSITORY_ROOT,
	gitCli = execFileSync as GitCliFn,
}: {
	parentTreeSha: string;
	baseCommitSha: string | readonly string[];
	message?: string;
	rootDir?: string;
	gitCli?: GitCliFn;
}): string {
	if (!parentTreeSha || !/^[a-f0-9]{40}$/.test(parentTreeSha)) {
		throw new SdlcError(
			'WORKTREE_FAILED',
			`Invalid parentTreeSha for synthetic commit: ${String(parentTreeSha)}`,
			{ parentTreeSha, baseCommitSha },
		);
	}
	const parents: readonly string[] = Array.isArray(baseCommitSha)
		? baseCommitSha
		: [baseCommitSha];
	for (const p of parents) {
		if (!p || !/^[a-f0-9]{40}$/.test(p)) {
			throw new SdlcError(
				'WORKTREE_FAILED',
				`Invalid baseCommitSha for synthetic commit: ${String(p)}`,
				{ parentTreeSha, baseCommitSha },
			);
		}
	}
	const commitMessage = message || `sdlc intermediate parent for ${parentTreeSha}`;

	try {
		const parentArgs = parents.flatMap((p) => ['-p', p]);
		const output = gitText(
			gitCli,
			['commit-tree', parentTreeSha, ...parentArgs, '-m', commitMessage],
			{
				cwd: rootDir,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		);
		const commitSha = output.trim();
		if (!/^[a-f0-9]{40}$/.test(commitSha)) {
			throw new SdlcError(
				'WORKTREE_FAILED',
				`git commit-tree returned invalid SHA: ${commitSha}`,
				{ parentTreeSha, baseCommitSha, commitSha },
			);
		}
		return commitSha;
	} catch (error: unknown) {
		if (error instanceof SdlcError) throw error;
		const errMessage = error instanceof Error ? error.message : String(error);
		throw new SdlcError(
			'WORKTREE_FAILED',
			`Failed to create synthetic commit for tree ${parentTreeSha}: ${errMessage}`,
			{ parentTreeSha, baseCommitSha },
			{ cause: error },
		);
	}
}

export function assertPathContained(worktreeDir: string, targetPath: string): string {
	const resolvedBase = path.resolve(worktreeDir);
	const resolvedTarget = path.isAbsolute(targetPath)
		? path.resolve(targetPath)
		: path.resolve(resolvedBase, targetPath);

	if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
		throw new SdlcError(
			'PATH_CONTAINMENT_VIOLATION',
			`Path '${targetPath}' escapes worktree root '${worktreeDir}'`,
			{ worktreeDir, targetPath, resolvedTarget },
		);
	}

	// Also verify realpath if it exists to catch symlink escapes
	if (fs.existsSync(resolvedTarget)) {
		const realBase = fs.realpathSync(resolvedBase);
		const realTarget = fs.realpathSync(resolvedTarget);
		if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) {
			throw new SdlcError(
				'PATH_CONTAINMENT_VIOLATION',
				`Real path '${realTarget}' escapes real worktree root '${realBase}'`,
				{ realBase, realTarget },
			);
		}
	}

	return resolvedTarget;
}

export interface CreateDetachedWorktreeOptions {
	runId: string;
	baseCommitSha: string;
	commitSha?: string | null;
	worktreeDir?: string | null;
	worktreeSubdir?: string | null;
	expectedCommitSha?: string | null;
	targetBranch?: string | null;
	rootDir?: string;
	gitCli?: GitCliFn;
}

export interface DetachedWorktreeResult {
	worktreeDir: string;
	baseCommitSha: string;
	commitSha: string;
	branch?: string | null;
	reused: boolean;
}

export function createDetachedWorktree({
	runId,
	baseCommitSha,
	commitSha = null,
	worktreeDir = null,
	worktreeSubdir = null,
	expectedCommitSha,
	targetBranch,
	rootDir = REPOSITORY_ROOT,
	gitCli = execFileSync as GitCliFn,
}: CreateDetachedWorktreeOptions): DetachedWorktreeResult {
	validateRunId(runId);
	const targetWorktreeDir = worktreeDir
		? path.resolve(worktreeDir)
		: resolveWorktreeDir(runId, rootDir, worktreeSubdir);
	const checkoutSha = commitSha ?? baseCommitSha;

	// Safe reuse on resume
	if (fs.existsSync(targetWorktreeDir)) {
		try {
			const headOutput = gitText(gitCli, ['rev-parse', 'HEAD'], {
				cwd: targetWorktreeDir,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			}).trim();

			const isMatchingHead = commitSha
				? headOutput === commitSha
				: headOutput === checkoutSha || headOutput === baseCommitSha;
			if (isMatchingHead) {
				const currentBranch = gitText(gitCli, ['branch', '--show-current'], {
					cwd: targetWorktreeDir,
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
				}).trim();
				return {
					worktreeDir: targetWorktreeDir,
					baseCommitSha,
					commitSha: headOutput,
					branch: currentBranch || null,
					reused: true,
				};
			}

			if (expectedCommitSha && headOutput === expectedCommitSha) {
				const currentBranch = gitText(gitCli, ['branch', '--show-current'], {
					cwd: targetWorktreeDir,
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
				}).trim();
				if (!targetBranch || currentBranch === targetBranch) {
					return {
						worktreeDir: targetWorktreeDir,
						baseCommitSha,
						commitSha: expectedCommitSha,
						branch: currentBranch || null,
						reused: true,
					};
				}
			}

			throw new SdlcError(
				'WORKTREE_FAILED',
				`Existing worktree at ${targetWorktreeDir} is checked out at ${headOutput}, expected ${expectedCommitSha ?? checkoutSha}`,
				{
					worktreeDir: targetWorktreeDir,
					expectedSha: expectedCommitSha ?? checkoutSha,
					actualSha: headOutput,
				},
			);
		} catch (error: unknown) {
			if (error instanceof SdlcError) throw error;
			throw new SdlcError(
				'WORKTREE_FAILED',
				`Failed to inspect existing worktree at ${targetWorktreeDir}`,
				{ worktreeDir: targetWorktreeDir },
				{ cause: error },
			);
		}
	}

	// Create new detached worktree
	try {
		fs.mkdirSync(path.dirname(targetWorktreeDir), { recursive: true, mode: 0o700 });
		gitCli('git', ['worktree', 'add', '--detach', targetWorktreeDir, checkoutSha], {
			cwd: rootDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		// Verify worktree HEAD
		const headSha = gitText(gitCli, ['rev-parse', 'HEAD'], {
			cwd: targetWorktreeDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		}).trim();

		if (headSha !== checkoutSha) {
			throw new SdlcError(
				'WORKTREE_FAILED',
				`Created worktree checked out at ${headSha}, expected ${checkoutSha}`,
				{ worktreeDir: targetWorktreeDir, expectedSha: checkoutSha, actualSha: headSha },
			);
		}

		return {
			worktreeDir: targetWorktreeDir,
			baseCommitSha,
			commitSha: checkoutSha,
			reused: false,
		};
	} catch (error: unknown) {
		if (error instanceof SdlcError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new SdlcError(
			'WORKTREE_FAILED',
			`Failed to create detached worktree at ${targetWorktreeDir}: ${message}`,
			{ worktreeDir: targetWorktreeDir, baseCommitSha, checkoutSha },
			{ cause: error },
		);
	}
}

export function isWorktreeClean(
	worktreeDir: string,
	{ gitCli = execFileSync as GitCliFn }: { gitCli?: GitCliFn } = {},
): boolean {
	try {
		const status = gitText(gitCli, ['status', '--porcelain'], {
			cwd: worktreeDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return status.trim().length === 0;
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		throw new SdlcError(
			'WORKTREE_FAILED',
			`Failed to check worktree status at ${worktreeDir}: ${message}`,
			{ worktreeDir },
			{ cause: error },
		);
	}
}

export function cleanWorktree(
	worktreeDir: string,
	{ gitCli = execFileSync as GitCliFn }: { gitCli?: GitCliFn } = {},
): void {
	try {
		gitCli('git', ['checkout', '--', '.'], {
			cwd: worktreeDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		gitCli('git', ['clean', '-fdx'], {
			cwd: worktreeDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		throw new SdlcError(
			'WORKTREE_FAILED',
			`Failed to clean worktree at ${worktreeDir}: ${message}`,
			{ worktreeDir },
			{ cause: error },
		);
	}
}

export function removeWorktree(
	runId: string,
	{
		rootDir = REPOSITORY_ROOT,
		force = false,
		worktreeDir = null,
		worktreeSubdir = null,
		gitCli = execFileSync as GitCliFn,
	}: {
		rootDir?: string;
		force?: boolean;
		worktreeDir?: string | null;
		worktreeSubdir?: string | null;
		gitCli?: GitCliFn;
	} = {},
): { removed: boolean } {
	validateRunId(runId);
	const targetDir = worktreeDir
		? path.resolve(worktreeDir)
		: resolveWorktreeDir(runId, rootDir, worktreeSubdir);

	if (!fs.existsSync(targetDir)) {
		return { removed: false };
	}

	if (!force && !isWorktreeClean(targetDir, { gitCli })) {
		throw new SdlcError(
			'WORKTREE_DIRTY',
			`Cannot remove dirty worktree at ${targetDir} without force option`,
			{ worktreeDir: targetDir },
		);
	}

	try {
		const args = ['worktree', 'remove'];
		if (force) args.push('--force');
		args.push(targetDir);

		try {
			gitCli('git', args, {
				cwd: rootDir,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (gitErr: unknown) {
			if (!force) throw gitErr;
		}

		gitCli('git', ['worktree', 'prune'], {
			cwd: rootDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		if (fs.existsSync(targetDir)) {
			fs.rmSync(targetDir, { recursive: true, force: true });
		}

		return { removed: true };
	} catch (error: unknown) {
		if (error instanceof SdlcError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new SdlcError(
			'WORKTREE_FAILED',
			`Failed to remove worktree at ${targetDir}: ${message}`,
			{ worktreeDir: targetDir },
			{ cause: error },
		);
	}
}
