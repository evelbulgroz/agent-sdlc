import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type HostProfile, loadHostProfileOrFallback } from '../host/host-profile.ts';
import { validateGeneration, validateRunId, type GenerationRecord, type OracleSnapshotItem } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';

export type GenerationGitCliFn = (
	command: string,
	args: readonly string[],
	options: { cwd: string; encoding?: 'utf8'; env?: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'] },
) => unknown;

export interface ReviewGenerationStoreLike {
	saveGeneration?(record: Readonly<GenerationRecord>): unknown;
	getRun(runId: string): { runtimeRevision: number };
	getLatestGeneration(runId: string): Readonly<GenerationRecord> | null;
	recordReviewOutcome?(runId: string, generation: number, outcome: { reportHash: string; findingCount: number; hasP1: boolean }): { runtimeRevision: number };
	getAuthorization(runId: string): { maxSemanticRepairs?: number; allowedPathPrefixes?: readonly string[] } | null;
	getSemanticRepairsCount?(runId: string): number;
	incrementSemanticRepairs?(runId: string): unknown;
}

export type SemanticRepairResponse =
	| { kind: 'interrupt'; reason: 'HIGH_RISK_PATH_REPAIR_PROHIBITED' | 'ORACLE_PATH_REPAIR_PROHIBITED' | 'REPAIR_BUDGET_EXHAUSTED' }
	| { kind: 'accepted'; generation: number; targetTreeSha: string | null; retryCount: number; runtimeRevision: number };

export type HighRiskPathOptions =
	| string
	| Readonly<HostProfile>
	| { readonly rootDir?: string; readonly profile?: Readonly<HostProfile> };

function resolveHighRiskPathPrefixes(options?: HighRiskPathOptions): readonly string[] {
	if (typeof options === 'string') return loadHostProfileOrFallback(options).policy?.highRiskPaths ?? [];
	if (options && typeof options === 'object') {
		if ('schemaVersion' in options && 'adapter' in options) {
			return (options as Readonly<HostProfile>).policy?.highRiskPaths ?? [];
		}
		const optObj = options as { rootDir?: string; profile?: Readonly<HostProfile> };
		return (optObj.profile ?? loadHostProfileOrFallback(optObj.rootDir)).policy?.highRiskPaths ?? [];
	}
	return loadHostProfileOrFallback().policy?.highRiskPaths ?? [];
}

export const HIGH_RISK_PATH_PREFIXES: readonly string[] = Object.freeze([...resolveHighRiskPathPrefixes()]);

export function isHighRiskPath(targetPath: unknown, options?: HighRiskPathOptions): boolean {
	if (typeof targetPath !== 'string' || targetPath.trim().length === 0) return false;
	const normalized = targetPath.split(path.sep).join('/').replace(/^\.?\//, '').replace(/^\/+/, '');
	const prefixes = options !== undefined ? resolveHighRiskPathPrefixes(options) : HIGH_RISK_PATH_PREFIXES;
	return prefixes.some((prefix) => {
		const cleanPrefix = prefix.replace(/^\.?\//, '').replace(/\/+$/, '');
		return normalized === cleanPrefix || normalized.startsWith(`${cleanPrefix}/`);
	});
}

export function anyHighRiskPaths(paths: readonly unknown[] = [], options?: HighRiskPathOptions): boolean {
	return Array.isArray(paths) && paths.some((p) => isHighRiskPath(p, options));
}

export const hasHighRiskPaths = anyHighRiskPaths;

export function isOraclePath(targetPath: unknown): boolean {
	if (typeof targetPath !== 'string' || targetPath.trim().length === 0) return false;
	const normalized = targetPath.split(path.sep).join('/').replace(/^\.\//, '');
	return /\.oracle\.spec\.tsx?$/.test(normalized);
}

export function anyOraclePaths(paths: readonly unknown[] = []): boolean {
	return paths.some((p) => isOraclePath(p));
}

function changedOwnedPaths(opts: {
	worktreeDir: string;
	baseCommitSha: string;
	targetTreeSha: string;
	allowedPackages: readonly string[];
	allowedPathPrefixes: readonly string[];
	gitCli: GenerationGitCliFn;
}): string[] {
	const { worktreeDir, baseCommitSha, targetTreeSha, allowedPackages, allowedPathPrefixes, gitCli } = opts;
	const scopes = allowedPathPrefixes.length > 0 ? allowedPathPrefixes : allowedPackages;
	const output = gitCli(
		'git',
		['diff-tree', '--no-commit-id', '--name-only', '-r', baseCommitSha, targetTreeSha],
		{ cwd: worktreeDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
	);
	const changedPaths = String(output ?? '')
		.split('\n')
		.map((candidate) => candidate.trim().split(path.sep).join('/'))
		.filter(Boolean)
		.filter((candidate) =>
			scopes.some((scope) => {
				const normalizedScope = scope.split(path.sep).join('/').replace(/\/+$/, '');
				return candidate === normalizedScope || candidate.startsWith(`${normalizedScope}/`);
			}),
		)
		.sort();
	if (changedPaths.length > 0) return changedPaths;
	return scopes.map((scope) => (scope.endsWith('**') ? scope : scope.endsWith('/') ? `${scope}**` : `${scope}/**`));
}

export function collectOracleSnapshot({
	worktreeDir,
	targetTreeSha,
	allowedPathPrefixes = [],
	gitCli = execFileSync,
}: {
	worktreeDir: string;
	targetTreeSha?: string | null;
	allowedPathPrefixes?: readonly string[];
	gitCli?: GenerationGitCliFn;
}): readonly Readonly<OracleSnapshotItem>[] {
	const oracles: Readonly<OracleSnapshotItem>[] = [];
	try {
		if (targetTreeSha && typeof gitCli === 'function') {
			const out = gitCli('git', ['ls-tree', '-r', '--name-only', targetTreeSha], {
				cwd: worktreeDir,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			const lines = String(out ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
			for (const relativePath of lines) {
				if (!isOraclePath(relativePath)) continue;
				if (allowedPathPrefixes.length > 0) {
					const inAllowed = allowedPathPrefixes.some(
						(prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`),
					);
					if (!inAllowed) continue;
				}
				const fullPath = path.join(worktreeDir, relativePath);
				let contentHash: string | null = null;
				if (fs.existsSync(fullPath)) {
					const content = fs.readFileSync(fullPath, 'utf8');
					contentHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
				} else {
					try {
						const blob = gitCli('git', ['cat-file', '-p', `${targetTreeSha}:${relativePath}`], {
							cwd: worktreeDir,
							encoding: 'utf8',
							stdio: ['ignore', 'pipe', 'pipe'],
						});
						contentHash = crypto.createHash('sha256').update(String(blob ?? ''), 'utf8').digest('hex');
					} catch {
						contentHash = null;
					}
				}
				if (contentHash) {
					oracles.push(Object.freeze({ path: relativePath.split(path.sep).join('/'), sha256: contentHash }));
				}
			}
		} else {
			return scanFsOracles(worktreeDir, allowedPathPrefixes);
		}
	} catch {
		return scanFsOracles(worktreeDir, allowedPathPrefixes);
	}
	oracles.sort((a, b) => a.path.localeCompare(b.path));
	return Object.freeze(oracles);
}

function scanFsOracles(
	worktreeDir: string,
	allowedPathPrefixes: readonly string[] = [],
): readonly Readonly<OracleSnapshotItem>[] {
	const oracles: Readonly<OracleSnapshotItem>[] = [];
	if (!fs.existsSync(worktreeDir)) return Object.freeze(oracles);
	const prefixes = allowedPathPrefixes.length > 0 ? allowedPathPrefixes : [''];
	for (const prefix of prefixes) {
		const targetDir = path.join(worktreeDir, prefix);
		if (!fs.existsSync(targetDir)) continue;
		const stack: string[] = [targetDir];
		while (stack.length > 0) {
			const cur = stack.pop();
			if (!cur) continue;
			let entries: fs.Dirent[] = [];
			try {
				entries = fs.readdirSync(cur, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
				const full = path.join(cur, entry.name);
				if (entry.isDirectory()) {
					stack.push(full);
				} else if (entry.isFile()) {
					const rel = path.relative(worktreeDir, full).split(path.sep).join('/');
					if (isOraclePath(rel)) {
						try {
							const content = fs.readFileSync(full, 'utf8');
							const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
							oracles.push(Object.freeze({ path: rel, sha256: hash }));
						} catch {
							// Ignore
						}
					}
				}
			}
		}
	}
	oracles.sort((a, b) => a.path.localeCompare(b.path));
	return Object.freeze(oracles);
}

export function computeScopeFingerprint(
	worktreeDir: string,
	baseCommitSha: string | null | undefined,
	targetTreeSha: string,
	pkgPath: string,
	gitCli: GenerationGitCliFn = execFileSync,
): string {
	const normalizedPkg = pkgPath.replace(/\/+$/, '');
	const items = new Map<string, string>();

	try {
		const lsTree = String(
			gitCli('git', ['ls-tree', '-r', targetTreeSha, '--', normalizedPkg], {
				cwd: worktreeDir,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			}) ?? '',
		);
		for (const line of lsTree.split('\n')) {
			if (!line.trim()) continue;
			const [meta, filePath] = line.split('\t');
			if (!meta || !filePath) continue;
			const [mode, , blobSha] = meta.split(' ');
			items.set(filePath, `${filePath}\t${mode ?? ''}\t${blobSha ?? ''}`);
		}
	} catch {
		// Empty tree or missing path is handled safely
	}

	if (baseCommitSha) {
		try {
			const diffTree = String(
				gitCli(
					'git',
					['diff-tree', '-r', '--diff-filter=D', baseCommitSha, targetTreeSha, '--', normalizedPkg],
					{ cwd: worktreeDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
				) ?? '',
			);
			for (const line of diffTree.split('\n')) {
				if (!line.trim()) continue;
				const parts = line.split('\t');
				const filePath = parts[parts.length - 1];
				if (parts.length >= 2 && filePath) items.set(filePath, `${filePath}\t000000\tDELETED`);
			}
		} catch {
			// Ignore diff errors on initial commits
		}
	}

	const sortedKeys = [...items.keys()].sort();
	const lines = sortedKeys.map((k) => `${items.get(k) ?? ''}\n`).join('');
	return crypto.createHash('sha256').update(lines, 'utf8').digest('hex');
}

export function materializeGenerationTree(opts: {
	runId: string;
	worktreeDir: string;
	baseCommitSha: string;
	allowedPackages?: readonly string[];
	allowedPathPrefixes?: readonly string[];
	generation?: number;
	runtimeStore?: { saveGeneration(record: Readonly<GenerationRecord>): unknown } | null;
	gitCli?: GenerationGitCliFn;
}): Readonly<GenerationRecord> {
	const {
		runId,
		worktreeDir,
		baseCommitSha,
		allowedPackages = [],
		allowedPathPrefixes = [],
		generation = 0,
		runtimeStore,
		gitCli = execFileSync,
	} = opts;
	validateRunId(runId);
	if (!fs.existsSync(worktreeDir)) {
		throw new SdlcError('WORKTREE_FAILED', `Worktree directory does not exist: ${worktreeDir}`);
	}

	const parentDir = path.dirname(path.resolve(worktreeDir));
	const tmpIndex = path.join(parentDir, `tmp-${generation}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.index`);
	const gitEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };

	let targetTreeSha: string;
	try {
		if (fs.existsSync(tmpIndex)) fs.unlinkSync(tmpIndex);
		if (baseCommitSha) {
			gitCli('git', ['read-tree', baseCommitSha], { cwd: worktreeDir, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] });
		}
		gitCli('git', ['add', '-A'], { cwd: worktreeDir, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] });
		targetTreeSha = String(
			gitCli('git', ['write-tree'], { cwd: worktreeDir, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) ?? '',
		).trim();
	} finally {
		if (fs.existsSync(tmpIndex)) {
			try {
				fs.unlinkSync(tmpIndex);
			} catch {
				// Ignore cleanup failures
			}
		}
	}

	const scopeFingerprints: Record<string, string> = {};
	const scopesToFingerprint = allowedPackages.length > 0 ? allowedPackages : allowedPathPrefixes;
	for (const scope of scopesToFingerprint) {
		scopeFingerprints[scope] = computeScopeFingerprint(worktreeDir, baseCommitSha, targetTreeSha, scope, gitCli);
	}

	const taskOwnedPaths = changedOwnedPaths({
		worktreeDir,
		baseCommitSha,
		targetTreeSha,
		allowedPackages,
		allowedPathPrefixes,
		gitCli,
	});
	const oracleSnapshot = collectOracleSnapshot({ worktreeDir, targetTreeSha, allowedPathPrefixes, gitCli });

	const record = validateGeneration({
		schemaVersion: '1.0.0',
		runId,
		generation,
		baseCommitSha,
		targetTreeSha,
		scopeFingerprints,
		taskOwnedPaths,
		materializedAt: new Date().toISOString(),
		oracleSnapshot,
	});

	if (runtimeStore) runtimeStore.saveGeneration(record);
	return record;
}

export type RepairRequestedCallback = (info: {
	runId: string;
	generation: number;
	retryCount: number;
	findingIds: unknown;
}) => Promise<unknown>;

export class ReviewGenerationAdapter {
	runtimeStore: ReviewGenerationStoreLike;
	artifactStore: unknown;
	maxSemanticRepairs: number;
	onRepairRequested: RepairRequestedCallback;

	constructor({
		runtimeStore,
		artifactStore,
		maxSemanticRepairs = 2,
		onRepairRequested,
	}: {
		runtimeStore: ReviewGenerationStoreLike;
		artifactStore?: unknown;
		maxSemanticRepairs?: number;
		onRepairRequested?: RepairRequestedCallback;
	}) {
		if (!runtimeStore) throw new TypeError('runtimeStore is required');
		this.runtimeStore = runtimeStore;
		this.artifactStore = artifactStore;
		this.maxSemanticRepairs = maxSemanticRepairs;
		this.onRepairRequested = onRepairRequested ?? (async () => {});
	}

	async getCurrentGeneration(
		runId: string,
		expectedRuntimeRevision?: number | null,
	): Promise<{ generation: number; targetTreeSha: string; taskOwnedPaths: string[]; runtimeRevision: number }> {
		validateRunId(runId);
		const run = this.runtimeStore.getRun(runId);
		if (
			expectedRuntimeRevision !== undefined &&
			expectedRuntimeRevision !== null &&
			run.runtimeRevision !== expectedRuntimeRevision
		) {
			throw new SdlcError(
				'STORE_RECONCILIATION_FAILED',
				`Runtime revision mismatch: expected ${expectedRuntimeRevision}, found ${run.runtimeRevision}`,
				{ expected: expectedRuntimeRevision, actual: run.runtimeRevision },
			);
		}
		const latest = this.runtimeStore.getLatestGeneration(runId);
		if (!latest) throw new SdlcError('INVALID_TRANSITION', `No generations found for run '${runId}'`);
		return {
			generation: latest.generation,
			targetTreeSha: latest.targetTreeSha,
			taskOwnedPaths: [...latest.taskOwnedPaths],
			runtimeRevision: run.runtimeRevision,
		};
	}

	async recordReviewOutcome(
		runId: string,
		generation: number,
		reportHash: string,
		findingState?: { findingCount?: number; hasP1?: boolean; findings?: readonly unknown[] } | null,
	): Promise<{ runtimeRevision: number }> {
		validateRunId(runId);
		const hasP1 = Boolean(
			findingState?.hasP1 ??
				findingState?.findings?.some((f) => f && typeof f === 'object' && 'severity' in f && f.severity === 'P1'),
		);
		const outcome = this.runtimeStore.recordReviewOutcome?.(runId, generation, {
			reportHash,
			findingCount: findingState?.findingCount ?? findingState?.findings?.length ?? 0,
			hasP1,
		}) ?? { runtimeRevision: this.runtimeStore.getRun(runId).runtimeRevision };
		return { runtimeRevision: outcome.runtimeRevision };
	}

	async requestSemanticRepair(
		runId: string,
		generation: number,
		_reportHash: string,
		findingIds: unknown,
		scope?: string | readonly string[] | null,
	): Promise<SemanticRepairResponse> {
		validateRunId(runId);
		const run = this.runtimeStore.getRun(runId);
		const auth = this.runtimeStore.getAuthorization(runId);
		const ceiling = auth?.maxSemanticRepairs ?? this.maxSemanticRepairs;

		const scopeList = Array.isArray(scope) ? scope : typeof scope === 'string' ? [scope] : [];
		const authPaths = auth?.allowedPathPrefixes ?? [];
		const allRelevantPaths = scopeList.length > 0 ? scopeList : authPaths;

		if (anyHighRiskPaths(allRelevantPaths)) {
			return { kind: 'interrupt', reason: 'HIGH_RISK_PATH_REPAIR_PROHIBITED' };
		}
		if (allRelevantPaths.some(isOraclePath)) {
			return { kind: 'interrupt', reason: 'ORACLE_PATH_REPAIR_PROHIBITED' };
		}

		const currentRepairs = this.runtimeStore.getSemanticRepairsCount?.(runId) ?? 0;
		if (currentRepairs >= ceiling) {
			return { kind: 'interrupt', reason: 'REPAIR_BUDGET_EXHAUSTED' };
		}

		this.runtimeStore.incrementSemanticRepairs?.(runId);
		const latest = this.runtimeStore.getLatestGeneration(runId);
		await this.onRepairRequested({ runId, generation, retryCount: currentRepairs + 1, findingIds });

		return {
			kind: 'accepted',
			generation: latest ? latest.generation : generation,
			targetTreeSha: latest ? latest.targetTreeSha : null,
			retryCount: currentRepairs + 1,
			runtimeRevision: run.runtimeRevision,
		};
	}

	async resolveDisputedReview(
		runId: string,
		generation: number,
		resolution: string,
		{ findingIds = [], overrideAuthor = 'human-operator' }: { findingIds?: readonly string[]; overrideAuthor?: string } = {},
	): Promise<{
		status: 'resolved';
		resolution: string;
		runId: string;
		generation: number;
		findingIds: string[];
		overrideAuthor: string;
		runtimeRevision: number;
	}> {
		validateRunId(runId);
		if (!['withdrawn', 'override'].includes(resolution)) {
			throw new SdlcError('INVALID_CONTRACT', `Invalid dispute resolution: '${resolution}'`);
		}
		const run = this.runtimeStore.getRun(runId);
		return {
			status: 'resolved',
			resolution,
			runId,
			generation,
			findingIds: [...findingIds],
			overrideAuthor,
			runtimeRevision: run.runtimeRevision,
		};
	}
}
