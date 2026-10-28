#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPOSITORY_ROOT, archiveRoot } from '../persistence/run-paths.ts';
import type { GitCliFn } from '../workflow/git-manager.ts';

const SELF_FILENAME = fileURLToPath(import.meta.url);
const FALLBACK_CLI_PATH = path.join(
	path.dirname(SELF_FILENAME),
	path.extname(SELF_FILENAME) === '.js' ? 'cli.js' : 'cli.ts',
);

function gitText(
	gitCli: GitCliFn,
	args: readonly string[],
	options: Record<string, unknown>,
): string {
	const result = gitCli('git', args, options);
	return typeof result === 'string' ? result : result.toString('utf8');
}

export type AutoPruneResult =
	| {
			readonly triggered: false;
			readonly reason:
				| 'disabled-by-env'
				| 'ci-environment'
				| 'not-on-main'
				| 'linked-worktree'
				| 'error';
	  }
	| {
			readonly triggered: true;
			readonly reason: 'spawned';
			readonly logPath: string;
	  };

export interface AutoPruneFsLike {
	mkdirSync(dir: string, options?: fs.MakeDirectoryOptions): unknown;
	openSync(filePath: string, flags: string): number;
	closeSync(fd: number): void;
}

export type AutoPruneSpawnFn = (
	command: string,
	args: readonly string[],
	options?: Record<string, unknown>,
) => { unref?: () => void } | null | undefined;

export function runAutoPrune({
	rootDir = REPOSITORY_ROOT,
	env = process.env,
	gitCli = execFileSync as GitCliFn,
	spawnFn = spawn as AutoPruneSpawnFn,
	fsImpl = fs as AutoPruneFsLike,
}: {
	rootDir?: string;
	env?: NodeJS.ProcessEnv;
	gitCli?: GitCliFn;
	spawnFn?: AutoPruneSpawnFn;
	fsImpl?: AutoPruneFsLike;
} = {}): Readonly<AutoPruneResult> {
	try {
		if (env?.AGENT_SDLC_AUTO_PRUNE === '0') {
			return Object.freeze({ triggered: false, reason: 'disabled-by-env' });
		}
		if (env?.CI !== undefined && String(env.CI).trim() !== '') {
			return Object.freeze({ triggered: false, reason: 'ci-environment' });
		}

		const gitOpts = {
			cwd: rootDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		};
		const branch = gitText(gitCli, ['rev-parse', '--abbrev-ref', 'HEAD'], gitOpts).trim();
		if (branch !== 'main') {
			return Object.freeze({ triggered: false, reason: 'not-on-main' });
		}

		const gitDirRaw = gitText(gitCli, ['rev-parse', '--git-dir'], gitOpts).trim();
		const gitCommonDirRaw = gitText(gitCli, ['rev-parse', '--git-common-dir'], gitOpts).trim();
		const gitDir = path.resolve(rootDir, gitDirRaw);
		const gitCommonDir = path.resolve(rootDir, gitCommonDirRaw);
		if (gitDir !== gitCommonDir) {
			return Object.freeze({ triggered: false, reason: 'linked-worktree' });
		}

		const archiveDir = archiveRoot(rootDir);
		fsImpl.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
		const logPath = path.join(archiveDir, 'sweep.log');
		const logFd = fsImpl.openSync(logPath, 'a');
		try {
			const repoCliCandidate = path.join(rootDir, 'packages/agent-sdlc/cli/cli.ts');
			const cliPath = fs.existsSync(repoCliCandidate) ? repoCliCandidate : FALLBACK_CLI_PATH;
			const child = spawnFn(process.execPath, [cliPath, 'prune-runs'], {
				cwd: rootDir,
				detached: true,
				stdio: ['ignore', logFd, logFd],
				env,
			});
			child?.unref?.();
		} finally {
			try {
				fsImpl.closeSync(logFd);
			} catch {
				// Ignore close errors.
			}
		}

		return Object.freeze({
			triggered: true,
			reason: 'spawned',
			logPath,
		});
	} catch {
		return Object.freeze({ triggered: false, reason: 'error' });
	}
}

export function main(): Readonly<AutoPruneResult> {
	return runAutoPrune();
}

const invokedDirectly =
	process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	main();
}
