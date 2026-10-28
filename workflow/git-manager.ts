import { execFileSync } from 'node:child_process';
import { GIT_SHA } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

const SAFE_BRANCH_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;

export type GitCliFn = (
	command: string,
	args: readonly string[],
	options?: Record<string, unknown>,
) => string | Buffer;

function gitText(
	gitCli: GitCliFn,
	args: readonly string[],
	options: Record<string, unknown>,
): string {
	const result = gitCli('git', args, options);
	return typeof result === 'string' ? result : result.toString('utf8');
}

export function validateBranchName(branchName: unknown): string {
	if (
		typeof branchName !== 'string' ||
		!SAFE_BRANCH_NAME.test(branchName) ||
		branchName.includes('..') ||
		branchName.includes('//') ||
		branchName.includes('@{') ||
		branchName.endsWith('/') ||
		branchName.endsWith('.lock')
	) {
		throw new SdlcError('INVALID_INPUT', `Invalid git branch name: '${String(branchName)}'`);
	}
	return branchName;
}

export function checkBranchCollision({
	branchName,
	rootDir = REPOSITORY_ROOT,
	gitCli = execFileSync as GitCliFn,
}: {
	branchName: string;
	rootDir?: string;
	gitCli?: GitCliFn;
}): boolean {
	validateBranchName(branchName);

	// 1. Check if ref exists locally in repository
	let exists = false;
	try {
		gitCli('git', ['rev-parse', '--verify', `refs/heads/${branchName}`], {
			cwd: rootDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		exists = true;
	} catch {
		// Ref does not exist
	}

	if (exists) {
		throw new SdlcError(
			'BRANCH_ALREADY_EXISTS',
			`Local branch '${branchName}' already exists in repository`,
			{ branchName },
		);
	}

	// 2. Check if checked out in primary working tree or any worktree
	try {
		const worktreeList = gitText(gitCli, ['worktree', 'list', '--porcelain'], {
			cwd: rootDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const targetRef = `refs/heads/${branchName}`;
		for (const line of worktreeList.split('\n')) {
			if (line.startsWith('branch ') && line.slice('branch '.length).trim() === targetRef) {
				throw new SdlcError(
					'BRANCH_ALREADY_CHECKED_OUT',
					`Branch '${branchName}' is already checked out in a worktree`,
					{ branchName },
				);
			}
		}
	} catch (error: unknown) {
		if (error instanceof SdlcError) throw error;
	}

	return true;
}

export function createLocalBranch({
	worktreeDir,
	baseCommitSha,
	branchName,
	rootDir = REPOSITORY_ROOT,
	gitCli = execFileSync as GitCliFn,
}: {
	worktreeDir: string;
	baseCommitSha: string;
	branchName: string;
	rootDir?: string;
	gitCli?: GitCliFn;
}): { branchName: string; created: boolean; reused: boolean } {
	validateBranchName(branchName);
	if (typeof baseCommitSha !== 'string' || !GIT_SHA.test(baseCommitSha)) {
		throw new SdlcError('INVALID_INPUT', `Invalid base commit SHA: '${String(baseCommitSha)}'`);
	}

	// If worktree is already on branchName, reuse it
	try {
		const current = gitText(gitCli, ['branch', '--show-current'], {
			cwd: worktreeDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		}).trim();
		if (current === branchName) {
			return { branchName, created: false, reused: true };
		}
	} catch {
		// Continue to creation
	}

	checkBranchCollision({ branchName, rootDir, gitCli });

	try {
		gitCli('git', ['checkout', '-b', branchName, baseCommitSha], {
			cwd: worktreeDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { branchName, created: true, reused: false };
	} catch (error: unknown) {
		if (error instanceof SdlcError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new SdlcError(
			'WORKTREE_FAILED',
			`Failed to checkout new branch '${branchName}' at ${baseCommitSha}: ${message}`,
			{ branchName, baseCommitSha },
			{ cause: error },
		);
	}
}

export function formatCommitMessage({
	spec,
	decisions = [],
	repairs = 0,
	type = 'feat',
	scope = '',
}: {
	spec?: { goal?: string; owningContext?: string } | null;
	decisions?: readonly unknown[];
	repairs?: number;
	type?: string;
	scope?: string;
}): string {
	const goal = spec?.goal ?? 'automated implementation';
	const resolvedScope =
		scope ||
		(spec?.owningContext ? spec.owningContext.toLowerCase().replace(/[^a-z0-9-]+/g, '-') : '');

	const header = resolvedScope ? `${type}(${resolvedScope}): ${goal}` : `${type}: ${goal}`;

	const decisionItems =
		Array.isArray(decisions) && decisions.length > 0
			? decisions.map((d) => {
					if (typeof d === 'string') return `- ${d}`;
					if (d && typeof d === 'object') {
						const record = d as Record<string, unknown>;
						const topic = record.topic ?? record.field ?? 'standard';
						const chosen = record.chosen ?? record.value ?? 'default';
						return `- ${String(topic)}: ${String(chosen)}`;
					}
					return `- ${String(d)}`;
				})
			: ['- standard repository defaults applied'];

	const remainingItems = ['- none'];

	const triedItems =
		repairs > 0
			? [`- completed after ${repairs} semantic repair attempt(s)`]
			: ['- initial implementation passed'];

	return [
		header,
		'',
		'Decisions:',
		...decisionItems,
		'',
		'Remaining:',
		...remainingItems,
		'',
		'Tried:',
		...triedItems,
		'',
	].join('\n');
}

export type CreateLocalCommitResult =
	| {
			committed: false;
			reason: 'NO_CHANGES_STAGED';
			stagedFiles: string[];
	  }
	| {
			committed: true;
			commitSha: string;
			treeSha: string;
			parentSha: string;
			branchName: string;
			stagedFiles: string[];
	  };

export function createLocalCommit({
	worktreeDir,
	message,
	allowedPathPrefixes = [],
	allowedPackages = [],
	authorName = 'agent-sdlc',
	authorEmail = 'agent@sdlc.local',
	gitCli = execFileSync as GitCliFn,
}: {
	worktreeDir: string;
	message: string;
	allowedPathPrefixes?: readonly string[];
	allowedPackages?: readonly string[];
	authorName?: string;
	authorEmail?: string;
	gitCli?: GitCliFn;
}): CreateLocalCommitResult {
	const pathsToStage = allowedPathPrefixes.length > 0 ? allowedPathPrefixes : allowedPackages;
	if (pathsToStage.length === 0) {
		throw new SdlcError('PATH_CONTAINMENT_VIOLATION', 'No allowed paths specified for staging');
	}

	for (const p of pathsToStage) {
		try {
			gitCli('git', ['add', p], {
				cwd: worktreeDir,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch {
			// Path may not exist if newly added or deleted
		}
	}

	const stagedOutput = gitText(gitCli, ['diff', '--cached', '--name-only'], {
		cwd: worktreeDir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();

	const stagedFiles = stagedOutput
		? stagedOutput
				.split('\n')
				.map((f) => f.trim())
				.filter(Boolean)
		: [];

	if (stagedFiles.length === 0) {
		return {
			committed: false,
			reason: 'NO_CHANGES_STAGED',
			stagedFiles: [],
		};
	}

	// Verify path containment
	for (const file of stagedFiles) {
		const isAllowed = pathsToStage.some(
			(prefix) => file === prefix || file.startsWith(prefix.replace(/\/+$/, '') + '/'),
		);
		if (!isAllowed) {
			gitCli('git', ['reset'], {
				cwd: worktreeDir,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			throw new SdlcError(
				'PATH_CONTAINMENT_VIOLATION',
				`Staged file '${file}' is outside allowed paths: ${pathsToStage.join(', ')}`,
				{ file, pathsToStage },
			);
		}
	}

	const parentSha = gitText(gitCli, ['rev-parse', 'HEAD'], {
		cwd: worktreeDir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();

	const env = {
		...process.env,
		GIT_AUTHOR_NAME: authorName,
		GIT_AUTHOR_EMAIL: authorEmail,
		GIT_COMMITTER_NAME: authorName,
		GIT_COMMITTER_EMAIL: authorEmail,
	};

	try {
		gitCli('git', ['commit', '-m', message], {
			cwd: worktreeDir,
			env,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (error: unknown) {
		const errMessage = error instanceof Error ? error.message : String(error);
		throw new SdlcError(
			'GIT_COMMIT_FAILED',
			`Git commit execution failed: ${errMessage}`,
			{},
			{ cause: error },
		);
	}

	const commitSha = gitText(gitCli, ['rev-parse', 'HEAD'], {
		cwd: worktreeDir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();

	const treeSha = gitText(gitCli, ['rev-parse', 'HEAD^{tree}'], {
		cwd: worktreeDir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();

	const branchName = gitText(gitCli, ['branch', '--show-current'], {
		cwd: worktreeDir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();

	return {
		committed: true,
		commitSha,
		treeSha,
		parentSha,
		branchName,
		stagedFiles,
	};
}

export function pushBranch({
	worktreeDir,
	branchName,
	remote = 'origin',
	gitCli = execFileSync as GitCliFn,
}: {
	worktreeDir: string;
	branchName: string;
	remote?: string;
	gitCli?: GitCliFn;
}): { pushed: true; branchName: string; remote: string } {
	validateBranchName(branchName);
	if (typeof remote !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(remote)) {
		throw new SdlcError('INVALID_INPUT', `Invalid git remote name: '${String(remote)}'`);
	}

	try {
		gitCli('git', ['push', '-u', remote, branchName], {
			cwd: worktreeDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return {
			pushed: true,
			branchName,
			remote,
		};
	} catch (error: unknown) {
		if (error instanceof SdlcError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new SdlcError(
			'GIT_PUSH_FAILED',
			`Git push failed for branch '${branchName}' to remote '${remote}': ${message}`,
			{ branchName, remote },
			{ cause: error },
		);
	}
}
