// Command table for the agent-sdlc CLI. Each entry names the handler, whether
// runCli installs the progress sink, and the exit-code rule. A missing rule
// falls back to exitCodeForResult. Shell entries take an injected runCliFn
// and do not import the CLI entry.

import path from 'node:path';
import { SdlcError } from '../../policy/errors.ts';
import type { TraceAuditorGovernorLike } from '../../scripts/trace-skill-auditor.ts';
import { type ParsedArguments, requiredValue, usage } from '../arguments.ts';
import { exitCodeForResult } from '../exit-codes.ts';
import type { OpenContextOptions } from '../run-context.ts';
import {
	type CliStreams,
	type RunCliFn,
	shellReply,
	shellStart,
	shellStatus,
	shellWatch,
} from '../shell-driver.ts';
import { authorizeRun } from './authorize.ts';
import { executePostMortem } from './candidate-learning.ts';
import { assertStartHostProfile, hostCheck } from './host-check.ts';
import {
	canaryCheck,
	canaryStep,
	checkSpecRun,
	compareReliabilityCommand,
	pruneRuns,
	qualifyCanaryCommand,
	reliabilityReport,
	replayReliabilityCommand,
} from './maintenance.ts';
import { prRun } from './pr.ts';
import { resumeRun } from './resume.ts';
import {
	answerRun,
	approveRun,
	cancelRun,
	exportRun,
	listRuns,
	statusRun,
} from './run-lifecycle.ts';
import { type CreateReadlineFn, executeSkills } from './skills.ts';
import { resolveExecutorSelection, startRun } from './start.ts';

export interface CommandDispatchOptions {
	readonly rootDir: string;
	readonly streams: CliStreams;
	readonly governor?: OpenContextOptions['governor'];
	readonly continueAfterAnswerRecord?: boolean;
	readonly onBoundary?: OpenContextOptions['onBoundary'];
	readonly gitCli?: OpenContextOptions['gitCli'];
	readonly execCli?: OpenContextOptions['execCli'];
	readonly ghCli?: OpenContextOptions['ghCli'];
	readonly createReadline?: CreateReadlineFn | null;
	readonly localPolicyPath?: string | null;
	readonly env?: NodeJS.ProcessEnv;
}

export type CommandHandler = (
	parsed: ParsedArguments,
	options: CommandDispatchOptions,
	runCliFn?: RunCliFn,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface CommandEntry {
	readonly handler: CommandHandler;
	readonly progressSink: boolean;
	readonly exitCode?: (result: Record<string, unknown>) => number;
}

function shellEngineOptions(options: CommandDispatchOptions): Record<string, unknown> {
	return {
		governor: options.governor,
		onBoundary: options.onBoundary,
		gitCli: options.gitCli,
		execCli: options.execCli,
		ghCli: options.ghCli,
		createReadline: options.createReadline,
		localPolicyPath: options.localPolicyPath ?? null,
		env: options.env,
	};
}

function requireRunCliFn(runCliFn: RunCliFn | undefined): RunCliFn {
	if (typeof runCliFn !== 'function') {
		throw new SdlcError('INVALID_INPUT', 'shell command requires an injected runCliFn');
	}
	return runCliFn;
}

function listCommand(
	_parsed: ParsedArguments,
	options: CommandDispatchOptions,
): Record<string, unknown> {
	return listRuns(options);
}

function helpCommand(): Record<string, unknown> {
	return { state: 'HELP', message: usage() };
}

async function shellStartCommand(
	parsed: ParsedArguments,
	options: CommandDispatchOptions,
	runCliFn?: RunCliFn,
): Promise<Record<string, unknown>> {
	const caller = requireRunCliFn(runCliFn);
	resolveExecutorSelection(parsed, options.env ?? process.env);
	return shellStart({
		goalFile: parsed.values.get('--goal-file'),
		taskPlanFile: parsed.values.get('--task-plan-file') ?? null,
		slug: parsed.values.get('--slug') ?? null,
		responseFile: parsed.values.get('--response-file') ?? null,
		executor: parsed.values.get('--executor') ?? null,
		skipCanary: parsed.booleans.has('--skip-canary'),
		rootDir: options.rootDir,
		streams: options.streams,
		runCliFn: caller,
		engineOptions: shellEngineOptions(options),
	});
}

async function shellStatusCommand(
	parsed: ParsedArguments,
	options: CommandDispatchOptions,
	runCliFn?: RunCliFn,
): Promise<Record<string, unknown>> {
	const caller = requireRunCliFn(runCliFn);
	return shellStatus({
		runId: requiredValue(parsed, '--run'),
		rootDir: options.rootDir,
		streams: options.streams,
		runCliFn: caller,
		engineOptions: shellEngineOptions(options),
	});
}

async function shellReplyCommand(
	parsed: ParsedArguments,
	options: CommandDispatchOptions,
	runCliFn?: RunCliFn,
): Promise<Record<string, unknown>> {
	const caller = requireRunCliFn(runCliFn);
	return shellReply({
		runId: requiredValue(parsed, '--run'),
		responseFile: parsed.values.get('--response-file'),
		rootDir: options.rootDir,
		streams: options.streams,
		runCliFn: caller,
		engineOptions: shellEngineOptions(options),
	});
}

async function shellWatchCommand(
	parsed: ParsedArguments,
	options: CommandDispatchOptions,
	runCliFn?: RunCliFn,
): Promise<Record<string, unknown>> {
	const caller = requireRunCliFn(runCliFn);
	const result = await shellWatch({
		runId: requiredValue(parsed, '--run'),
		rootDir: options.rootDir,
		streams: options.streams,
		runCliFn: caller,
		engineOptions: shellEngineOptions(options),
	});
	return result ?? {};
}

function checkSpecExit(result: Record<string, unknown>): number {
	return result.ready ? 0 : 2;
}

function canaryCheckExit(result: Record<string, unknown>): number {
	return result.eligible ? 0 : 2;
}

function canaryQualifyExit(result: Record<string, unknown>): number {
	if (result.status === 'PASSED') return 0;
	if (result.status === 'INCONCLUSIVE') return 2;
	return 3;
}

function reliabilityReplayExit(result: Record<string, unknown>): number {
	return result.status === 'PASSED' ? 0 : 3;
}

function reliabilityReportExit(result: Record<string, unknown>): number {
	if (result.status === 'INCOMPLETE') return 2;
	return exitCodeForResult(result);
}

const COMMAND_TABLE: Readonly<Record<string, CommandEntry>> = {
	start: {
		handler: async (parsed, options) => {
			const rawRoot = parsed.values.get('--root');
			const targetRoot =
				typeof rawRoot === 'string' && rawRoot.trim().length > 0
					? path.resolve(options.rootDir, rawRoot)
					: options.rootDir;
			assertStartHostProfile(targetRoot);
			return startRun(parsed, { ...options, rootDir: targetRoot });
		},
		progressSink: true,
	},
	'host check': { handler: hostCheck, progressSink: false },
	resume: { handler: resumeRun, progressSink: true },
	status: { handler: statusRun, progressSink: false },
	approve: { handler: approveRun, progressSink: true },
	list: { handler: listCommand, progressSink: false },
	answer: { handler: answerRun, progressSink: true },
	authorize: { handler: authorizeRun, progressSink: true },
	pr: { handler: prRun, progressSink: false },
	cancel: { handler: cancelRun, progressSink: false },
	export: { handler: exportRun, progressSink: false },
	'post-mortem': { handler: executePostMortem, progressSink: false },
	'prune-runs': { handler: pruneRuns, progressSink: false },
	skills: {
		handler: (parsed, options) =>
			executeSkills(parsed, {
				...options,
				governor: (options.governor ?? null) as TraceAuditorGovernorLike | null,
			}),
		progressSink: false,
	},
	'check-spec': { handler: checkSpecRun, progressSink: false, exitCode: checkSpecExit },
	'reliability replay': {
		handler: replayReliabilityCommand,
		progressSink: false,
		exitCode: reliabilityReplayExit,
	},
	'reliability report': {
		handler: reliabilityReport,
		progressSink: false,
		exitCode: reliabilityReportExit,
	},
	'reliability routes': { handler: compareReliabilityCommand, progressSink: false },
	'canary check': { handler: canaryCheck, progressSink: false, exitCode: canaryCheckExit },
	'canary qualify': {
		handler: qualifyCanaryCommand,
		progressSink: false,
		exitCode: canaryQualifyExit,
	},
	'canary step': { handler: canaryStep, progressSink: false },
	help: { handler: helpCommand, progressSink: false },
	'shell start': { handler: shellStartCommand, progressSink: false },
	'shell status': { handler: shellStatusCommand, progressSink: false },
	'shell reply': { handler: shellReplyCommand, progressSink: false },
	'shell watch': { handler: shellWatchCommand, progressSink: false },
};

export function commandInstallsProgressSink(command: string): boolean {
	return COMMAND_TABLE[command]?.progressSink === true;
}

export function exitCodeForCommand(command: string, result: Record<string, unknown>): number {
	const rule = COMMAND_TABLE[command]?.exitCode;
	if (typeof rule === 'function') return rule(result);
	return exitCodeForResult(result);
}

export function commandEntry(command: string): CommandEntry {
	const entry = COMMAND_TABLE[command];
	if (!entry) {
		throw new SdlcError('INVALID_INPUT', `Unknown command '${command}'`);
	}
	return entry;
}

export async function dispatchCommand(
	parsed: ParsedArguments,
	options: CommandDispatchOptions,
	runCliFn?: RunCliFn,
): Promise<Record<string, unknown>> {
	return commandEntry(parsed.command).handler(parsed, options, runCliFn);
}
