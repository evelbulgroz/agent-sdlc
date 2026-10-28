#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
	REPOSITORY_ROOT,
	archiveRoot,
	liveRunRoot,
} from '../persistence/run-paths.ts';

const TIMELINE_STEPS = 12;

export interface FailureTraceStep {
	stepIndex?: number;
	chosenAction?: string | null;
	diagnostics?: {
		restrictions?: Array<{ ruleId: string; removedTools: string[] }>;
		pruning?: {
			initialTokens?: number;
			finalTokens?: number;
			ceiling?: number;
			stages?: Array<{ stage: string }>;
		} | null;
		visibleSnapshots?: unknown[];
		model?: { routeId?: string } | null;
	};
	structuredRejection?: {
		code?: string;
		toolName?: string;
		message: string;
		remedyInNextPrompt?: boolean;
	} | null;
}

export interface FailureTraceArtifact {
	taskId: string;
	capturedAt?: string;
	failureClass?: string;
	reason?: string;
	failureFingerprint?: string | null;
	error?: { code: string; message: string } | null;
	wasteSummary?: unknown;
	whyNonProgress: {
		repeatedInputs?: unknown[];
		[key: string]: unknown;
	};
	lastFailingVerification?: {
		command: string;
		exitCode: number;
	} | null;
	steps?: FailureTraceStep[];
}

export interface LoadedFailureTrace {
	hash: string;
	trace: FailureTraceArtifact;
}

export interface SummarizedTrace {
	hash: string;
	taskId: string;
	failureClass: string;
	fingerprint: string | null;
	error: { code: string; message: string } | null;
	wasteSummary: unknown;
	whyNonProgress: FailureTraceArtifact['whyNonProgress'];
	lastFailingVerification: { command: string; exitCode: number } | null;
	timeline: string[];
}

export interface RunTraceSummary {
	runId: string;
	tasks: Array<{ task_id: string; status: string }>;
	callsByTask: Record<string, number>;
	traces: SummarizedTrace[];
}

export interface FingerprintAggregationGroup {
	fingerprint: string;
	failureClass: string;
	count: number;
	runs: string[];
	tasks: string[];
}

export interface AttemptTranscript {
	kind?: string;
	taskId?: string;
	attempt?: number;
	passed?: boolean;
	failureReason?: string;
	prompt?: string;
	toolCalls?: Array<{
		toolName: string;
		parameters?: Record<string, unknown>;
		result?: unknown;
	}>;
}

export function resolveTraceRunDir(rootDir: string, runId: string): string {
	const liveDir = path.join(liveRunRoot(rootDir), runId);
	if (fs.existsSync(liveDir)) return liveDir;
	const archivedDir = path.join(archiveRoot(rootDir), runId);
	if (fs.existsSync(archivedDir)) return archivedDir;
	return liveDir;
}

function readDb(runDir: string): DatabaseSync | null {
	const databasePath = path.join(runDir, 'runtime.sqlite');
	if (!fs.existsSync(databasePath)) return null;
	return new DatabaseSync(databasePath, { readOnly: true });
}

/** Failure traces are the artifacts that carry a whyNonProgress block. */
export function loadFailureTraces(runDir: string): LoadedFailureTrace[] {
	const artifactsDir = path.join(runDir, 'artifacts');
	if (!fs.existsSync(artifactsDir)) return [];
	const traces: LoadedFailureTrace[] = [];
	for (const name of fs.readdirSync(artifactsDir)) {
		if (!name.endsWith('.json')) continue;
		const text = fs.readFileSync(path.join(artifactsDir, name), 'utf8');
		if (!text.includes('"whyNonProgress"')) continue;
		try {
			const parsed: unknown = JSON.parse(text);
			if (parsed && typeof parsed === 'object' && 'whyNonProgress' in parsed && parsed.whyNonProgress) {
				traces.push({
					hash: name.replace(/\.json$/, ''),
					trace: parsed as FailureTraceArtifact,
				});
			}
		} catch {
			// Not a trace artifact.
		}
	}
	return traces.sort((a, b) =>
		String(a.trace.capturedAt).localeCompare(String(b.trace.capturedAt)),
	);
}

function describeAction(step: FailureTraceStep): string {
	if (!step.chosenAction) return '(no action)';
	try {
		const action = JSON.parse(step.chosenAction) as {
			toolName?: string;
			parameters?: { path?: unknown; command?: unknown };
		};
		const target = action.parameters?.path ?? action.parameters?.command ?? '';
		return `${String(action.toolName ?? '')} ${String(target).replace(/^apps\/services\//, '')}`.trim();
	} catch {
		return step.chosenAction.slice(0, 80);
	}
}

function timelineLines(trace: FailureTraceArtifact): string[] {
	return (trace.steps ?? []).slice(-TIMELINE_STEPS).map((step) => {
		const diag = step.diagnostics ?? {};
		const restrictions = (diag.restrictions ?? [])
			.map((r) => `${r.ruleId}-${r.removedTools.join('/')}`)
			.join(',');
		const pruned = (diag.pruning?.stages ?? []).map((stage) => stage.stage).join(',');
		const rejection = step.structuredRejection
			? ` REJECT[${step.structuredRejection.code ?? step.structuredRejection.toolName ?? ''}] ${step.structuredRejection.message.slice(0, 80)}${
					step.structuredRejection.remedyInNextPrompt === false
						? ' (remedy NOT shown next step)'
						: ''
				}`
			: '';
		const snapshots = (diag.visibleSnapshots ?? []).length;
		const tokens = diag.pruning
			? `${String(diag.pruning.initialTokens ?? '?')}->${String(diag.pruning.finalTokens ?? '?')}/${String(diag.pruning.ceiling ?? '?')}`
			: '?';
		const route = diag.model?.routeId ?? '?';
		return `  step ${String(step.stepIndex).padStart(3)} ${describeAction(step)} | tokens ${tokens} | snapshots ${snapshots} | route ${route}${
			restrictions ? ` | stripped ${restrictions}` : ''
		}${pruned ? ` | pruned ${pruned}` : ''}${rejection}`;
	});
}

export function summarizeRun({
	rootDir = REPOSITORY_ROOT,
	runId,
}: {
	rootDir?: string;
	runId: string;
}): RunTraceSummary {
	const runDir = resolveTraceRunDir(rootDir, runId);
	const db = readDb(runDir);
	if (!db) throw new Error(`No runtime store for run ${runId}`);
	try {
		const tasks = db
			.prepare('SELECT task_id, status FROM dag_tasks WHERE run_id = ? ORDER BY integration_order')
			.all(runId) as Array<{ task_id: string; status: string }>;
		const operations = db
			.prepare(
				`SELECT task_id, role_id, route_id, status, COUNT(*) AS calls FROM model_operations
				 WHERE run_id = ? GROUP BY task_id, role_id, route_id, status`,
			)
			.all(runId) as Array<{ task_id?: string | null; calls?: number }>;
		const callsByTask: Record<string, number> = {};
		for (const op of operations) {
			const key = op.task_id ?? '(run)';
			callsByTask[key] = (callsByTask[key] ?? 0) + (op.calls ?? 0);
		}
		const traces: SummarizedTrace[] = loadFailureTraces(runDir).map(({ hash, trace }) => ({
			hash,
			taskId: trace.taskId,
			failureClass: trace.failureClass ?? `non-progress:${String(trace.reason ?? '')}`,
			fingerprint: trace.failureFingerprint ?? null,
			error: trace.error ?? null,
			wasteSummary: trace.wasteSummary ?? null,
			whyNonProgress: trace.whyNonProgress,
			lastFailingVerification: trace.lastFailingVerification
				? {
						command: trace.lastFailingVerification.command,
						exitCode: trace.lastFailingVerification.exitCode,
					}
				: null,
			timeline: timelineLines(trace),
		}));
		return { runId, tasks, callsByTask, traces };
	} finally {
		db.close();
	}
}

/** Counts failure fingerprints across every local live and archived run to surface recurring pathologies. */
export function aggregateFingerprints({
	rootDir = REPOSITORY_ROOT,
}: {
	rootDir?: string;
} = {}): FingerprintAggregationGroup[] {
	const groups = new Map<
		string,
		{
			fingerprint: string;
			failureClass: string;
			count: number;
			runs: Set<string>;
			tasks: Set<string>;
		}
	>();
	const seenRuns = new Set<string>();
	for (const baseDir of [liveRunRoot(rootDir), archiveRoot(rootDir)]) {
		if (!fs.existsSync(baseDir)) continue;
		const entries = fs
			.readdirSync(baseDir, { withFileTypes: true })
			.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (
				!entry.isDirectory() ||
				entry.isSymbolicLink() ||
				entry.name.startsWith('.') ||
				entry.name === 'test-fixtures' ||
				entry.name.endsWith('.partial') ||
				seenRuns.has(entry.name)
			) {
				continue;
			}
			seenRuns.add(entry.name);
			for (const { trace } of loadFailureTraces(path.join(baseDir, entry.name))) {
				const fingerprint = trace.failureFingerprint ?? 'legacy';
				const group = groups.get(fingerprint) ?? {
					fingerprint,
					failureClass: trace.failureClass ?? `non-progress:${String(trace.reason ?? '')}`,
					count: 0,
					runs: new Set<string>(),
					tasks: new Set<string>(),
				};
				group.count += 1;
				group.runs.add(entry.name);
				group.tasks.add(trace.taskId);
				groups.set(fingerprint, group);
			}
		}
	}
	return [...groups.values()]
		.map((group) => ({ ...group, runs: [...group.runs], tasks: [...group.tasks] }))
		.sort((a, b) => b.count - a.count);
}

/** Per-attempt transcripts written by the minimal executor. */
export function loadAttemptTranscripts(runDir: string, taskId: string): AttemptTranscript[] {
	const artifactsDir = path.join(runDir, 'artifacts');
	if (!fs.existsSync(artifactsDir)) return [];
	const transcripts: AttemptTranscript[] = [];
	for (const name of fs.readdirSync(artifactsDir)) {
		if (!name.endsWith('.json')) continue;
		try {
			const value: unknown = JSON.parse(fs.readFileSync(path.join(artifactsDir, name), 'utf8'));
			if (
				value &&
				typeof value === 'object' &&
				'kind' in value &&
				value.kind === 'minimal-executor-attempt' &&
				'taskId' in value &&
				value.taskId === taskId
			) {
				transcripts.push(value as AttemptTranscript);
			}
		} catch {
			// Skip non-transcript JSON.
		}
	}
	return transcripts.sort((left, right) => (left.attempt ?? 0) - (right.attempt ?? 0));
}

export function renderAttemptTranscripts(
	transcripts: readonly AttemptTranscript[],
	taskId: string,
): string {
	const lines = [`Task ${taskId}`];
	for (const item of transcripts) {
		lines.push(`Attempt ${String(item.attempt)} ${item.passed === true ? 'passed' : 'failed'}`);
		if (item.passed !== true) lines.push(`failure reason: ${String(item.failureReason ?? '')}`);
		lines.push('prompt:', item.prompt ?? '');
		for (const call of item.toolCalls ?? []) {
			lines.push(`tool ${call.toolName} ${JSON.stringify(call.parameters ?? {})}`);
			lines.push(`result ${JSON.stringify(call.result ?? null)}`);
		}
	}
	return lines.join('\n');
}

export function renderSummary(summary: RunTraceSummary): string {
	const lines = [`Run ${summary.runId}`, 'Tasks:'];
	for (const task of summary.tasks) {
		lines.push(
			`  ${task.task_id}: ${task.status} (${summary.callsByTask[task.task_id] ?? 0} model calls)`,
		);
	}
	for (const trace of summary.traces) {
		lines.push(
			'',
			`Failure ${trace.failureClass} [${String(trace.fingerprint)}] task=${trace.taskId} trace=${trace.hash.slice(0, 12)}`,
		);
		if (trace.error) {
			lines.push(`  error: ${trace.error.code}: ${trace.error.message.slice(0, 200)}`);
		}
		if (trace.wasteSummary) lines.push(`  activity: ${JSON.stringify(trace.wasteSummary)}`);
		lines.push(`  repeated: ${JSON.stringify(trace.whyNonProgress.repeatedInputs?.slice(0, 3))}`);
		if (trace.lastFailingVerification) {
			lines.push(`  last failing verification: ${trace.lastFailingVerification.command}`);
		}
		lines.push('  last steps:', ...trace.timeline);
	}
	return lines.join('\n');
}

export function main(args: readonly string[] = process.argv.slice(2)): void {
	const json = args.includes('--json');
	const runIndex = args.indexOf('--run');
	const taskIndex = args.indexOf('--task');
	const runArg = runIndex >= 0 ? args[runIndex + 1] : undefined;
	const taskArg = taskIndex >= 0 ? args[taskIndex + 1] : undefined;
	if (args.includes('--fingerprints')) {
		const groups = aggregateFingerprints();
		console.log(
			json
				? JSON.stringify(groups, null, 2)
				: groups
						.map(
							(g) =>
								`${g.count}x ${g.fingerprint} ${g.failureClass} runs=${g.runs.length} tasks=${g.tasks.join(',')}`,
						)
						.join('\n'),
		);
	} else if (runArg && taskArg) {
		const runDir = resolveTraceRunDir(REPOSITORY_ROOT, runArg);
		const transcripts = loadAttemptTranscripts(runDir, taskArg);
		console.log(
			json
				? JSON.stringify(transcripts, null, 2)
				: renderAttemptTranscripts(transcripts, taskArg),
		);
	} else if (runArg) {
		const summary = summarizeRun({ runId: runArg });
		console.log(json ? JSON.stringify(summary, null, 2) : renderSummary(summary));
	} else {
		console.error(
			'usage: agent-sdlc-trace --run <run-id> [--task <task-id>] [--json] | --fingerprints [--json]',
		);
		process.exitCode = 64;
	}
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	main();
}
