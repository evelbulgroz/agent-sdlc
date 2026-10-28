import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { withLockSync } from '@fitness-app/model-usage/atomic-file-state';
import { loadRunLedger } from '@fitness-app/model-usage/ledger';
import { SdlcError } from '../policy/errors.ts';
import { checkRunLanded, resolveRunTargetRef } from '../workflow/landed-check.ts';
import { type GitCliFn, cleanMergedRunWorktrees } from './run-cleanup.ts';
import { compactRunDatabase } from './run-compaction.ts';
import { REPOSITORY_ROOT, archiveRoot, liveRunRoot } from './run-paths.ts';
import {
	type RecordedRun,
	decideRunRetention,
	hasRunWorktrees,
	listRecordedRuns,
	readRecordedRun,
} from './run-retention.ts';

const LANDED_CHECK_STATES: ReadonlySet<string> = new Set(['DONE', 'READY_FOR_GIT_APPROVAL']);

export interface LedgerUsageBucket {
	calls: number; promptTokens: number; completionTokens: number; totalTokens: number; costMicrousd: number;
}

export interface RoleLedgerTotals {
	provider: LedgerUsageBucket;
	estimated: LedgerUsageBucket;
	tokenDetails: { cacheReadTokens: number | null; cacheWriteTokens: number | null; reasoningTokens: number | null };
}

export interface SummarizedLedgerTotals {
	byRole: Record<string, RoleLedgerTotals>;
}

export interface ArchiveIndexRecord {
	runId: string; state: string; createdAt: string; updatedAt: string; archivedAt: string; landed: boolean;
	approvedSpecHash: string | null; baseCommitSha: string | null; targetTreeSha: string | null;
	tasks: { taskId: string; status: string }[]; totals: SummarizedLedgerTotals | null;
}

export interface ArchiveRunResult {
	runId: string; archiveDir: string; indexRecord: ArchiveIndexRecord;
}

export interface SweepRunsResult {
	dryRun: boolean; locked: boolean;
	cleaned: readonly string[]; archived: readonly string[]; kept: readonly string[]; skipped: readonly string[];
}

export interface ArchiveSweepHooks {
	rootDir?: string;
	now?: number | string;
	gitCli?: GitCliFn;
	beforeVerify?: (targetPath: string) => void;
	afterRenameBeforeCleanup?: (info: { runId: string; finalDir: string; runDir: string }) => void;
}

interface RawChargeShape {
	physicalCalls?: number;
	promptTokens?: number;
	inputTokens?: number;
	completionTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	costMicrousd?: number | null;
}

interface RawSummaryEnvelope {
	operations?: Record<string, { profile?: string; attribution?: { roleId?: string } }>;
	attempts?: {
		operationId: string;
		usageSource?: string;
		estimatedCostMicrousd?: number;
		charge?: RawChargeShape;
		tokens?: RawChargeShape;
		tokenDetails?: {
			cacheReadTokens?: number | null;
			cacheWriteTokens?: number | null;
			reasoningTokens?: number | null;
		};
	}[];
}

function createEmptyBucket(): LedgerUsageBucket {
	return { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costMicrousd: 0 };
}

export function summarizeLedgerTotals(envelope: unknown): SummarizedLedgerTotals | null {
	if (!envelope || typeof envelope !== 'object') return null;
	const env = envelope as RawSummaryEnvelope;
	const operations = env.operations ?? {};
	const byRole: Record<string, RoleLedgerTotals> = {};
	for (const attempt of env.attempts ?? []) {
		const operation = operations[attempt.operationId];
		const roleId = operation?.attribution?.roleId ?? operation?.profile ?? 'unknown';
		if (!byRole[roleId]) {
			byRole[roleId] = {
				provider: createEmptyBucket(),
				estimated: createEmptyBucket(),
				tokenDetails: { cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null },
			};
		}
		const roleTotals = byRole[roleId];
		const bucket = attempt.usageSource === 'provider' ? roleTotals.provider : roleTotals.estimated;
		const charge = attempt.charge ?? attempt.tokens ?? {};
		bucket.calls += Number(charge.physicalCalls ?? 1);
		bucket.promptTokens += Number(charge.promptTokens ?? charge.inputTokens ?? 0);
		bucket.completionTokens += Number(charge.completionTokens ?? charge.outputTokens ?? 0);
		bucket.totalTokens += Number(charge.totalTokens ?? 0);
		bucket.costMicrousd +=
			typeof charge.costMicrousd === 'number'
				? charge.costMicrousd
				: Number(attempt.estimatedCostMicrousd ?? 0);
		for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
			const value = attempt.tokenDetails?.[key];
			if (typeof value === 'number' && Number.isFinite(value)) {
				roleTotals.tokenDetails[key] = (roleTotals.tokenDetails[key] ?? 0) + value;
			}
		}
	}
	return { byRole };
}

function resolveLedgerSourcePath(rootDir: string, runId: string): string | null {
	const liveLedger = path.join(rootDir, 'tools/.model-usage/runs', `${runId}.json`);
	if (fs.existsSync(liveLedger)) return liveLedger;
	const archivedLedger = path.join(rootDir, 'tools/.model-usage/archive', `${runId}.json`);
	return fs.existsSync(archivedLedger) ? archivedLedger : null;
}

function diffWorktreeOrTree(
	rootDir: string,
	baseCommitSha: string,
	{ worktreeDir, targetTreeSha, gitCli }: { worktreeDir: string | null; targetTreeSha: string | null; gitCli: GitCliFn },
): string | null {
	const opts = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
	if (worktreeDir && fs.existsSync(worktreeDir)) {
		gitCli('git', ['-C', worktreeDir, 'add', '-N', '.'], opts);
		return String(gitCli('git', ['-C', worktreeDir, 'diff', '--binary', baseCommitSha], opts));
	}
	if (targetTreeSha) {
		return String(gitCli('git', ['-C', rootDir, 'diff', '--binary', baseCommitSha, targetTreeSha], opts));
	}
	return null;
}

function buildUnlandedPatch(
	runRecord: RecordedRun,
	{ rootDir, targetTreeSha, gitCli }: { rootDir: string; targetTreeSha: string | null; gitCli: GitCliFn },
): string {
	const baseCommitSha = runRecord.baseCommitSha;
	if (!baseCommitSha) {
		throw new SdlcError('WORKTREE_FAILED', `Cannot generate unlanded.patch for ${runRecord.runId}: missing baseCommitSha`);
	}
	for (const candidate of [
		path.join(runRecord.runDir, 'worktrees', 'integration'),
		path.join(runRecord.runDir, 'worktree'),
	]) {
		if (!fs.existsSync(candidate)) continue;
		const patch = diffWorktreeOrTree(rootDir, baseCommitSha, { worktreeDir: candidate, targetTreeSha, gitCli });
		if (!patch || !patch.trim()) throw new SdlcError('WORKTREE_FAILED', `Empty unlanded.patch for ${runRecord.runId}`);
		return patch;
	}

	const multiWorktreesRoot = path.join(runRecord.runDir, 'worktrees');
	const taskMap = new Map((runRecord.dagTasks ?? []).map((task) => [task.task_id, task]));
	const taskIds = new Set(taskMap.keys());
	if (fs.existsSync(multiWorktreesRoot)) {
		for (const entry of fs.readdirSync(multiWorktreesRoot, { withFileTypes: true })) {
			if ((entry.isDirectory() || entry.isSymbolicLink()) && entry.name !== 'integration') {
				taskIds.add(entry.name);
			}
		}
	}
	const sortedTaskIds = [...taskIds].sort((left, right) => left.localeCompare(right));
	if (sortedTaskIds.length > 0) {
		const patches: string[] = [];
		for (const taskId of sortedTaskIds) {
			const taskRow = taskMap.get(taskId);
			const taskPatch = diffWorktreeOrTree(rootDir, taskRow?.base_commit_sha ?? baseCommitSha, {
				worktreeDir: path.join(multiWorktreesRoot, taskId),
				targetTreeSha: taskRow?.target_tree_sha ?? null,
				gitCli,
			});
			if (taskPatch && taskPatch.trim()) patches.push(`# task: ${taskId}\n${taskPatch}`);
		}
		const combined = patches.join('\n');
		if (!combined.trim()) throw new SdlcError('WORKTREE_FAILED', `Empty multi-task patch for ${runRecord.runId}`);
		return combined;
	}

	const patch = diffWorktreeOrTree(rootDir, baseCommitSha, { worktreeDir: null, targetTreeSha, gitCli });
	if (!patch || !patch.trim()) throw new SdlcError('WORKTREE_FAILED', `Cannot generate unlanded.patch for ${runRecord.runId}`);
	return patch;
}

function countFilesRecursive(dirPath: string): number {
	if (!fs.existsSync(dirPath)) return 0;
	let count = 0;
	for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
		const fullPath = path.join(dirPath, entry.name);
		if (entry.isDirectory()) count += countFilesRecursive(fullPath);
		else if (entry.isFile()) count += 1;
	}
	return count;
}

function appendIndexRecord(archiveRootDir: string, record: ArchiveIndexRecord): void {
	const indexPath = path.join(archiveRootDir, 'index.jsonl');
	if (fs.existsSync(indexPath)) {
		const lines = fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean);
		const exists = lines.some((line) => {
			try {
				return (JSON.parse(line) as { runId?: string })?.runId === record.runId;
			} catch {
				return false;
			}
		});
		if (exists) return;
	}
	fs.appendFileSync(indexPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function buildIndexRecord(
	runRecord: RecordedRun,
	{
		now,
		landed,
		targetTreeSha,
		totals,
	}: { now: number | string; landed: boolean | 'unknown'; targetTreeSha: string | null; totals: SummarizedLedgerTotals | null },
): ArchiveIndexRecord {
	return {
		runId: runRecord.runId,
		state: runRecord.state,
		createdAt: runRecord.createdAt,
		updatedAt: runRecord.updatedAt,
		archivedAt: typeof now === 'number' ? new Date(now).toISOString() : String(now),
		landed: Boolean(landed === true),
		approvedSpecHash: runRecord.approvedSpecHash ?? null,
		baseCommitSha: runRecord.baseCommitSha ?? null,
		targetTreeSha: targetTreeSha ?? runRecord.targetTreeSha ?? null,
		tasks: (runRecord.dagTasks ?? []).map((task) => ({ taskId: task.task_id, status: task.status })),
		totals,
	};
}

function finalizeLiveRunRemoval(runRecord: RecordedRun, { rootDir, gitCli }: { rootDir: string; gitCli: GitCliFn }): void {
	if (hasRunWorktrees(runRecord.runDir)) {
		const cleanup = cleanMergedRunWorktrees(runRecord.runId, { rootDir, runDir: runRecord.runDir, gitCli });
		if (cleanup.skipped || hasRunWorktrees(runRecord.runDir)) {
			throw new SdlcError('WORKTREE_FAILED', `Worktree removal incomplete while finalizing archive for ${runRecord.runId}`);
		}
	}
	fs.rmSync(runRecord.runDir, { recursive: true, force: true });
}

export function archiveRun(
	runRecord: RecordedRun,
	{
		rootDir = REPOSITORY_ROOT,
		now = new Date().toISOString(),
		landed = false,
		targetTreeSha = null,
		gitCli = execFileSync as GitCliFn,
		beforeVerify,
		afterRenameBeforeCleanup,
	}: ArchiveSweepHooks & { landed?: boolean | 'unknown'; targetTreeSha?: string | null } = {},
): Readonly<ArchiveRunResult> {
	const archiveRootDir = archiveRoot(rootDir);
	fs.mkdirSync(archiveRootDir, { recursive: true, mode: 0o700 });
	const partialDir = path.join(archiveRootDir, `${runRecord.runId}.partial`);
	const finalDir = path.join(archiveRootDir, runRecord.runId);
	if (fs.existsSync(partialDir)) fs.rmSync(partialDir, { recursive: true, force: true });

	const needsUnlandedPatch =
		LANDED_CHECK_STATES.has(runRecord.state) &&
		landed === false &&
		Boolean(runRecord.hasWorktree || runRecord.baseCommitSha || targetTreeSha);

	try {
		fs.mkdirSync(partialDir, { recursive: true, mode: 0o700 });
		if (needsUnlandedPatch) {
			const patchText = buildUnlandedPatch(runRecord, { rootDir, targetTreeSha, gitCli });
			const patchPath = path.join(partialDir, 'unlanded.patch');
			fs.writeFileSync(patchPath, patchText, 'utf8');
			if (!fs.existsSync(patchPath) || fs.statSync(patchPath).size === 0) {
				throw new SdlcError('WORKTREE_FAILED', `unlanded.patch is empty for ${runRecord.runId}`);
			}
		}

		compactRunDatabase(runRecord.databasePath, path.join(partialDir, 'runtime.sqlite'), { beforeVerify });

		const sourceArtifactsDir = path.join(runRecord.runDir, 'artifacts');
		if (fs.existsSync(sourceArtifactsDir)) {
			const targetArtifactsDir = path.join(partialDir, 'artifacts');
			fs.cpSync(sourceArtifactsDir, targetArtifactsDir, { recursive: true });
			if (countFilesRecursive(targetArtifactsDir) !== countFilesRecursive(sourceArtifactsDir)) {
				throw new SdlcError('ARTIFACT_CORRUPT', `Artifact count mismatch for ${runRecord.runId}`);
			}
		}

		for (const projectionFile of [
			'status.json',
			'intent.md',
			'decisions.md',
			'plan.md',
			'candidate-learnings.json',
		]) {
			const sourceProjectionPath = path.join(runRecord.runDir, projectionFile);
			if (fs.existsSync(sourceProjectionPath) && fs.lstatSync(sourceProjectionPath).isFile()) {
				fs.copyFileSync(sourceProjectionPath, path.join(partialDir, projectionFile));
			}
		}

		let totals: SummarizedLedgerTotals | null = null;
		const ledgerSourcePath = resolveLedgerSourcePath(rootDir, runRecord.runId);
		if (ledgerSourcePath) {
			totals = summarizeLedgerTotals(loadRunLedger(ledgerSourcePath));
			fs.copyFileSync(ledgerSourcePath, path.join(partialDir, 'ledger.json'));
		}

		const indexRecord = buildIndexRecord(runRecord, { now, landed, targetTreeSha, totals });
		if (!fs.existsSync(finalDir)) fs.renameSync(partialDir, finalDir);
		else fs.rmSync(partialDir, { recursive: true, force: true });

		appendIndexRecord(archiveRootDir, indexRecord);
		if (typeof afterRenameBeforeCleanup === 'function') {
			afterRenameBeforeCleanup({ runId: runRecord.runId, finalDir, runDir: runRecord.runDir });
		}
		finalizeLiveRunRemoval(runRecord, { rootDir, gitCli });
		return Object.freeze({ runId: runRecord.runId, archiveDir: finalDir, indexRecord });
	} catch (error: unknown) {
		if (fs.existsSync(partialDir)) fs.rmSync(partialDir, { recursive: true, force: true });
		throw error;
	}
}

function cleanupPartialAndHalfArchived(rootDir: string, { now, gitCli }: { now: number | string; gitCli: GitCliFn }): void {
	const archiveRootDir = archiveRoot(rootDir);
	if (!fs.existsSync(archiveRootDir)) return;
	for (const entry of fs.readdirSync(archiveRootDir, { withFileTypes: true })) {
		if (entry.isDirectory() && entry.name.endsWith('.partial')) {
			fs.rmSync(path.join(archiveRootDir, entry.name), { recursive: true, force: true });
			continue;
		}
		if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
		const runId = entry.name;
		const liveDir = path.join(liveRunRoot(rootDir), runId);
		if (!fs.existsSync(liveDir)) continue;
		const archivedRecord = readRecordedRun(path.join(archiveRootDir, runId), runId);
		const liveRecord = readRecordedRun(liveDir, runId);
		if (archivedRecord && liveRecord) {
			const ledgerPath = path.join(archiveRootDir, runId, 'ledger.json');
			let totals: SummarizedLedgerTotals | null = null;
			if (fs.existsSync(ledgerPath)) {
				try {
					totals = summarizeLedgerTotals(loadRunLedger(ledgerPath));
				} catch {
					totals = null;
				}
			}
			appendIndexRecord(
				archiveRootDir,
				buildIndexRecord(archivedRecord, { now, landed: false, targetTreeSha: null, totals }),
			);
			finalizeLiveRunRemoval(liveRecord, { rootDir, gitCli });
		}
	}
}

function executeSweepBody({
	rootDir,
	now,
	dryRun,
	gitCli,
	beforeVerify,
	afterRenameBeforeCleanup,
}: Required<Pick<ArchiveSweepHooks, 'rootDir' | 'now' | 'gitCli'>> &
	Pick<ArchiveSweepHooks, 'beforeVerify' | 'afterRenameBeforeCleanup'> & { dryRun: boolean }): Readonly<SweepRunsResult> {
	if (!dryRun) cleanupPartialAndHalfArchived(rootDir, { now, gitCli });
	const cleaned: string[] = [];
	const archived: string[] = [];
	const kept: string[] = [];
	const skipped: string[] = [];

	for (const runRecord of listRecordedRuns(rootDir)) {
		let targetTreeSha = runRecord.targetTreeSha;
		let landed: boolean | 'unknown' = false;
		if (LANDED_CHECK_STATES.has(runRecord.state)) {
			targetTreeSha = resolveRunTargetRef(runRecord, { rootDir, gitCli: gitCli as typeof execFileSync });
			if (runRecord.baseCommitSha && targetTreeSha) {
				landed = checkRunLanded({
					rootDir,
					baseCommitSha: runRecord.baseCommitSha,
					targetTreeSha,
					gitCli: gitCli as typeof execFileSync,
				});
			}
		}
		const decision = decideRunRetention({
			state: runRecord.state,
			updatedAt: runRecord.updatedAt,
			now,
			landed,
			hasWorktree: runRecord.hasWorktree,
		});
		if (decision.skipped) {
			skipped.push(runRecord.runId);
			kept.push(runRecord.runId);
		} else if (decision.action === 'clean-merged') {
			if (dryRun) {
				cleaned.push(runRecord.runId);
			} else {
				const cleanup = cleanMergedRunWorktrees(runRecord.runId, { rootDir, runDir: runRecord.runDir, gitCli });
				if (cleanup.skipped) skipped.push(runRecord.runId);
				else cleaned.push(runRecord.runId);
			}
		} else if (decision.action === 'archive') {
			if (dryRun) {
				archived.push(runRecord.runId);
			} else {
				try {
					archiveRun(runRecord, {
						rootDir,
						now,
						landed,
						targetTreeSha,
						gitCli,
						beforeVerify,
						afterRenameBeforeCleanup,
					});
					archived.push(runRecord.runId);
				} catch {
					skipped.push(runRecord.runId);
				}
			}
		} else {
			kept.push(runRecord.runId);
		}
	}

	return Object.freeze({
		dryRun: Boolean(dryRun),
		locked: false,
		cleaned: Object.freeze(cleaned),
		archived: Object.freeze(archived),
		kept: Object.freeze(kept),
		skipped: Object.freeze(skipped),
	});
}

export function sweepRuns({
	rootDir = REPOSITORY_ROOT,
	now = new Date().toISOString(),
	dryRun = false,
	gitCli = execFileSync as GitCliFn,
	beforeVerify,
	afterRenameBeforeCleanup,
}: ArchiveSweepHooks & { dryRun?: boolean } = {}): Readonly<SweepRunsResult> {
	if (dryRun) {
		return executeSweepBody({ rootDir, now, dryRun: true, gitCli, beforeVerify, afterRenameBeforeCleanup });
	}
	const archiveRootDir = archiveRoot(rootDir);
	fs.mkdirSync(archiveRootDir, { recursive: true, mode: 0o700 });
	const lockPath = path.join(archiveRootDir, 'sweep.lock');
	try {
		return withLockSync(
			lockPath,
			() => executeSweepBody({ rootDir, now, dryRun: false, gitCli, beforeVerify, afterRenameBeforeCleanup }),
			{ timeoutMs: 0 },
		);
	} catch (error: unknown) {
		const code =
			error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
				? error.code
				: undefined;
		const message =
			error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
				? error.message
				: '';
		if (code === 'LOCK_TIMEOUT' || /Timed out waiting to acquire lock/.test(message)) {
			return Object.freeze({
				dryRun: false,
				locked: true,
				cleaned: Object.freeze([]),
				archived: Object.freeze([]),
				kept: Object.freeze([]),
				skipped: Object.freeze(['sweep.lock']),
			});
		}
		throw error;
	}
}
