// Pre-verification build preparation gate. Runs the selected prerequisite builds, in order, in the
// isolated worktree before consumer verification, independent of the installation/hydration cache.
// Evidence binds the ordered argv and outcomes to the candidate source digest; artifact existence is
// a postcondition only, never freshness evidence.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sanitize } from '@evelbulgroz/model-usage-govenor/sanitize-failure-text';
import { loadHostProfileOrFallback } from '../host/host-profile.ts';
import { createEvent } from '../policy/contracts.ts';
import {
	assertPreparationSelectionBinding,
	freezePreparationSelection,
	type PreparationPlanStep,
} from '../host/verification-preparation.ts';
import { type CommandExecFn, COMMAND_MAX_BUFFER_BYTES, ROLE_COMMAND_TIMEOUT_MS } from './tool-commands.ts';

export type PreparationPurpose = 'verification' | 'exploratory';

export type PreparationFailureReason =
	| 'build-failed'
	| 'timeout'
	| 'interrupted'
	| 'missing-output'
	| 'source-modified';

export interface PreparationStepEvidence {
	readonly id: string;
	readonly argv: readonly string[];
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly startedAt: string;
	readonly completedAt: string;
	readonly outputsVerified: boolean;
}

export interface PreparationEvidence {
	readonly schemaVersion: '1.0.0';
	readonly runId: string;
	readonly taskId: string;
	readonly worktreeDir: string;
	readonly preparationPolicyHash: string;
	readonly selectionHash: string;
	/** Digest of candidate source inputs (prerequisite packages and task scope), excluding declared outputs. */
	readonly candidateDigest: string;
	readonly status: 'passed' | 'failed';
	readonly steps: readonly PreparationStepEvidence[];
	readonly failure: { readonly stepId: string; readonly reason: PreparationFailureReason; readonly paths?: readonly string[] } | null;
	/** 'exploratory' for model-invoked commands: never verification evidence. */
	readonly purpose: PreparationPurpose;
}

export interface RunPreparationResult {
	readonly ok: boolean;
	readonly reason: PreparationFailureReason | null;
	/** Sanitized, bounded diagnostic output for the failed step; empty on success. */
	readonly output: string;
	/** Null when no builds were selected (no new commands ran). */
	readonly evidence: PreparationEvidence | null;
	/** The steps that were selected (empty when nothing applies). */
	readonly steps: readonly PreparationPlanStep[];
}

export interface RunPreparationInput {
	readonly execCli: CommandExecFn;
	readonly worktreeDir: string;
	readonly runId: string;
	readonly taskId: string;
	readonly steps: readonly PreparationPlanStep[];
	readonly preparationPolicyHash: string | null;
	readonly selectionHash: string | null;
	/** Extra candidate roots (e.g. the task's path prefixes) included in the source digest. */
	readonly candidateRoots?: readonly string[];
	readonly timeoutMs?: number;
	readonly clock?: () => number;
	/** Durable sink for evidence (passed or failed), e.g. an artifact writer. */
	readonly recordEvidence?: (evidence: PreparationEvidence) => void;
	readonly purpose?: PreparationPurpose;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.agent-sdlc', '.tmp']);
const HOUSEKEEPING = /\.tsbuildinfo$/;
const MAX_DIAGNOSTIC_CHARS = 20_000;

function joinRel(packagePath: string, rel: string): string {
	const clean = rel.replace(/\/+$/, '');
	return packagePath === '.' ? clean : `${packagePath}/${clean}`;
}

function declaredOutputs(steps: readonly PreparationPlanStep[]): string[] {
	return steps.flatMap((step) => step.outputPathPrefixes.map((output) => joinRel(step.packagePath, output)));
}

function isWithin(rel: string, prefix: string): boolean {
	return rel === prefix || rel.startsWith(`${prefix}/`);
}

/** Content hashes of source files under `roots`, excluding declared outputs and build housekeeping. */
export function snapshotCandidateSources(
	worktreeDir: string,
	roots: readonly string[],
	excludedPrefixes: readonly string[],
): Map<string, string> {
	const files = new Map<string, string>();
	const visit = (rel: string): void => {
		if (excludedPrefixes.some((prefix) => isWithin(rel, prefix))) return;
		const abs = rel === '.' ? worktreeDir : path.join(worktreeDir, rel);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(abs);
		} catch {
			return;
		}
		if (stat.isDirectory()) {
			for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
				if (SKIP_DIRS.has(entry.name)) continue;
				visit(rel === '.' ? entry.name : `${rel}/${entry.name}`);
			}
			return;
		}
		if (HOUSEKEEPING.test(rel)) return;
		const content = stat.isSymbolicLink() ? fs.readlinkSync(abs) : fs.readFileSync(abs);
		files.set(rel, crypto.createHash('sha256').update(content).digest('hex'));
	};
	for (const root of new Set(roots.map((root) => (root === '.' ? '.' : root.replace(/\/+$/, ''))))) visit(root);
	return files;
}

function digestOf(files: ReadonlyMap<string, string>): string {
	const hash = crypto.createHash('sha256');
	for (const rel of [...files.keys()].sort()) hash.update(`${rel}\0${files.get(rel)}\n`);
	return hash.digest('hex');
}

function changedPaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
	const changed = new Set<string>();
	for (const [rel, digest] of before) if (after.get(rel) !== digest) changed.add(rel);
	for (const rel of after.keys()) if (!before.has(rel)) changed.add(rel);
	return [...changed].sort();
}

export function candidateRootsFor(steps: readonly PreparationPlanStep[], extra: readonly string[] = []): string[] {
	return [...new Set([...steps.map((step) => step.packagePath), ...extra])].sort();
}

/** Recomputes the candidate digest; false means a source mutation invalidated the evidence. */
export function isPreparationEvidenceCurrent(
	evidence: PreparationEvidence | null,
	steps: readonly PreparationPlanStep[],
	candidateRoots: readonly string[] = [],
): boolean {
	if (!evidence || evidence.status !== 'passed') return false;
	const roots = candidateRootsFor(steps, candidateRoots);
	return digestOf(snapshotCandidateSources(evidence.worktreeDir, roots, declaredOutputs(steps))) === evidence.candidateDigest;
}

function runStep(
	execCli: CommandExecFn,
	step: PreparationPlanStep,
	worktreeDir: string,
	timeoutMs: number,
): { exitCode: number | null; signal: string | null; reason: PreparationFailureReason | null; output: string } {
	try {
		execCli(step.argv[0] ?? '', step.argv.slice(1), {
			cwd: worktreeDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: timeoutMs,
			maxBuffer: COMMAND_MAX_BUFFER_BYTES,
		});
		return { exitCode: 0, signal: null, reason: null, output: '' };
	} catch (error: unknown) {
		const err = (error ?? {}) as {
			status?: unknown; signal?: unknown; code?: unknown; message?: unknown;
			stdout?: { toString?: () => string }; stderr?: { toString?: () => string };
		};
		const signal = typeof err.signal === 'string' ? err.signal : null;
		const exitCode = typeof err.status === 'number' && Number.isInteger(err.status) ? err.status : null;
		const reason: PreparationFailureReason =
			err.code === 'ETIMEDOUT' ? 'timeout' : signal || err.code === 'INTERRUPTED' ? 'interrupted' : 'build-failed';
		const raw = `${err.stdout?.toString?.() ?? ''}${err.stderr?.toString?.() ?? ''}` || String(err.message ?? '');
		return { exitCode, signal, reason, output: sanitize(raw).slice(-MAX_DIAGNOSTIC_CHARS) };
	}
}

/**
 * Runs every selected step unconditionally, in order. Stops at the first failure; the caller must
 * not run consumer verification unless `ok` is true.
 */
export function runVerificationPreparation(input: RunPreparationInput): RunPreparationResult {
	const { steps, worktreeDir } = input;
	if (steps.length === 0) return { ok: true, reason: null, output: '', evidence: null, steps };
	if (!input.preparationPolicyHash || !input.selectionHash) {
		throw new Error('Verification preparation requires bound policy and selection hashes');
	}
	const clock = input.clock ?? Date.now;
	const timeoutMs = input.timeoutMs ?? ROLE_COMMAND_TIMEOUT_MS;
	const roots = candidateRootsFor(steps, input.candidateRoots ?? []);
	const outputs = declaredOutputs(steps);
	const before = snapshotCandidateSources(worktreeDir, roots, outputs);
	const records: PreparationStepEvidence[] = [];
	const finish = (
		failure: PreparationEvidence['failure'],
		output = '',
	): RunPreparationResult => {
		const evidence: PreparationEvidence = Object.freeze({
			schemaVersion: '1.0.0',
			runId: input.runId,
			taskId: input.taskId,
			worktreeDir,
			preparationPolicyHash: input.preparationPolicyHash as string,
			selectionHash: input.selectionHash as string,
			candidateDigest: digestOf(before),
			status: failure ? 'failed' : 'passed',
			steps: Object.freeze([...records]),
			failure,
			purpose: input.purpose ?? 'verification',
		});
		input.recordEvidence?.(evidence);
		return { ok: failure === null, reason: failure?.reason ?? null, output, evidence, steps };
	};
	for (const step of steps) {
		const startedAt = new Date(clock()).toISOString();
		const ran = runStep(input.execCli, step, worktreeDir, timeoutMs);
		const missing = ran.reason
			? []
			: step.outputPathPrefixes.filter((output) => !fs.existsSync(path.join(worktreeDir, joinRel(step.packagePath, output))));
		records.push({
			id: step.id,
			argv: [...step.argv],
			exitCode: ran.exitCode,
			signal: ran.signal,
			startedAt,
			completedAt: new Date(clock()).toISOString(),
			outputsVerified: !ran.reason && missing.length === 0,
		});
		if (ran.reason) return finish({ stepId: step.id, reason: ran.reason }, ran.output);
		if (missing.length > 0) {
			return finish(
				{ stepId: step.id, reason: 'missing-output', paths: missing },
				`Build '${step.id}' exited 0 but did not produce: ${missing.join(', ')}`,
			);
		}
		const modified = changedPaths(before, snapshotCandidateSources(worktreeDir, roots, outputs));
		if (modified.length > 0) {
			return finish(
				{ stepId: step.id, reason: 'source-modified', paths: modified },
				`Build '${step.id}' modified undeclared source paths: ${modified.join(', ')}`,
			);
		}
	}
	return finish(null);
}

export interface PrepareForVerificationInput
	extends Omit<RunPreparationInput, 'steps' | 'preparationPolicyHash' | 'selectionHash'> {
	/** The authorization envelope's preparationPolicyHash (absent for hosts without preparation). */
	readonly authorizedPolicyHash: string | null | undefined;
	/** `snapshot.preparationSelectionHash` frozen at plan time. */
	readonly frozenSelectionHash: string | null | undefined;
	/** All tasks of the frozen plan (the binding digest covers every task). */
	readonly planTasks: readonly { readonly taskId: string; readonly targetPackage: string }[];
	/** A task id, or 'final' for integration/committed-tree verification (union of all tasks). */
	readonly scope: string;
}

/**
 * Call-site entry point: reads the host policy from the execution worktree itself, fails closed when
 * it differs from the authorized policy or the frozen selection, then runs the applicable steps.
 */
export function prepareForVerification(input: PrepareForVerificationInput): RunPreparationResult {
	const profile = loadHostProfileOrFallback(input.worktreeDir);
	freezePreparationSelection(profile, input.authorizedPolicyHash, input.planTasks);
	const binding = assertPreparationSelectionBinding(
		profile.verificationPreparation,
		input.planTasks,
		input.frozenSelectionHash,
	);
	const plan = input.scope === 'final' ? binding.final : binding.tasks[input.scope];
	return runVerificationPreparation({
		...input,
		steps: plan?.steps ?? [],
		preparationPolicyHash: input.authorizedPolicyHash ?? null,
		selectionHash: plan?.selectionHash ?? null,
	});
}

export interface PreparationEvidenceSinkOptions {
	readonly runId: string;
	readonly runtimeRevision?: number;
	readonly artifactStore: { writeJson(kind: string, payload: Record<string, unknown>): string };
	readonly runtimeStore: { appendEvent(event: unknown): void };
	readonly now?: () => Date;
}

/** Persists evidence as an artifact plus a VERIFICATION_PREPARED event that status projections can read. */
export function preparationEvidenceSink(opts: PreparationEvidenceSinkOptions): (evidence: PreparationEvidence) => void {
	return (evidence) => {
		const artifact = opts.artifactStore.writeJson('verification-preparation', { ...evidence });
		opts.runtimeStore.appendEvent(
			createEvent({
				eventType: 'VERIFICATION_PREPARED',
				runId: opts.runId,
				runtimeRevision: opts.runtimeRevision ?? 0,
				causalId: `verification-prepared-${evidence.taskId}-${artifact}`,
				output: evidence,
				payload: {
					taskId: evidence.taskId,
					status: evidence.status,
					purpose: evidence.purpose,
					evidenceArtifact: artifact,
					preparationPolicyHash: evidence.preparationPolicyHash,
					selectionHash: evidence.selectionHash,
					candidateDigest: evidence.candidateDigest,
					failure: evidence.failure,
				},
				now: opts.now ?? (() => new Date()),
			}),
		);
	};
}

export interface TaskPreparationHookOptions extends Omit<PreparationEvidenceSinkOptions, 'runtimeRevision'> {
	readonly task: { readonly taskId: string; readonly pathPrefixes?: readonly string[] };
	readonly taskPlan: { readonly tasks: readonly { readonly taskId: string; readonly targetPackage: string }[] };
	readonly authorization?: object | null;
	readonly snapshot?: { readonly runtimeRevision?: number; readonly [key: string]: unknown } | null;
	readonly worktreeDir: string;
	readonly execCli: CommandExecFn;
	readonly purpose?: PreparationPurpose;
}

/** Builds the closure task verification calls before every verification invocation. */
export function taskPreparationHook(opts: TaskPreparationHookOptions): () => RunPreparationResult {
	const frozen = opts.snapshot?.preparationSelectionHash;
	const authorized = (opts.authorization as { preparationPolicyHash?: unknown } | null | undefined)?.preparationPolicyHash;
	return () =>
		prepareForVerification({
			execCli: opts.execCli,
			worktreeDir: opts.worktreeDir,
			runId: opts.runId,
			taskId: opts.task.taskId,
			scope: opts.task.taskId,
			planTasks: opts.taskPlan.tasks,
			authorizedPolicyHash: typeof authorized === 'string' ? authorized : null,
			frozenSelectionHash: typeof frozen === 'string' ? frozen : null,
			candidateRoots: opts.task.pathPrefixes ?? [],
			purpose: opts.purpose ?? 'verification',
			recordEvidence: preparationEvidenceSink({ ...opts, runtimeRevision: opts.snapshot?.runtimeRevision }),
		});
}

/**
 * Guard for model-invoked (exploratory) commands: builds before the first command, then rebuilds only
 * when the candidate digest changed since the last successful preparation. Returns null when nothing ran.
 */
export function exploratoryPreparationGuard(
	prepare: () => RunPreparationResult,
	candidateRoots: readonly string[] = [],
): () => RunPreparationResult | null {
	let last: RunPreparationResult | null = null;
	return () => {
		if (last?.ok && (last.steps.length === 0 || isPreparationEvidenceCurrent(last.evidence, last.steps, candidateRoots))) {
			return null;
		}
		last = prepare();
		return last.steps.length === 0 ? null : last;
	};
}

export interface TaskPreparationHooks {
	readonly prepareVerification: () => RunPreparationResult;
	readonly prepareExploratory: () => RunPreparationResult | null;
}

/** Both task hooks: unconditional before counted verification, freshness-guarded before model commands. */
export function taskPreparationHooks(opts: TaskPreparationHookOptions): TaskPreparationHooks {
	return {
		prepareVerification: taskPreparationHook(opts),
		prepareExploratory: exploratoryPreparationGuard(
			taskPreparationHook({ ...opts, purpose: 'exploratory' }),
			opts.task.pathPrefixes ?? [],
		),
	};
}

export interface FinalPreparationHookOptions extends PreparationEvidenceSinkOptions {
	readonly planTasks: readonly { readonly taskId: string; readonly targetPackage: string; readonly pathPrefixes?: readonly string[] }[];
	readonly authorizedPolicyHash: string | null | undefined;
	readonly frozenSelectionHash: string | null | undefined;
	readonly worktreeDir: string;
	readonly execCli: CommandExecFn;
}

/** Hook for integration preflight and committed-tree verification: the union of all tasks' builds. */
export function finalPreparationHook(opts: FinalPreparationHookOptions): () => RunPreparationResult {
	return () =>
		prepareForVerification({
			execCli: opts.execCli,
			worktreeDir: opts.worktreeDir,
			runId: opts.runId,
			taskId: 'final',
			scope: 'final',
			planTasks: opts.planTasks,
			authorizedPolicyHash: opts.authorizedPolicyHash,
			frozenSelectionHash: opts.frozenSelectionHash,
			candidateRoots: opts.planTasks.flatMap((task) => task.pathPrefixes ?? []),
			recordEvidence: preparationEvidenceSink(opts),
		});
}
