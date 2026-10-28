// Process-local stderr progress lines for graph-invoking agent-sdlc commands.
//
// `cli.ts` installs a sink for `start`, `resume`, `approve`, `authorize`,
// and `answer` and clears it in a `finally` block; every other command
// leaves the slot unset, so emitting here is a silent no-op for them.
// `graph.ts` emits one outer line per committed runtime transition.
// `emitModelCallProgress` and `emitToolFinishedProgress` emit one inner line
// for a model call or a finished tool while the run is
// `EXECUTING_IMPLEMENTATION` or `REPAIRING_FAILURE`.
//
// Emission never raises: a throwing sink, a failing stream write, or a
// formatting error is swallowed so progress reporting can never change the
// stored runtime state, `blockedReason`, or a command's result.

import { ALLOWED_TOOLS } from '../policy/contracts.ts';

const MAX_LINE_BYTES = 240;
const INNER_STATES = new Set(['EXECUTING_IMPLEMENTATION', 'REPAIRING_FAILURE']);

interface ProgressSink {
	write: (line: string) => unknown;
	seen: Set<string>;
}

interface ProgressFields {
	state: string;
	revision: number;
	taskId?: unknown;
	roleId?: unknown;
	step?: unknown;
	activity?: unknown;
}

// The single process-local sink slot. `seen` is the per-installation
// suppression set: a repeated (state, task, role, step, activity) key is
// dropped while this slot stays installed.
let activeSink: ProgressSink | null = null;

export function installProgressSink(write: (line: string) => unknown): void {
	activeSink = { write, seen: new Set() };
}

export function clearProgressSink(): void {
	activeSink = null;
}

function isSafeToken(text: unknown): text is string {
	return typeof text === 'string' && text.length > 0 && !/\s/.test(text);
}

// Renders a field to a line-safe string, or null to omit it. Values with
// whitespace (including a raw newline) are dropped rather than sanitized in
// place, per the failure defenses.
function normalizeToken(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	const text = typeof value === 'string' ? value : String(value);
	return isSafeToken(text) ? text : null;
}

export function toolActivity(toolName: unknown): string {
	return typeof toolName === 'string' && (ALLOWED_TOOLS as readonly string[]).includes(toolName)
		? `tool:${toolName}`
		: 'tool:other';
}

function renderOptionalParts(
	optional: ReadonlyArray<readonly [string, string | null]>,
	dropCount: number,
): string[] {
	const parts: string[] = [];
	optional.forEach(([key, value], index) => {
		if (index < dropCount || value === null) return;
		parts.push(`${key}=${value}`);
	});
	return parts;
}

// Builds the line, dropping optional fields (task, then role, then step,
// then activity) in that order until the line fits the 240-byte budget.
// `state` and `revision` are never dropped.
function formatLine({ state, revision, taskId, roleId, step, activity }: ProgressFields): string {
	const timestamp = new Date().toISOString();
	const base = `agent-sdlc: progress ${timestamp} state=${state} revision=${revision}`;
	const optional: ReadonlyArray<readonly [string, string | null]> = [
		['task', normalizeToken(taskId)],
		['role', normalizeToken(roleId)],
		['step', normalizeToken(step)],
		['activity', normalizeToken(activity)],
	];
	for (let dropCount = 0; dropCount <= optional.length; dropCount += 1) {
		const parts = renderOptionalParts(optional, dropCount);
		const line = parts.length > 0 ? `${base} ${parts.join(' ')}\n` : `${base}\n`;
		if (Buffer.byteLength(line, 'utf8') <= MAX_LINE_BYTES) return line;
	}
	return `${base}\n`;
}

function suppressionKey({ state, taskId, roleId, step, activity }: ProgressFields): string {
	return JSON.stringify([
		state,
		normalizeToken(taskId),
		normalizeToken(roleId),
		normalizeToken(step),
		normalizeToken(activity),
	]);
}

function emit(fields: ProgressFields): void {
	if (!activeSink) return;
	try {
		const key = suppressionKey(fields);
		if (activeSink.seen.has(key)) return;
		const line = formatLine(fields);
		activeSink.write(line);
		activeSink.seen.add(key);
	} catch {
		// A throwing sink, or a stream write that fails, is swallowed. The
		// stored runtime state and the command's result are unaffected.
	}
}

// Called once per committed outer runtime transition (graph.ts). The line
// omits role, step, and activity.
export function emitRuntimeTransitionProgress(state: {
	state: string;
	runtimeRevision: number;
	activeTaskId?: string | null;
}): void {
	if (!activeSink) return;
	try {
		emit({
			state: state.state,
			revision: state.runtimeRevision,
			taskId: state.activeTaskId ?? null,
		});
	} catch {
		// Swallow: see emit().
	}
}

export interface ProgressRuntimeStoreLike {
	getRun(runId: string): {
		state: string;
		runtimeRevision: number;
		activeTaskId?: string | null;
	} | null;
}

function emitInner({
	runtimeStore,
	runId,
	taskId,
	roleId,
	step,
	activity,
}: {
	runtimeStore: ProgressRuntimeStoreLike;
	runId: string;
	taskId?: unknown;
	roleId?: unknown;
	step?: unknown;
	activity: string;
}): void {
	if (!activeSink) return;
	try {
		const run = runtimeStore.getRun(runId);
		if (!run || !INNER_STATES.has(run.state)) return;
		emit({
			state: run.state,
			revision: run.runtimeRevision,
			taskId: taskId ?? run.activeTaskId ?? null,
			roleId,
			step,
			activity,
		});
	} catch {
		// Swallow: reading runtime state for progress must never surface as
		// a command failure.
	}
}

// Emits one inner line immediately before a governed model call.
export function emitModelCallProgress({
	runtimeStore,
	runId,
	taskId,
	roleId,
	step,
}: {
	runtimeStore: ProgressRuntimeStoreLike;
	runId: string;
	taskId?: unknown;
	roleId?: unknown;
	step?: unknown;
}): void {
	emitInner({ runtimeStore, runId, taskId, roleId, step, activity: 'model' });
}

// Emits one inner line after a finished tool execution is recorded.
export function emitToolFinishedProgress({
	runtimeStore,
	runId,
	taskId,
	roleId,
	step,
	toolName,
}: {
	runtimeStore: ProgressRuntimeStoreLike;
	runId: string;
	taskId?: unknown;
	roleId?: unknown;
	step?: unknown;
	toolName?: unknown;
}): void {
	emitInner({ runtimeStore, runId, taskId, roleId, step, activity: toolActivity(toolName) });
}

export const PROGRESS_MAX_LINE_BYTES = MAX_LINE_BYTES;
