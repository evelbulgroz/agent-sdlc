#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { asSdlcError, exitCodeForError } from '../policy/errors.ts';
import type { GitCliFn } from '../workflow/git-manager.ts';
import type { ExecCliFn, SdlcWorkflowRuntimeOptions } from '../workflow/graph.ts';
import type { WorkflowModelGovernor } from '../workflow/node-helpers.ts';
import { parseArguments } from './arguments.ts';
import {
	type CommandDispatchOptions,
	commandInstallsProgressSink,
	dispatchCommand,
	exitCodeForCommand,
} from './commands/index.ts';
import { maybePromptLearningDebt } from './commands/skills.ts';
import { humanResult } from './human-result.ts';
import { clearProgressSink, installProgressSink } from './progress.ts';
import type { CliStreams, RunCliFn, RunCliOutcome } from './shell-driver.ts';

export { humanResult } from './human-result.ts';
export { resolveExecutorSelection } from './commands/start.ts';
export { exitCodeForResult, exitCodeForState } from './exit-codes.ts';
export { snapshotWorktreeTree } from './commands/resume-escalation.ts';
export { maybePromptLearningDebt } from './commands/skills.ts';

export interface RunCliOptions {
	readonly rootDir?: string;
	readonly streams?: CliStreams;
	readonly governor?: WorkflowModelGovernor | null;
	readonly continueAfterAnswerRecord?: boolean;
	readonly onBoundary?: SdlcWorkflowRuntimeOptions['onBoundary'];
	readonly gitCli?: GitCliFn;
	readonly execCli?: ExecCliFn;
	readonly ghCli?: ExecCliFn | null;
	readonly createReadline?: CommandDispatchOptions['createReadline'];
	readonly localPolicyPath?: string | null;
	readonly env?: NodeJS.ProcessEnv;
	readonly promptLearningDebt?: boolean;
	readonly runCliFn?: RunCliFn;
}

export async function runCli(
	args: readonly string[],
	options: RunCliOptions = {},
): Promise<RunCliOutcome> {
	const rootDir = options.rootDir ?? REPOSITORY_ROOT;
	const streams: CliStreams = options.streams ?? {
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
	};
	try {
		const parsed = parseArguments(args);
		const installsProgressSink = commandInstallsProgressSink(parsed.command);
		if (installsProgressSink) {
			installProgressSink((line) => {
				streams.stderr.write(line);
			});
		}
		let result: Record<string, unknown>;
		try {
			result = await dispatchCommand(
				parsed,
				{
					rootDir,
					streams,
					governor: options.governor,
					continueAfterAnswerRecord: options.continueAfterAnswerRecord ?? true,
					onBoundary: options.onBoundary,
					gitCli: options.gitCli,
					execCli: options.execCli,
					ghCli: options.ghCli,
					createReadline: options.createReadline,
					localPolicyPath: options.localPolicyPath ?? null,
					env: options.env,
				},
				options.runCliFn ?? runCli,
			);
		} finally {
			if (installsProgressSink) clearProgressSink();
		}
		const human = humanResult(parsed.command, result, rootDir);
		if (options.promptLearningDebt) {
			streams.stdout.write(`${human}\n`);
			await maybePromptLearningDebt({
				command: parsed.command,
				result: { command: parsed.command, ...result },
				rootDir,
				streams,
				parsedJson: parsed.booleans.has('--json'),
				createReadline: options.createReadline,
				runCliFn: options.runCliFn ?? runCli,
			});
		}
		return {
			exitCode: exitCodeForCommand(parsed.command, result),
			result: { ok: true, command: parsed.command, ...result },
			human,
		};
	} catch (error: unknown) {
		const typed = asSdlcError(error);
		const rawExceeded = typed.metadata?.exceededLimits;
		const exceededLimits = Array.isArray(rawExceeded)
			? (rawExceeded as ReadonlyArray<Record<string, unknown>>)
			: undefined;
		const human = [`${typed.code}: ${typed.message}`];
		if (exceededLimits && exceededLimits.length > 0) {
			human.push('exceededLimits:');
			for (const task of exceededLimits) {
				const taskLimits = Array.isArray(task.exceededLimits)
					? (task.exceededLimits as ReadonlyArray<Record<string, unknown>>)
					: [];
				human.push(
					`  ${String(task.taskId ?? '')}: ${taskLimits
						.map((limit) => `${String(limit.dimension)}=${String(limit.actual)} (max ${String(limit.maximum)})`)
						.join(', ')}`,
				);
			}
		}
		return {
			exitCode: exitCodeForError(typed),
			result: { ok: false, error: typed.toJSON() },
			human: human.join('\n'),
		};
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const parsedJson = args.includes('--json');
	let outcome: RunCliOutcome;
	try {
		outcome = await runCli(args);
	} catch (error: unknown) {
		const typed = asSdlcError(error);
		outcome = {
			exitCode: exitCodeForError(typed),
			result: { ok: false, error: typed.toJSON() },
			human: `${typed.code}: ${typed.message}`,
		};
	}
	if (parsedJson) process.stdout.write(`${JSON.stringify(outcome.result)}\n`);
	else process.stdout.write(`${outcome.human}\n`);
	if (!outcome.result.ok) process.stderr.write(`${outcome.human}\n`);
	const continuation = outcome.result?.continuation as { reason?: string } | undefined;
	if (
		outcome.exitCode === 3 ||
		continuation?.reason === 'HALTED' ||
		outcome.result?.state === 'HALTED'
	) {
		process.stderr.write(
			`\x07⚠️  [agent-sdlc] RUN HALTED: Operator intervention required (${
				continuation?.reason ??
				outcome.result?.blockedReason ??
				outcome.result?.state ??
				'HALTED'
			}).\n`,
		);
	}
	process.exitCode = outcome.exitCode;

	if (outcome.result.ok && !parsedJson) {
		await maybePromptLearningDebt({
			command: (outcome.result.command as string | undefined) || (args[0] ?? ''),
			result: outcome.result,
			rootDir: REPOSITORY_ROOT,
			streams: {
				stdin: process.stdin,
				stdout: process.stdout,
				stderr: process.stderr,
			},
			parsedJson,
			runCliFn: runCli,
		});
	}
}

function isDirectExecution(): boolean {
	if (!process.argv[1]) return false;
	try {
		return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
	}
}

if (isDirectExecution()) {
	main().catch((error: unknown) => {
		const typed = asSdlcError(error);
		process.stderr.write(`${typed.code}: ${typed.message}\n`);
		process.exitCode = exitCodeForError(typed);
	});
}
