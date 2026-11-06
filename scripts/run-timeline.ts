#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { readSpans, type RunSpan } from '../persistence/run-spans.ts';
import { resolveTraceRunDir } from './trace-summary.ts';

export interface TimelineEntry {
	kind: 'event' | 'model' | 'tool' | 'evidence' | 'implementer' | 'prepare' | 'critic';
	label: string;
	startMs: number;
	endMs: number;
}

export interface TimelineSummary {
	runId: string;
	startMs: number;
	endMs: number;
	entries: TimelineEntry[];
	/** Wall time attributed to each event, measured from the previous event. */
	eventIntervals: Array<{ label: string; ms: number }>;
	/** Covered wall time per kind (nested or concurrent spans of one kind count once); kinds may overlap each other. */
	spanMsByKind: Record<string, number>;
}

function parseMs(value: unknown): number | null {
	const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
	return Number.isFinite(ms) ? ms : null;
}

function rows(db: DatabaseSync, sql: string, runId: string): Array<Record<string, unknown>> {
	return db.prepare(sql).all(runId) as Array<Record<string, unknown>>;
}

/** Read-only: merges the run's timestamped events, model calls, tool calls, evidence invocations and engine spans (implementer, prepare, critic). */
export function buildTimeline(db: DatabaseSync, runId: string, spans: readonly RunSpan[] = []): TimelineSummary {
	const entries: TimelineEntry[] = [];
	const add = (kind: TimelineEntry['kind'], label: string, start: unknown, end: unknown = start) => {
		const startMs = parseMs(start);
		const endMs = parseMs(end) ?? startMs;
		if (startMs !== null && endMs !== null) entries.push({ kind, label, startMs, endMs });
	};
	for (const r of rows(db, 'SELECT event_type, created_at FROM events WHERE run_id = ? ORDER BY rowid', runId)) {
		add('event', String(r.event_type), r.created_at);
	}
	for (const r of rows(
		db,
		'SELECT task_id, role_id, route_id, status, created_at, updated_at FROM model_operations WHERE run_id = ?',
		runId,
	)) {
		add('model', `${r.role_id ?? '-'} ${r.task_id ?? '-'} ${r.route_id ?? '-'} ${r.status}`, r.created_at, r.updated_at);
	}
	for (const r of rows(db, 'SELECT task_id, tool_name, created_at FROM tool_executions WHERE run_id = ?', runId)) {
		add('tool', `${r.task_id ?? '-'} ${r.tool_name}`, r.created_at);
	}
	for (const r of rows(db, "SELECT record_json FROM quality_records WHERE run_id = ? AND kind = 'completion'", runId)) {
		const invocation = (JSON.parse(String(r.record_json)) as { invocation?: Record<string, unknown> }).invocation;
		if (invocation) {
			add('evidence', `${String(invocation.operationId)} ${String(invocation.status)} ${String(invocation.failureReason ?? '')}`.trim(),
				invocation.startedAt, invocation.finishedAt);
		}
	}
	for (const span of spans) add(span.kind, `${span.label}${span.ok ? '' : ' (failed)'}`, span.startedAt, span.finishedAt);
	entries.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
	const events = entries.filter((e) => e.kind === 'event');
	const eventIntervals = events.slice(1).map((e, i) => ({ label: e.label, ms: e.startMs - (events[i]?.startMs ?? e.startMs) }));
	// Covered wall time per kind: nested or concurrent spans of one kind count once.
	const spanMsByKind: Record<string, number> = {};
	const coveredUntil: Record<string, number> = {};
	for (const e of entries) {
		const from = Math.max(e.startMs, coveredUntil[e.kind] ?? e.startMs);
		spanMsByKind[e.kind] = (spanMsByKind[e.kind] ?? 0) + Math.max(0, e.endMs - from);
		coveredUntil[e.kind] = Math.max(coveredUntil[e.kind] ?? e.endMs, e.endMs);
	}
	return {
		runId,
		startMs: entries[0]?.startMs ?? 0,
		endMs: entries.reduce((max, e) => Math.max(max, e.endMs), 0),
		entries,
		eventIntervals,
		spanMsByKind,
	};
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export function renderTimeline(summary: TimelineSummary): string {
	const lines = [
		`Run ${summary.runId}: ${seconds(summary.endMs - summary.startMs)} wall`,
		`Span time by kind: ${Object.entries(summary.spanMsByKind).map(([k, v]) => `${k}=${seconds(v)}`).join(' ')}`,
		'',
		'Longest event intervals (time since the previous event):',
		...[...summary.eventIntervals].sort((a, b) => b.ms - a.ms).slice(0, 10)
			.map((e) => `  ${seconds(e.ms).padStart(9)}  ${e.label}`),
		'',
		'Timeline (offset, duration, kind, label):',
		...summary.entries.map((e) =>
			`  +${seconds(e.startMs - summary.startMs).padStart(8)} ${seconds(e.endMs - e.startMs).padStart(8)} ${e.kind.padEnd(8)} ${e.label}`),
	];
	return lines.join('\n');
}

export function main(args: readonly string[] = process.argv.slice(2)): void {
	const runIndex = args.indexOf('--run');
	const runId = runIndex >= 0 ? args[runIndex + 1] : undefined;
	if (!runId) {
		console.error('usage: agent-sdlc-timeline --run <run-id> [--json]');
		process.exitCode = 64;
		return;
	}
	const databasePath = path.join(resolveTraceRunDir(REPOSITORY_ROOT, runId), 'runtime.sqlite');
	if (!fs.existsSync(databasePath)) {
		console.error(`No runtime store for run ${runId}`);
		process.exitCode = 64;
		return;
	}
	const db = new DatabaseSync(databasePath, { readOnly: true });
	try {
		const summary = buildTimeline(db, runId, readSpans(databasePath));
		console.log(args.includes('--json') ? JSON.stringify(summary, null, 2) : renderTimeline(summary));
	} finally {
		db.close();
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
