/**
 * Operator shell driver (docs/specs/retired/agent-sdlc-operator-shell.md).
 *
 * This module is the only code in the repository that is allowed to decide
 * *which* engine command (`start`, `resume`, `authorize`, `answer`) runs
 * next on behalf of an operator session. It never drafts, clarifies, or
 * calls the model governor itself: `shellStart` only ever calls the
 * governor-free `check-spec` command before the operator confirms a brief,
 * and every mutating call after that replays the exact `argv` the engine
 * already published on a continuation card (`hostInvocation.argv`).
 *
 * Callers must inject `runCliFn`, the function that actually dispatches an
 * engine command (production wiring passes `runCli` from `cli.ts`; tests
 * inject a recording stub). There is no default: a driver that silently
 * invoked a real engine during a unit test would defeat the point of this
 * module, so a missing `runCliFn` fails closed instead of guessing.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { HostInvocationRecord, ResponseQuestionSlot, ResponseSlot } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { parseSpecification } from '../workflow/specification.ts';

const MAX_GOAL_FILE_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_FILE_BYTES = 262144;
const RESPONSE_FILE_PLACEHOLDER = '{response-file}';

export interface CliStreams {
	stdin: NodeJS.ReadableStream & { isTTY?: boolean };
	stdout: { write(chunk: string): unknown };
	stderr: { write(chunk: string): unknown };
}

export interface RunCliOutcome {
	exitCode: number;
	result: {
		ok?: boolean;
		command?: string;
		error?: { code?: string; message?: string; metadata?: Record<string, unknown> };
		[key: string]: unknown;
	};
	human: string;
}

export type RunCliFn = (
	args: readonly string[],
	options?: Record<string, unknown>,
) => Promise<RunCliOutcome>;

function requireRunCliFn(runCliFn: unknown): RunCliFn {
	if (typeof runCliFn !== 'function') {
		throw new SdlcError(
			'INVALID_INPUT',
			'shell driver requires an injected runCliFn; it never falls back to a default engine caller',
		);
	}
	return runCliFn as RunCliFn;
}

function requireRunId(runId: unknown, subcommand: string): string {
	if (!runId || typeof runId !== 'string') {
		throw new SdlcError('INVALID_INPUT', `shell ${subcommand} requires --run`);
	}
	return runId;
}

/** Strips the `agent-sdlc` or legacy `pnpm run agent:sdlc --` prefix from continuation argv. */
function stripEngineArgvPrefix(argv: unknown): string[] {
	if (!Array.isArray(argv)) return [];
	const strArgv = argv.filter((item): item is string => typeof item === 'string');
	const legacy = ['pnpm', 'run', 'agent:sdlc', '--'];
	if (legacy.every((segment, index) => strArgv[index] === segment)) return strArgv.slice(legacy.length);
	return strArgv[0] === 'agent-sdlc' ? strArgv.slice(1) : strArgv.slice();
}

/**
 * Unwraps a `runCli`-shaped outcome (`{exitCode, result, human}`). A failed
 * inner call (`result.ok === false`) is re-thrown as the same `SdlcError` so
 * it surfaces through the driver's own call exactly as it would have if the
 * engine command had been invoked directly; a successful call drops the
 * `ok`/`command` envelope so callers see only the engine's own fields.
 */
function unwrapEngineOutcome(outcome: RunCliOutcome): Record<string, unknown> {
	const { ok, command: _command, error, ...rest } = outcome.result ?? {};
	if (ok === false) {
		throw new SdlcError(
			error?.code ?? 'INTERNAL_ERROR',
			error?.message ?? 'Engine call failed',
			error?.metadata ?? {},
		);
	}
	return rest;
}

async function invokeEngineArgv(
	runCliFn: RunCliFn,
	argv: readonly string[],
	{ rootDir, streams, engineOptions }: {
		rootDir: string; streams?: CliStreams; engineOptions?: Record<string, unknown>;
	},
): Promise<Record<string, unknown>> {
	const args = stripEngineArgvPrefix(argv);
	const outcome = await runCliFn(args, { rootDir, streams, ...engineOptions });
	return unwrapEngineOutcome(outcome);
}

async function invokeEngine(
	runCliFn: RunCliFn,
	args: readonly string[],
	{ rootDir, streams, engineOptions }: {
		rootDir: string; streams?: CliStreams; engineOptions?: Record<string, unknown>;
	},
): Promise<Record<string, unknown>> {
	const outcome = await runCliFn(args, { rootDir, streams, ...engineOptions });
	return unwrapEngineOutcome(outcome);
}

/**
 * A goal named `something.md` with `something.tasks.json` beside it is a
 * manifest run. shell start names that file only when the caller passed
 * `--task-plan-file`; it does not attach the sibling on its own.
 */
function siblingTaskManifest(absoluteGoalFile: string): string | null {
	if (!absoluteGoalFile.endsWith('.md')) return null;
	const sibling = `${absoluteGoalFile.slice(0, -'.md'.length)}.tasks.json`;
	return fs.existsSync(sibling) ? sibling : null;
}

function readBoundedFile(filename: string, maxBytes: number, label: string): string {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filename);
	} catch (error: unknown) {
		throw new SdlcError(
			'INVALID_INPUT',
			`Cannot read ${label}: ${filename}`,
			{},
			{ cause: error },
		);
	}
	if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) {
		throw new SdlcError(
			'INVALID_INPUT',
			`${label} is empty, not a regular file, or too large: ${filename}`,
		);
	}
	return fs.readFileSync(filename, 'utf8');
}

function readJsonFile(filename: string, maxBytes: number, label: string): Record<string, unknown> {
	const raw = readBoundedFile(filename, maxBytes, label);
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch (error: unknown) {
		throw new SdlcError(
			'INVALID_INPUT',
			`${label} is not valid JSON: ${filename}`,
			{},
			{ cause: error },
		);
	}
}

function computeBriefHash(draft: {
	owningContext?: string | null;
	acceptanceCriteria?: readonly string[];
}): string {
	const canonical = JSON.stringify({
		owningContext: draft.owningContext ?? null,
		acceptanceCriteria: draft.acceptanceCriteria ?? [],
	});
	return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * `shell start`: brief-then-confirm gate in front of the engine `start`
 * command (AC-03, AC-04). An unready draft or an unconfirmed ready draft
 * both stop with a brief and never reach `start`; only a response file whose
 * `briefHash` matches the current draft lets `start` run, and it then runs
 * exactly once.
 */
export async function shellStart({
	goalFile, taskPlanFile = null, slug = null, responseFile = null,
	executor = null, skipCanary = false, rootDir, streams, runCliFn, engineOptions = {},
}: {
	goalFile?: string | null; taskPlanFile?: string | null; slug?: string | null;
	responseFile?: string | null; executor?: string | null; skipCanary?: boolean;
	rootDir: string; streams?: CliStreams; runCliFn?: RunCliFn; engineOptions?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
	const engineCaller = requireRunCliFn(runCliFn);
	if (!goalFile || typeof goalFile !== 'string') {
		throw new SdlcError('INVALID_INPUT', 'shell start requires --goal-file');
	}
	const absoluteGoalFile = path.resolve(rootDir, goalFile);
	if (!taskPlanFile) {
		const sibling = siblingTaskManifest(absoluteGoalFile);
		if (sibling) {
			throw new SdlcError(
				'INVALID_INPUT',
				`shell start requires --task-plan-file because sibling task manifest exists: ${sibling}`,
			);
		}
	}
	readBoundedFile(absoluteGoalFile, MAX_GOAL_FILE_BYTES, 'goal file');

	const checkArgs = ['check-spec', '--goal-file', goalFile, '--json'];
	if (taskPlanFile) checkArgs.push('--task-plan-file', taskPlanFile);
	const checked = await invokeEngine(engineCaller, checkArgs, {
		rootDir,
		streams,
		engineOptions,
	});
	const completeness = checked.completeness as
		| { missingFields?: readonly string[]; ambiguousFields?: readonly string[] }
		| undefined;

	if (!checked.ready) {
		const missingFields = [
			...(completeness?.missingFields ?? []),
			...(completeness?.ambiguousFields ?? []),
		];
		return {
			ready: false,
			missingFields,
			completeness: checked.completeness ?? null,
			acceptanceCriteriaQuality: checked.acceptanceCriteriaQuality ?? null,
			continuation: { action: 'answer', reason: 'SPEC_INCOMPLETE' },
		};
	}

	const goalText = readBoundedFile(absoluteGoalFile, MAX_GOAL_FILE_BYTES, 'goal file');
	const draft = parseSpecification(goalText);
	const briefHash = computeBriefHash(draft);

	if (!responseFile) {
		return {
			ready: true,
			owningContext: draft.owningContext,
			acceptanceCriteria: draft.acceptanceCriteria,
			briefHash,
			continuation: { action: 'answer', reason: 'BRIEF_CONFIRMATION_REQUIRED' },
		};
	}

	const absoluteResponseFile = path.resolve(rootDir, responseFile);
	const confirmation = readJsonFile(
		absoluteResponseFile,
		MAX_RESPONSE_FILE_BYTES,
		'response file',
	);
	if (confirmation?.confirm !== true || confirmation?.briefHash !== briefHash) {
		throw new SdlcError(
			'INVALID_INPUT',
			'Brief confirmation is missing or stale; re-run shell start without --response-file to get the current brief',
		);
	}

	const startArgs = ['start'];
	if (slug) startArgs.push('--slug', slug);
	startArgs.push('--goal-file', goalFile);
	if (taskPlanFile) startArgs.push('--task-plan-file', taskPlanFile);
	if (typeof executor === 'string' && executor.length > 0) startArgs.push('--executor', executor);
	if (skipCanary) startArgs.push('--skip-canary');
	startArgs.push('--json');
	return invokeEngine(engineCaller, startArgs, { rootDir, streams, engineOptions });
}

/** `shell status`: read-only projection of the latest continuation card. */
export async function shellStatus({
	runId,
	rootDir,
	streams,
	runCliFn,
	engineOptions = {},
}: {
	runId?: string | null;
	rootDir: string;
	streams?: CliStreams;
	runCliFn?: RunCliFn;
	engineOptions?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
	const engineCaller = requireRunCliFn(runCliFn);
	const validRunId = requireRunId(runId, 'status');
	return invokeEngine(engineCaller, ['status', '--run', validRunId, '--json'], {
		rootDir,
		streams,
		engineOptions,
	});
}

function fillQuestionSlots(
	responseDocument: Record<string, unknown>,
	responseSlots: readonly ResponseQuestionSlot[],
	payload: Record<string, unknown>,
): Record<string, unknown> {
	const provided = new Map<string, unknown>();
	const rawAnswers = Array.isArray(payload?.answers) ? payload.answers : [];
	for (const answer of rawAnswers) {
		const item = answer as { questionId?: unknown; value?: unknown } | null;
		if (item && typeof item.questionId === 'string') {
			provided.set(item.questionId, item.value);
		}
	}
	const answers = responseSlots.map((slot) => {
		const value = provided.has(slot.questionId) ? provided.get(slot.questionId) : undefined;
		const isEmpty = value === undefined || value === null || value === '';
		if (slot.required && isEmpty) {
			throw new SdlcError(
				'INVALID_INPUT',
				`Reply is missing required response slot '${slot.questionId}'`,
			);
		}
		return { questionId: slot.questionId, value: isEmpty ? null : value };
	});
	return { ...responseDocument, answers };
}

function fillActionSlot(
	responseDocument: Record<string, unknown>,
	responseSlots: Exclude<ResponseSlot, readonly ResponseQuestionSlot[]>,
	payload: Record<string, unknown>,
): Record<string, unknown> {
	const choices = Array.isArray(responseSlots.choices) ? responseSlots.choices : [];
	const action = payload?.action;
	if (typeof action !== 'string' || !choices.includes(action)) {
		throw new SdlcError(
			'INVALID_INPUT',
			`Reply is missing required response slot 'action' (expected one of: ${choices.join(', ')})`,
		);
	}
	const filled: Record<string, unknown> = {
		...responseDocument,
		action,
		...(payload?.taskPlanHash ? { taskPlanHash: payload.taskPlanHash } : {}),
	};
	if (responseSlots.changes && action === 'revise') {
		if (!Array.isArray(payload?.changes) || payload.changes.length === 0) {
			throw new SdlcError('INVALID_INPUT', "Reply is missing required response slot 'changes'");
		}
		filled.changes = payload.changes;
	}
	return filled;
}

function isQuestionSlotArray(
	slots: readonly ResponseQuestionSlot[] | ResponseSlot,
): slots is readonly ResponseQuestionSlot[] {
	return Array.isArray(slots);
}

function fillResponseDocument(
	card: HostInvocationRecord | null | undefined,
	payload: Record<string, unknown>,
): Record<string, unknown> {
	if (!card?.responseDocument || !card?.responseSlots) {
		throw new SdlcError('INVALID_INPUT', 'This run has no pending reply slot to fill');
	}
	return isQuestionSlotArray(card.responseSlots)
		? fillQuestionSlots(card.responseDocument, card.responseSlots, payload)
		: fillActionSlot(card.responseDocument, card.responseSlots, payload);
}

function writeTempResponseFile(
	rootDir: string,
	runId: string,
	document: Record<string, unknown>,
): string {
	const scratchDir = path.join(rootDir, 'tools/.agent-sdlc', runId, 'scratch');
	fs.mkdirSync(scratchDir, { recursive: true });
	const filePath = path.join(
		scratchDir,
		`shell-reply-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`,
	);
	fs.writeFileSync(filePath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
	return filePath;
}

/**
 * `shell reply`: submits an operator response for whichever elevation card
 * is currently pending (AC-06). The response is validated against the
 * card's published `responseSlots` before anything reaches the engine; a
 * missing or out-of-band slot never produces an engine call.
 */
export async function shellReply({
	runId,
	responseFile,
	rootDir,
	streams,
	runCliFn,
	engineOptions = {},
}: {
	runId?: string | null;
	responseFile?: string | null;
	rootDir: string;
	streams?: CliStreams;
	runCliFn?: RunCliFn;
	engineOptions?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
	const engineCaller = requireRunCliFn(runCliFn);
	const validRunId = requireRunId(runId, 'reply');
	if (!responseFile || typeof responseFile !== 'string') {
		throw new SdlcError('INVALID_INPUT', 'shell reply requires --response-file');
	}
	const statusResult = await invokeEngine(
		engineCaller,
		['status', '--run', validRunId, '--json'],
		{
			rootDir,
			streams,
			engineOptions,
		},
	);
	const card = statusResult?.hostInvocation as HostInvocationRecord | undefined;
	if (!card || card.executable !== true || !Array.isArray(card.argv)) {
		throw new SdlcError('INVALID_INPUT', `Run '${validRunId}' has no pending reply to submit`);
	}
	const absoluteResponseFile = path.resolve(rootDir, responseFile);
	const payload = readJsonFile(
		absoluteResponseFile,
		MAX_RESPONSE_FILE_BYTES,
		'response file',
	);
	const filledDocument = fillResponseDocument(card, payload);
	const tempResponsePath = writeTempResponseFile(rootDir, validRunId, filledDocument);
	const argv = card.argv.map((segment) =>
		segment === RESPONSE_FILE_PLACEHOLDER ? tempResponsePath : segment,
	);
	return invokeEngineArgv(engineCaller, argv, { rootDir, streams, engineOptions });
}

const MECHANICAL_CONTINUATION_ACTIONS = new Set(['resume', 'authorize']);

/**
 * `shell watch`: replays mechanical continuation cards (`resume`,
 * `authorize`) without asking the operator (AC-05, AC-07). Any other
 * continuation -- `answer` (needs a reply), or `stop` (git approval,
 * completion, or halt) -- ends the loop and hands the card back so the host
 * or operator can act; git flags and `--retry` are never added here because
 * the driver only ever replays the card's own published argv verbatim.
 */
export async function shellWatch({
	runId,
	rootDir,
	streams,
	runCliFn,
	engineOptions = {},
	maxIterations = 25,
}: {
	runId?: string | null;
	rootDir: string;
	streams?: CliStreams;
	runCliFn?: RunCliFn;
	engineOptions?: Record<string, unknown>;
	maxIterations?: number;
}): Promise<Record<string, unknown> | null> {
	const engineCaller = requireRunCliFn(runCliFn);
	const validRunId = requireRunId(runId, 'watch');
	let lastBlockedReason: unknown;
	let stableBlockedCount = 0;
	let last: Record<string, unknown> | null = null;
	for (let iteration = 0; iteration < maxIterations; iteration += 1) {
		const status = await invokeEngine(engineCaller, ['status', '--run', validRunId, '--json'], {
			rootDir,
			streams,
			engineOptions,
		});
		last = status;
		const continuation = status?.continuation as { action?: string; reason?: string } | undefined;
		const card = status?.hostInvocation as HostInvocationRecord | undefined;
		if (!continuation || !MECHANICAL_CONTINUATION_ACTIONS.has(continuation.action ?? '')) {
			if (continuation?.reason === 'HALTED') {
				streams?.stderr?.write?.(
					`\x07⚠️  [shell watch] Run '${validRunId}' HALTED: ${status.blockedReason ?? continuation.reason}\n`,
				);
			}
			return status;
		}
		if (!card || card.executable !== true || !Array.isArray(card.argv)) {
			return status;
		}
		if (status.blockedReason && status.blockedReason === lastBlockedReason) {
			stableBlockedCount += 1;
			if (stableBlockedCount >= 2) return status;
		} else {
			stableBlockedCount = 0;
		}
		lastBlockedReason = status.blockedReason;
		await invokeEngineArgv(engineCaller, card.argv, { rootDir, streams, engineOptions });
	}
	return last;
}
