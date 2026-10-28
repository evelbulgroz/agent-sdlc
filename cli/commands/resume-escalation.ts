import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { OracleSnapshotItem } from '../../policy/contracts.ts';
import { SdlcError } from '../../policy/errors.ts';
import { isOraclePath } from '../../review/review-generation.ts';
import type { GitCliFn } from '../../workflow/git-manager.ts';

function gitText(
	gitCli: GitCliFn,
	args: readonly string[],
	options: Record<string, unknown>,
): string {
	const result = gitCli('git', args, options);
	return typeof result === 'string' ? result : result.toString('utf8');
}

export function snapshotWorktreeTree({
	worktreeDir,
	baseTreeSha,
	gitCli = execFileSync as GitCliFn,
}: {
	worktreeDir: string;
	baseTreeSha: string;
	gitCli?: GitCliFn;
}): string {
	const parentDir = path.dirname(worktreeDir);
	const tmpIndex = path.join(
		parentDir,
		`tmp-containment-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.index`,
	);
	try {
		const options = {
			cwd: worktreeDir,
			env: { ...process.env, GIT_INDEX_FILE: tmpIndex },
			stdio: ['ignore', 'pipe', 'pipe'] as const,
		};
		// Preserve ignored-but-tracked files when staging into the temporary index.
		gitCli('git', ['read-tree', baseTreeSha], options);
		gitCli('git', ['add', '-A'], {
			...options,
		});
		return gitText(gitCli, ['write-tree'], {
			...options,
			encoding: 'utf8',
		}).trim();
	} finally {
		fs.rmSync(tmpIndex, { force: true });
	}
}

export function verifyContainmentAndOracles({
	worktreeDir,
	auth,
	targetTreeSha,
	firstGen,
	gitCli = execFileSync as GitCliFn,
}: {
	worktreeDir: string;
	auth: { baseCommitSha: string; allowedPathPrefixes?: readonly string[] };
	targetTreeSha?: string | null;
	firstGen?: { oracleSnapshot?: readonly OracleSnapshotItem[] } | null;
	gitCli?: GitCliFn;
}): void {
	const baselineTreeSha = targetTreeSha || auth.baseCommitSha;
	const currentTreeSha = snapshotWorktreeTree({
		worktreeDir,
		baseTreeSha: baselineTreeSha,
		gitCli,
	});
	const diffOut = gitCli(
		'git',
		['diff-tree', '-r', '--name-only', baselineTreeSha, currentTreeSha],
		{
			cwd: worktreeDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	const changedFiles = String(diffOut ?? '')
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);

	if (changedFiles.length === 0) {
		try {
			const statusOut = gitCli('git', ['status', '--porcelain', '-uall'], {
				cwd: worktreeDir,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			for (const line of String(statusOut ?? '').split('\n')) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				const filePart = line.slice(3).trim();
				if (filePart.includes(' -> ')) {
					const renamedTarget = filePart.split(' -> ')[1];
					if (renamedTarget) changedFiles.push(renamedTarget.trim());
				} else {
					changedFiles.push(filePart);
				}
			}
		} catch {}
	}

	// 1. Authorization Containment
	const allowedPrefixes = auth.allowedPathPrefixes ?? [];
	for (const relPath of changedFiles) {
		const normalized = relPath.split(path.sep).join('/').replace(/^\.\//, '');
		const allowed = allowedPrefixes.some((prefix) => {
			const normPrefix = prefix.split(path.sep).join('/').replace(/^\.\//, '');
			return (
				normalized === normPrefix ||
				normalized.startsWith(normPrefix.endsWith('/') ? normPrefix : `${normPrefix}/`)
			);
		});
		if (!allowed) {
			throw new SdlcError(
				'SDLC_CONTAINMENT_VIOLATION',
				`File '${relPath}' is outside authorized path prefixes: ${allowedPrefixes.join(', ')}`,
				{ path: relPath, allowedPathPrefixes: allowedPrefixes.join(',') },
			);
		}
	}

	// 2. Oracle Invariant
	const frozenOracles = firstGen?.oracleSnapshot ?? [];
	for (const relPath of changedFiles) {
		if (isOraclePath(relPath)) {
			const fullPath = path.join(worktreeDir, relPath);
			let contentHash: string | null = null;
			if (fs.existsSync(fullPath)) {
				const content = fs.readFileSync(fullPath, 'utf8');
				contentHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
			}
			const frozen = frozenOracles.find((o) => o.path === relPath);
			if (!frozen || frozen.sha256 !== contentHash) {
				throw new SdlcError(
					'ORACLE_PATH_MODIFICATION_PROHIBITED',
					`Oracle test file '${relPath}' cannot be modified during human escalation`,
					{ path: relPath, expectedHash: frozen?.sha256, actualHash: contentHash },
				);
			}
		}
	}

	for (const frozen of frozenOracles) {
		const fullPath = path.join(worktreeDir, frozen.path);
		let contentHash: string | null = null;
		if (fs.existsSync(fullPath)) {
			const content = fs.readFileSync(fullPath, 'utf8');
			contentHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
		}
		if (frozen.sha256 !== contentHash) {
			throw new SdlcError(
				'ORACLE_PATH_MODIFICATION_PROHIBITED',
				`Oracle test file '${frozen.path}' cannot be modified or deleted during human escalation`,
				{ path: frozen.path, expectedHash: frozen.sha256, actualHash: contentHash },
			);
		}
	}
}
