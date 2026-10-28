import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import type { GitCliFn } from './git-manager.ts';

interface DiffTreeChange {
	newSha: string;
	status: string;
	filePath: string;
}

function gitText(
	gitCli: GitCliFn,
	args: readonly string[],
	options: Record<string, unknown>,
): string {
	const result = gitCli('git', args, options);
	return typeof result === 'string' ? result : result.toString('utf8');
}

function parseDiffTreeOutput(rawOutput: unknown): DiffTreeChange[] {
	const changes: DiffTreeChange[] = [];
	for (const line of String(rawOutput ?? '').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const tabIndex = trimmed.indexOf('\t');
		if (tabIndex === -1) continue;
		const meta = trimmed.slice(0, tabIndex).trim().split(/\s+/);
		const filePath = trimmed.slice(tabIndex + 1).trim();
		if (meta.length < 5 || !filePath) continue;
		const newSha = meta[3] ?? '';
		const status = (meta[4] ?? '')[0] ?? '';
		changes.push({ newSha, status, filePath });
	}
	return changes;
}

function parseLsTreeOutput(rawOutput: unknown): Map<string, string> {
	const blobs = new Map<string, string>();
	for (const line of String(rawOutput ?? '').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const tabIndex = trimmed.indexOf('\t');
		if (tabIndex === -1) continue;
		const meta = trimmed.slice(0, tabIndex).trim().split(/\s+/);
		const filePath = trimmed.slice(tabIndex + 1).trim();
		if (meta.length < 3 || !filePath) continue;
		blobs.set(filePath, meta[2] ?? '');
	}
	return blobs;
}

export interface RunTargetRecordLike {
	targetTreeSha?: string | null;
	runDir?: string | null;
	branchName?: string | null;
}

export function resolveRunTargetRef(
	runRecord: RunTargetRecordLike | null | undefined,
	{
		rootDir = REPOSITORY_ROOT,
		gitCli = execFileSync as GitCliFn,
	}: {
		rootDir?: string;
		gitCli?: GitCliFn;
	} = {},
): string | null {
	if (typeof runRecord?.targetTreeSha === 'string' && runRecord.targetTreeSha.trim()) {
		return runRecord.targetTreeSha.trim();
	}
	const candidates = [
		path.join(runRecord?.runDir ?? '', 'worktrees', 'integration'),
		path.join(runRecord?.runDir ?? '', 'worktree'),
	];
	for (const dir of candidates) {
		if (!dir || !fs.existsSync(dir)) continue;
		try {
			const sha = gitText(gitCli, ['-C', dir, 'rev-parse', 'HEAD'], {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			}).trim();
			if (sha) return sha;
		} catch {
			// Try next candidate.
		}
	}
	if (typeof runRecord?.branchName === 'string' && runRecord.branchName.trim()) {
		try {
			const sha = gitText(
				gitCli,
				['-C', rootDir, 'rev-parse', '--verify', runRecord.branchName],
				{
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
				},
			).trim();
			if (sha) return sha;
		} catch {
			return null;
		}
	}
	return null;
}

export function checkRunLanded({
	rootDir = REPOSITORY_ROOT,
	baseCommitSha,
	targetTreeSha,
	mainRef = 'main',
	gitCli = execFileSync as GitCliFn,
}: {
	rootDir?: string;
	baseCommitSha?: string | null;
	targetTreeSha?: string | null;
	mainRef?: string;
	gitCli?: GitCliFn;
} = {}): boolean | 'unknown' {
	if (!baseCommitSha || !targetTreeSha) return false;
	let diffOutput: string | Buffer;
	try {
		diffOutput = gitCli(
			'git',
			[
				'-C',
				rootDir,
				'diff-tree',
				'-r',
				'--no-commit-id',
				'--no-renames',
				baseCommitSha,
				targetTreeSha,
			],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
		);
	} catch {
		return 'unknown';
	}
	const changes = parseDiffTreeOutput(diffOutput);
	if (changes.length === 0) return false;

	for (const change of changes) {
		if (change.status === 'D') continue;
		try {
			gitCli('git', ['-C', rootDir, 'cat-file', '-e', `${change.newSha}^{blob}`], {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch {
			return 'unknown';
		}
	}

	const paths = changes.map((change) => change.filePath);
	let lsTreeOutput: string | Buffer;
	try {
		lsTreeOutput = gitCli('git', ['-C', rootDir, 'ls-tree', mainRef, '--', ...paths], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch {
		return 'unknown';
	}
	const mainBlobs = parseLsTreeOutput(lsTreeOutput);
	for (const change of changes) {
		if (change.status === 'D') {
			if (mainBlobs.has(change.filePath)) return false;
			continue;
		}
		if (mainBlobs.get(change.filePath) !== change.newSha) {
			return false;
		}
	}
	return true;
}
