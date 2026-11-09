import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { EXAMPLE_ACCEPTANCE_CRITERION, uncitedPackageTestError } from './test-support-fixtures.mjs';

export function answersForPending(pending, values = {}) {
	const request = values.request;
	return {
		schemaVersion: '1.0.0',
		interruptId: pending.interruptId,
		stateHash: pending.stateHash,
		answers: [
			{
				questionId: 'acceptance',
				value: values.acceptance ?? EXAMPLE_ACCEPTANCE_CRITERION,
			},
			{
				questionId: 'failure',
				value: values.failure ?? 'Stale responses are rejected',
			},
			{
				questionId: 'verification',
				value: values.verification ?? 'Run targeted tests',
			},
		],
		...(request ? { request } : {}),
	};
}

function collectRelativeTestPaths(root, current, names) {
	let entries = [];
	try {
		entries = fs.readdirSync(current, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
		const full = path.join(current, entry.name);
		if (entry.isDirectory()) {
			collectRelativeTestPaths(root, full, names);
			continue;
		}
		const relative = path.relative(root, full).split(path.sep).join('/');
		if (/\.(spec|test|e2e-spec)\.[cm]?[jt]sx?$/.test(relative)) names.add(relative);
	}
}

function collectAllRelativePaths(root, current, names) {
	let entries = [];
	try {
		entries = fs.readdirSync(current, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (
			entry.name === 'node_modules' ||
			entry.name === '.git' ||
			entry.name === 'dist' ||
			entry.name === '.cache' ||
			entry.name === '.mock-head'
		) {
			continue;
		}
		const full = path.join(current, entry.name);
		if (entry.isDirectory()) {
			collectAllRelativePaths(root, full, names);
			continue;
		}
		const relative = path.relative(root, full).split(path.sep).join('/');
		names.add(relative);
	}
}

export function createMockGitCli({
	baseCommitSha = 'a'.repeat(40),
	targetTreeSha = 'b'.repeat(40),
	commitSha = 'c'.repeat(40),
	// Distinct from targetTreeSha so task-executor's no-op-completion guard (comparing the
	// parent tree derived from baseCommitSha against the post-implementation write-tree result)
	// does not treat every scripted change as a no-op.
	parentTreeSha = '0'.repeat(40),
	initialHead = null,
	initialBranch = '',
	stagedPath = null,
	onWorktreeAdd,
} = {}) {
	let head = initialHead ?? baseCommitSha;
	let branch = initialBranch;
	const refs = new Set();
	if (initialBranch) refs.add(`refs/heads/${initialBranch}`);
	const worktreeHeads = new Map();
	const stagedPaths = new Set();
	// Shared by 'write-tree' and 'rev-parse HEAD^{tree}': the conventional single-task
	// worktree dir (".../worktree") keeps the documented default targetTreeSha, but any other
	// cwd (named task/integration subdirectories) gets a distinct, path-deterministic sha so
	// sibling/child tasks never collide, and a commit's HEAD^{tree} always matches what
	// write-tree produced for that same cwd.
	const treeShaForCwd = (cwd) => {
		const dirKey = cwd ? path.resolve(cwd) : '';
		return dirKey && path.basename(dirKey) !== 'worktree'
			? crypto.createHash('sha1').update(dirKey).digest('hex')
			: targetTreeSha;
	};
	return (cmd, args = [], opts = {}) => {
		if (cmd === 'git') {
			const sub = args[0];
			if (sub === 'rev-parse') {
				if (typeof args[1] === 'string' && args[1] === `${baseCommitSha}^{tree}`) {
					return `${parentTreeSha}\n`;
				}
				if (args[1] === 'HEAD^{tree}' || (typeof args[1] === 'string' && args[1].endsWith('^{tree}'))) {
					// Mirror write-tree's per-directory hashing (see below): after a commit,
					// HEAD^{tree} must equal whatever write-tree actually produced for this
					// cwd, not a single global constant, or multi-task integration-worktree
					// commits will spuriously fail the post-commit tree-sha verification.
					return `${treeShaForCwd(opts.cwd)}\n`;
				}
				if (args[1] === 'HEAD') {
					let cwdHead = opts.cwd ? worktreeHeads.get(path.resolve(opts.cwd)) : null;
					if (!cwdHead && opts.cwd) {
						const mockHeadFile = path.join(opts.cwd, '.mock-head');
						if (fs.existsSync(mockHeadFile)) {
							try {
								cwdHead = fs.readFileSync(mockHeadFile, 'utf8').trim();
							} catch {}
						}
					}
					return `${cwdHead ?? head}\n`;
				}
				if (args[1] === '--verify') {
					const ref = args[2];
					if (refs.has(ref)) {
						return `${head}\n`;
					}
					const error = new Error(`fatal: Needed a single revision`);
					error.status = 128;
					throw error;
				}
			}
			if (sub === 'branch' && args[1] === '--show-current') {
				return `${branch}\n`;
			}
			if (sub === 'checkout' && args[1] === '-b') {
				branch = args[2];
				refs.add(`refs/heads/${branch}`);
				if (args[3]) head = args[3];
				return '';
			}
			if (sub === 'add') {
				if (args[1] && args[1] !== '-A') {
					// `git add <dir>` recursively stages every file under that directory in
					// real git. Recording the bare directory string here would make later
					// `diff --cached --name-only` readers treat a directory name as a
					// "changed file", spuriously failing path-prefix containment checks for
					// other tasks/packages. Expand directory args to the files actually
					// present under them.
					const absTarget = opts.cwd ? path.resolve(opts.cwd, args[1]) : null;
					if (absTarget && fs.existsSync(absTarget) && fs.statSync(absTarget).isDirectory()) {
						collectAllRelativePaths(opts.cwd, absTarget, stagedPaths);
					} else {
						stagedPaths.add(args[1]);
					}
				}
				return '';
			}
			if (sub === 'commit') {
				head = commitSha;
				if (opts.cwd) {
					worktreeHeads.set(path.resolve(opts.cwd), commitSha);
					try {
						fs.writeFileSync(path.join(opts.cwd, '.mock-head'), commitSha);
					} catch {}
				}
				return '';
			}
			if (sub === 'commit-tree') {
				return `${commitSha ?? 'd'.repeat(40)}\n`;
			}
			if (sub === 'read-tree') {
				return '';
			}
			if (sub === 'apply') {
				return '';
			}
			if (sub === 'diff-index') {
				return '';
			}
			if (sub === 'worktree') {
				if (args[1] === 'add') {
					let targetDir;
					let targetSha;
					if (args[2] === '--detach') {
						targetDir = args[3];
						targetSha = args[4];
					} else {
						targetDir = args[2];
						targetSha = args[3];
					}
					fs.mkdirSync(targetDir, { recursive: true });
					if (targetSha) {
						worktreeHeads.set(path.resolve(targetDir), targetSha);
						try {
							fs.writeFileSync(path.join(targetDir, '.mock-head'), targetSha);
						} catch {}
					}
					onWorktreeAdd?.(targetDir);
					return '';
				}
				if (args[1] === 'remove') {
					const removeDir = args[args.length - 1];
					if (removeDir) {
						worktreeHeads.delete(path.resolve(removeDir));
						const mockHeadFile = path.join(removeDir, '.mock-head');
						if (fs.existsSync(mockHeadFile)) {
							try {
								fs.unlinkSync(mockHeadFile);
							} catch {}
						}
					}
					return '';
				}
				if (args[1] === 'list') {
					return '';
				}
			}
			if (sub === 'status') {
				return '';
			}
			if (sub === 'write-tree') {
				// Multi-task graphs chain write-tree results: a later task's parentTreeSha is
				// an earlier task's targetTreeSha. Returning one constant for every write-tree
				// call would make every task after the first look like a no-op (its target
				// would equal its inherited parent). Keep the conventional single-task
				// worktree dir (".../worktree") on the documented default targetTreeSha, but
				// derive a distinct, path-deterministic sha for named task subdirectories
				// (".../worktrees/<taskId>") so sibling/child tasks never collide - this must
				// be deterministic across process boundaries (crash/resume uses a fresh mock
				// instance), so it is derived from the resolved cwd rather than call order.
				return `${treeShaForCwd(opts.cwd)}\n`;
			}
			if (sub === 'ls-tree') {
				return '100644 blob cccc\tservices/billing/src/file.ts\n';
			}
			if (sub === 'diff-tree') {
				const names = new Set();
				// Only walk the real filesystem, and only honor the global stagedPath/
				// stagedPaths fixture hints (designed for `git diff --cached`, not per-tree
				// diffs), when scoped to a task worktree directory. Reconciliation
				// (reconciliation.mjs) runs this same subcommand with cwd=REPOSITORY_ROOT to
				// list files changed between two fake tree shas for ONE task; walking the
				// whole real repo there would report every real repo file (e.g.
				// '.agents/README.md') as "changed", and reusing the globally-accumulated
				// stagedPaths set (shared across every task's `git add <package>` call) would
				// leak other tasks'/packages' files into this task's containment check.
				const resolvedCwd = opts.cwd ? path.resolve(opts.cwd) : null;
				if (resolvedCwd && resolvedCwd !== path.resolve(REPOSITORY_ROOT) && fs.existsSync(resolvedCwd)) {
					if (stagedPath) names.add(stagedPath);
					for (const p of stagedPaths) names.add(p);
					collectAllRelativePaths(resolvedCwd, resolvedCwd, names);
				}
				return names.size > 0 ? `${[...names].join('\n')}\n` : '';
			}
			if (sub === 'diff' && args.includes('--name-only') && !args.includes('--cached')) {
				const names = new Set();
				if (stagedPath) names.add(stagedPath);
				if (opts.cwd && fs.existsSync(opts.cwd)) {
					collectRelativeTestPaths(opts.cwd, opts.cwd, names);
				}
				return names.size > 0 ? `${[...names].join('\n')}\n` : '';
			}
			if (sub === 'diff' && args.includes('--cached') && args.includes('--name-only')) {
				if (stagedPath !== null) {
					return `${stagedPath}\n`;
				}
				if (stagedPaths.size > 0) {
					return (
						Array.from(stagedPaths)
							.map((p) => (p.includes('.') ? p : path.posix.join(p, 'src/index.ts')))
							.join('\n') + '\n'
					);
				}
				return 'tools/example.mjs\n';
			}
			if (sub === 'diff') {
				return '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n+implemented\n';
			}
		}
		return '';
	};
}

export function createMockExecCli({
	baseCommitSha = 'a'.repeat(40),
	commitSha = null,
	assumeCommitted = false,
	preflightStatus = 'OK',
	failPreflightFirstNCalls = 0,
	gitCli = null,
	requireAcceptanceCitation = true,
} = {}) {
	let preflightCalls = 0;
	return (cmd, args = [], opts = {}) => {
		if (cmd === 'pnpm') {
			if (args.includes('agent:verify')) {
				preflightCalls++;
				const shouldFail =
					preflightStatus === 'FAIL' || preflightCalls <= failPreflightFirstNCalls;
				const status = shouldFail ? 'FAIL' : 'OK';
				const exitCode = shouldFail ? 1 : 0;
				let gitHeadSha = baseCommitSha;
				if (gitCli) {
					try {
						gitHeadSha = gitCli('git', ['rev-parse', 'HEAD'], { cwd: opts.cwd }).trim();
					} catch {
						gitHeadSha = baseCommitSha;
					}
				} else if (commitSha && !shouldFail && (assumeCommitted || preflightCalls >= 2)) {
					gitHeadSha = commitSha;
				}
				const preflightDir = path.join(opts.cwd || REPOSITORY_ROOT, 'tools');
				fs.mkdirSync(preflightDir, { recursive: true });
				fs.writeFileSync(
					path.join(preflightDir, '.agent-preflight-last.json'),
					JSON.stringify({
						status,
						canonical: !shouldFail,
						base: baseCommitSha,
						gitHeadSha,
						changeClass: 'A',
						exitCode,
					}),
				);
				if (shouldFail) {
					const error = new Error('Command failed: pnpm run agent:verify');
					error.status = 1;
					error.stdout = `agent-preflight: RESULT status=FAIL class=A sha=${baseCommitSha} exitCode=1 canonical=false\n`;
					error.stderr = 'preflight failed';
					throw error;
				}
				return `agent-preflight: RESULT status=OK class=A sha=${baseCommitSha} exitCode=0 canonical=true\n`;
			}
			if (requireAcceptanceCitation) {
				const uncited = uncitedPackageTestError(cmd, args, opts);
				if (uncited) throw uncited;
			}
			return 'OK\n';
		}
		return '';
	};
}
