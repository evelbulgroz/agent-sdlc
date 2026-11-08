import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { durableReplaceSync, withLockSync } from '@evelbulgroz/model-usage-govenor/atomic-file-state';
import { resolveAndValidateRunDir, resolveRunSelector } from './run-selector.ts';
import { loadOrRecoverEnvelope } from './store.ts';

export interface RecordOptions {
	rootDir: string;
	runsDir: string;
	telemetryDir: string;
	runSelector?: string | null;
	resultFile?: string | null;
	stdin?: boolean;
	preflightResult?: Record<string, unknown> | null;
	now?: string | Date;
	recordIdGenerator?: () => string;
}

export interface RecordOutcome {
	ok: boolean;
	recorded: boolean;
	deduplicated: boolean;
	telemetryFile: string | null;
	record: Record<string, unknown> | null;
	error: string | null;
}

const outcome = (fields: Partial<RecordOutcome> = {}): RecordOutcome => ({
	ok: true, recorded: false, deduplicated: false, telemetryFile: null, record: null, error: null, ...fields,
});

function failure(error: string): RecordOutcome {
	console.warn(error);
	return outcome({ ok: false, error });
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function readResult(options: RecordOptions, rootDir: string): Record<string, unknown> | string {
	if (options.preflightResult) return options.preflightResult;
	if (options.stdin) {
		try {
			return JSON.parse(fs.readFileSync(0, 'utf8')) as Record<string, unknown>;
		} catch (error) {
			return `telemetry-record: Failed to parse stdin JSON payload: ${message(error)}`;
		}
	}
	if (!options.resultFile) return 'telemetry-record: no result source (pass --stdin or --result, or set verify.resultPath in the host profile)';
	const resultFile = path.resolve(rootDir, options.resultFile);
	if (!fs.existsSync(resultFile)) return `telemetry-record: Preflight result file not found: '${resultFile}'`;
	try {
		return JSON.parse(fs.readFileSync(resultFile, 'utf8')) as Record<string, unknown>;
	} catch (error) {
		return `telemetry-record: Failed to parse result file '${resultFile}': ${message(error)}`;
	}
}

function buildRecord(result: Record<string, unknown>, nowIso: string, retryCount: number, recordId: string) {
	const startedAt = String(result.startedAt || nowIso);
	const finishedAt = String(result.finishedAt || nowIso);
	const gitHeadSha = String(result.gitHeadSha || 'unknown');
	const exitCode = typeof result.exitCode === 'number' ? result.exitCode : (result.status === 'OK' ? 0 : 1);
	return {
		recordId,
		executionKey: `${gitHeadSha}:${startedAt}:${finishedAt}:${exitCode}`,
		recordedAt: nowIso,
		startedAt,
		finishedAt,
		durationMs: Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime()),
		changeClass: result.changeClass || 'D',
		preflightStatus: result.status || 'FAIL',
		exitCode,
		canonical: Boolean(result.canonical),
		gitHeadSha,
		base: result.base || 'origin/main',
		staged: Boolean(result.staged),
		retryCount,
		commandsExecuted: Array.isArray(result.commands) ? result.commands : [],
		skippedGates: Array.isArray(result.skippedGates) ? result.skippedGates : [],
	};
}

/** Appends one preflight execution to the run's telemetry file. Never throws: failures are reported in the outcome. */
export function recordPreflightTelemetry(options: RecordOptions): RecordOutcome {
	const rootDir = path.resolve(options.rootDir);
	const selector = resolveRunSelector(options.runSelector);
	if (!selector) return outcome();

	let slug: string;
	try {
		slug = resolveAndValidateRunDir(selector, rootDir, options.runsDir).slug;
	} catch (error) {
		return failure(`telemetry-record: Invalid run selector '${selector}': ${message(error)}`);
	}
	const result = readResult(options, rootDir);
	if (typeof result === 'string') return failure(result);

	const nowIso = options.now ? new Date(options.now).toISOString() : new Date().toISOString();
	const telemetryDir = path.resolve(rootDir, options.telemetryDir);
	const telemetryFile = path.join(telemetryDir, `${slug}.json`);
	fs.mkdirSync(telemetryDir, { recursive: true });

	try {
		return withLockSync(path.join(telemetryDir, `${slug}.lock`), () => {
			const envelope = loadOrRecoverEnvelope(telemetryFile, slug, nowIso);
			const candidate = buildRecord(result, nowIso, 0, '');
			const existing = envelope.records.find((entry) => entry.executionKey === candidate.executionKey);
			if (existing) return outcome({ recorded: true, deduplicated: true, telemetryFile, record: existing });

			const retryCount = envelope.records.filter((entry) => entry.gitHeadSha === candidate.gitHeadSha).length;
			const record = buildRecord(result, nowIso, retryCount, (options.recordIdGenerator ?? crypto.randomUUID)());
			envelope.records.push(record);
			envelope.records.sort((a, b) => new Date(String(a.startedAt)).getTime() - new Date(String(b.startedAt)).getTime());
			envelope.updatedAt = nowIso;
			try {
				durableReplaceSync(telemetryFile, `${JSON.stringify(envelope, null, 2)}\n`);
			} catch (error) {
				return failure(`telemetry-record: Atomic write failed: ${message(error)}`);
			}
			return outcome({ recorded: true, telemetryFile, record });
		});
	} catch (error) {
		return failure(`telemetry-record: Lock acquisition failed: ${message(error)}`);
	}
}
