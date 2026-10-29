import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ArtifactStore } from '../persistence/artifacts.ts';
import { SdlcWorkflowRuntime } from '../workflow/graph.ts';
import { RoleRegistry } from '../roles/role-registry.ts';
import { RuntimeStore } from '../persistence/runtime-store.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { FakeModelGovernor } from './fake-model-governor.mjs';
import { SdlcError } from '../policy/errors.ts';

// A test run writes runtime state keyed by its run id under the real
// repository root, not only under its fixture directory: worktree and
// hydration paths resolve against the root, critic reports go to
// tools/.review, and ledgers to tools/.model-usage.
function testRunLocations(runId) {
	return [
		path.join(REPOSITORY_ROOT, 'docs/specs/runs', runId),
		path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId),
		path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures', runId),
		path.join(REPOSITORY_ROOT, 'tools/.review', runId),
		path.join(REPOSITORY_ROOT, 'tools/.model-usage/runs', `${runId}.json`),
		path.join(REPOSITORY_ROOT, 'tools/.model-usage/archive', `${runId}.json`),
	];
}

export function removeTestRunArtifacts(runId) {
	for (const location of testRunLocations(runId)) {
		fs.rmSync(location, { recursive: true, force: true });
	}
}

const trackedTestRunTokens = new Set();

/**
 * Registers a test run id, or the random slug a CLI run id ends with, so the
 * process fails at exit if anything keyed by it is left behind.
 */
export function trackTestRun(token) {
	trackedTestRunTokens.add(token);
	return token;
}

export function findLeakedTestRunArtifacts(tokens = trackedTestRunTokens) {
	const leaked = [];
	if (tokens.size === 0) return leaked;
	const roots = [
		'docs/specs/runs',
		'tools/.agent-sdlc',
		'tools/.agent-sdlc/test-fixtures',
		'tools/.review',
		'tools/.model-usage/runs',
		'tools/.model-usage/archive',
	];
	for (const root of roots) {
		const directory = path.join(REPOSITORY_ROOT, root);
		if (!fs.existsSync(directory)) continue;
		for (const name of fs.readdirSync(directory)) {
			const base = name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
			for (const token of tokens) {
				if (base === token || base.endsWith(`-${token}`)) leaked.push(path.join(root, name));
			}
		}
	}
	return leaked;
}

process.once('exit', () => {
	const leaked = findLeakedTestRunArtifacts();
	if (leaked.length === 0) return;
	process.stderr.write(
		`agent-sdlc tests left run artifacts under the repository root:\n${leaked.map((entry) => `  ${entry}`).join('\n')}\n`,
	);
	process.exitCode = 1;
});

export function makeFixture(label, script = []) {
	const id = crypto.randomUUID().slice(0, 8);
	const safeLabel = label
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-|-$/g, '');
	const runId = trackTestRun(`${new Date().toISOString().slice(0, 10)}-${safeLabel}-${id}`);
	const runtimeDir = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures', runId);
	fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
	const store = new RuntimeStore(path.join(runtimeDir, 'runtime.sqlite'));
	const registry = new RoleRegistry({ rootDir: REPOSITORY_ROOT });
	const loaded = registry.load();
	const artifacts = new ArtifactStore({
		artifactsDir: path.join(runtimeDir, 'artifacts'),
		runtimeStore: store,
		maxArtifactBytes: loaded.workflow.limits.maxArtifactBytes,
	});
	const governor = new FakeModelGovernor(script);
	const runtime = new SdlcWorkflowRuntime({
		runtimeStore: store,
		artifactStore: artifacts,
		registry,
		governor,
	});
	return {
		runId,
		runtimeDir,
		store,
		registry,
		artifacts,
		governor,
		runtime,
		close() {
			try {
				store.close();
			} finally {
				removeTestRunArtifacts(runId);
			}
		},
	};
}

export function completeProposal(overrides = {}) {
	return {
		patch: [
			{ field: 'nonGoals', operation: 'set', value: ['Do not mutate code'] },
			{
				field: 'owningContext',
				operation: 'set',
				value: overrides.owningContext ?? 'Monorepo Tooling',
			},
			{
				field: 'touchedSurfaces',
				operation: 'set',
				value: overrides.touchedSurfaces ?? ['tools/example.mjs'],
			},
			{
				field: 'invariantsAndConstraints',
				operation: 'set',
				value: ['All model calls use the governor'],
			},
			{
				field: 'publicContractImpact',
				operation: 'set',
				value: 'No public API change',
			},
		],
		questions: [
			{
				questionId: 'acceptance',
				targets: ['acceptanceCriteria'],
				prompt: 'What observable outcome proves success?',
				responseKind: 'text',
				options: [],
				required: true,
				rationale: 'Acceptance criteria are missing.',
			},
			{
				questionId: 'failure',
				targets: ['failureDefenses'],
				prompt: 'What failure must fail closed?',
				responseKind: 'text',
				options: [],
				required: true,
				rationale: 'Failure defenses are missing.',
			},
			{
				questionId: 'verification',
				targets: ['verificationPlan'],
				prompt: 'How will the outcome be verified?',
				responseKind: 'text',
				options: [],
				required: true,
				rationale: 'Verification is missing.',
			},
		],
	};
}

export const EXAMPLE_ACCEPTANCE_CRITERION =
	'AC-01: An exact spec is approved. Given a complete grammatical draft and operator approval. Then approvedSpecHash equals the draft hash.';

export function grammaticalAcceptance(outcome) {
	const text = String(outcome).trim().replace(/\.+$/, '');
	return `AC-01: ${text}. Given the specification interview is complete. Then the operator may approve the draft.`;
}

export const CITING_SPEC_PATH = 'services/billing/src/feature.spec.ts';

export function citingSpecSource(acId = 'AC-01') {
	return `it('holds the approved outcome @ac ${acId}', () => {\n  expect(true).toBe(true);\n});\n`;
}

export function leanWriteAction(filePath, content) {
	return {
		action: {
			kind: 'tool_call',
			toolName: 'write_file',
			parameters: {
				path: filePath,
				content,
			},
		},
	};
}

export function leanReplaceAction(filePath, oldString, newString, expectedFileHash = '0'.repeat(64)) {
	return {
		action: {
			kind: 'tool_call',
			toolName: 'replace_in_file',
			parameters: {
				path: filePath,
				old_string: oldString,
				new_string: newString,
				expected_file_hash: expectedFileHash,
			},
		},
	};
}

export function programmerWriteAction(filePath, content, verificationCommand = null) {
	return {
		action: {
			kind: 'programmer_turn',
			edits: [
				{
					toolName: 'write_file',
					path: filePath,
					old_string: null,
					new_string: null,
					content,
				},
			],
			verificationCommand,
		},
	};
}

export function programmerReplaceAction(filePath, oldString, newString, verificationCommand = null) {
	return {
		action: {
			kind: 'programmer_turn',
			edits: [
				{
					toolName: 'replace_in_file',
					path: filePath,
					old_string: oldString,
					new_string: newString,
					content: null,
				},
			],
			verificationCommand,
		},
	};
}

export function programmerGatherAction(toolName, gatherPath, query = null) {
	return {
		action: {
			kind: 'programmer_turn',
			edits: [],
			verificationCommand: null,
			gather: {
				toolName,
				path: gatherPath,
				query,
			},
		},
	};
}

export function citingSpecWriteAction(specPath = CITING_SPEC_PATH, acId = 'AC-01') {
	return leanWriteAction(specPath, citingSpecSource(acId));
}

const CITING_SPEC_FILE = /\.(spec|test|e2e-spec)\.[cm]?[jt]sx?$/;

// A package test is green only after some spec in the worktree cites an
// acceptance criterion. The programmer role finishes on that green command,
// so a feature-only write must keep the role open.
export function worktreeCitesAcceptanceCriterion(cwd) {
	if (!cwd || !fs.existsSync(cwd)) return false;
	const stack = [cwd];
	while (stack.length > 0) {
		const current = stack.pop();
		let entries = [];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name === 'node_modules' || entry.name === '.git') continue;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (!CITING_SPEC_FILE.test(entry.name)) continue;
			try {
				if (/@ac\s+AC-/.test(fs.readFileSync(full, 'utf8'))) return true;
			} catch {
				// An unreadable file is not a citation.
			}
		}
	}
	return false;
}

export function uncitedPackageTestError(cmd, args = [], opts = {}) {
	if (cmd !== 'pnpm' || !args.includes('test')) return null;
	if (worktreeCitesAcceptanceCriterion(opts.cwd)) return null;
	const error = new Error('Command failed: pnpm test');
	error.status = 1;
	error.stdout = '';
	error.stderr = 'Missing @ac AC-01';
	return error;
}

export function seedCitingSpecs(worktreeDir, acId = 'AC-01') {
	if (!worktreeDir) return;
	const paths = [
		CITING_SPEC_PATH,
		'services/billing/src/feat1.spec.ts',
		'services/assessment/src/feat2.spec.ts',
		'services/authentication/src/feat2.spec.ts',
		'packages/shared-base/src/feature.spec.ts',
	];
	for (const relative of paths) {
		const absolute = path.join(worktreeDir, relative);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, citingSpecSource(acId));
	}
}

export function seedWorkspacePackageManifest(
	worktreeDir,
	packagePath = 'services/billing',
) {
	const source = path.join(REPOSITORY_ROOT, packagePath, 'package.json');
	const destination = path.join(worktreeDir, packagePath, 'package.json');
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	if (fs.existsSync(source)) {
		fs.copyFileSync(source, destination);
	} else {
		const pkgName = packagePath.startsWith('services/')
			? `@fixture/${path.basename(packagePath)}-service`
			: `@fixture/${path.basename(packagePath)}`;
		fs.writeFileSync(
			destination,
			JSON.stringify(
				{
					name: pkgName,
					version: '1.0.0',
					type: 'module',
					scripts: { test: 'pnpm test' },
					dependencies: { '@fixture/shared-base': 'workspace:*' },
				},
				null,
				2,
			) + '\n',
		);
	}
	for (const relFile of [
		'services/billing/src/main.ts',
		'packages/shared-base/src/index.ts',
	]) {
		const fullFile = path.join(worktreeDir, relFile);
		if (!fs.existsSync(fullFile)) {
			fs.mkdirSync(path.dirname(fullFile), { recursive: true });
			fs.writeFileSync(fullFile, 'export const ready = true;\n');
		}
	}
}

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

export function createSlice2SmartGovernor({
	failReview = false,
	failReviewFirstNCalls = 0,
} = {}) {
	let implementerCalls = 0;
	let reviewCalls = 0;
	let repairerCalls = 0;

	const handler = (request) => {
		const role = request.attribution?.roleId ?? request.role ?? 'drafter';
		if (role === 'critic-reviewer' || request.profile === 'critic-review') {
			const excluded = request.routingConstraints?.excludedVendors ?? [];
			const vendor = excluded.includes('openai') ? 'google' : 'openai';
			return {
				schemaVersion: '1.0.0',
				synthetic: true,
				output: { status: 'PASS', findings: [] },
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
				route: Object.freeze({
					routeId: 'fake-critic-route',
					provider: vendor,
					model: 'deterministic-json',
					canonicalVendor: vendor,
				}),
			};
		}
		if (role === 'drafter') {
			return {
				schemaVersion: '1.0.0',
				synthetic: true,
				output: completeProposal(),
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
			};
		}
		if (role === 'implementer') {
			implementerCalls++;
			const output =
				implementerCalls === 1
					? leanWriteAction('tools/example.mjs', 'export const feature = true;\n')
					: implementerCalls === 2
						? citingSpecWriteAction('tools/example.spec.mjs')
						: implementerCalls === 3
							? {
									action: {
										kind: 'tool_call',
										toolName: 'run_allowlisted_command',
										parameters: {
											command: 'pnpm',
											args: ['run', 'test:unit'],
										},
									},
								}
						: {
								action: {
									kind: 'complete',
									summary: 'Implemented billing feature',
								},
							};
			return {
				schemaVersion: '1.0.0',
				synthetic: true,
				output,
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
			};
		}
		if (role === 'reviewer') {
			reviewCalls++;
			const shouldFail =
				failReview || reviewCalls <= failReviewFirstNCalls;
			const output = shouldFail
				? {
						status: 'FAIL',
						summary: 'Review found P1 defect',
						findings: [
							{
								findingId: 'finding-1',
								severity: 'P1',
								category: 'correctness',
								path: 'services/billing/src/feature.ts',
								lineRange: [1, 1],
								evidence: 'export const feature = true;',
								failureMechanism: 'Must be number',
								remediation: 'Change to number',
							},
						],
					}
				: {
						status: 'PASS',
						summary: 'Review looks good',
						findings: [],
					};
			return {
				schemaVersion: '1.0.0',
				synthetic: true,
				output,
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
			};
		}
		if (role === 'repairer') {
			repairerCalls++;
			const output =
				repairerCalls === 1
					? leanWriteAction(
							'services/billing/src/feature.ts',
							'export const feature = 42;\n',
						)
					: {
							action: {
								kind: 'complete',
								summary: 'Repaired defect',
							},
						};
			return {
				schemaVersion: '1.0.0',
				synthetic: true,
				output,
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
			};
		}
		throw new SdlcError('UNKNOWN_ROLE', `Unexpected role: ${role}`);
	};

	return new FakeModelGovernor(Array(50).fill(handler));
}

export function multiPackageProposal(
	surfaces = ['packages/shared-base', 'services/billing'],
	owningContext = 'Monorepo Tooling',
) {
	const proposal = completeProposal();
	const touchedIdx = proposal.patch.findIndex((p) => p.field === 'touchedSurfaces');
	if (touchedIdx !== -1) {
		proposal.patch[touchedIdx].value = surfaces;
	}
	const contextIdx = proposal.patch.findIndex((p) => p.field === 'owningContext');
	if (contextIdx !== -1) {
		proposal.patch[contextIdx].value = owningContext;
	}
	return proposal;
}

export function createSlice4SmartGovernor({
	surfaces = ['packages/shared-base', 'services/billing'],
	failReview = false,
} = {}) {
	const taskCalls = new Map();
	let reviewCalls = 0;

	const handler = (request) => {
		const role = request.attribution?.roleId ?? request.role ?? 'drafter';
		if (role === 'critic-reviewer' || request.profile === 'critic-review') {
			const excluded = request.routingConstraints?.excludedVendors ?? [];
			const vendor = excluded.includes('openai') ? 'google' : 'openai';
			return {
				schemaVersion: '1.0.0',
				synthetic: true,
				output: { status: 'PASS', findings: [] },
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
				route: Object.freeze({
					routeId: 'fake-critic-route',
					provider: vendor,
					model: 'deterministic-json',
					canonicalVendor: vendor,
				}),
			};
		}
		if (role === 'drafter') {
			return {
				schemaVersion: '1.0.0',
				synthetic: true,
				output: multiPackageProposal(surfaces),
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
			};
		}
		if (role === 'implementer') {
			const taskId = request.attribution?.taskId || 'default';
			const callKey = `${taskId}:${role}`;
			const count = (taskCalls.get(callKey) || 0) + 1;
			taskCalls.set(callKey, count);
			const isChild =
				taskId.includes('billing') ||
				taskId === 'task-1' ||
				taskId === 'child-task';
			const targetPackage = isChild ? surfaces[1] : surfaces[0];
			const targetPath =
				targetPackage.endsWith('.ts') || targetPackage.endsWith('.mjs')
					? targetPackage
					: path.posix.join(targetPackage, 'src/feature.ts');
			const specPath = path.posix.join(path.posix.dirname(targetPath), 'feature.spec.ts');
			const output =
				count === 1
					? leanWriteAction(targetPath, `export const feature = '${taskId}';\n`)
					: count === 2
						? citingSpecWriteAction(specPath)
						: {
								action: {
									kind: 'complete',
									summary: `Implemented ${targetPath}`,
								},
							};
			return {
				schemaVersion: '1.0.0',
				synthetic: true,
				output,
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
			};
		}
		if (role === 'reviewer') {
			reviewCalls++;
			return {
				schemaVersion: '1.0.0',
				synthetic: true,
				output: {
					status: 'PASS',
					summary: 'All tasks passed unified review',
					findings: [],
				},
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
			};
		}
		throw new SdlcError('UNKNOWN_ROLE', `Unexpected role: ${role}`);
	};

	return new FakeModelGovernor(Array(50).fill(handler));
}
