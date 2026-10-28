import { SdlcError } from '../policy/errors.ts';

export interface ParsedArguments {
	command: string;
	values: Map<string, string>;
	booleans: Set<string>;
}

const VALUE_FLAGS = new Set([
	'--slug',
	'--goal',
	'--goal-file',
	'--task-plan-file',
	'--author-vendor',
	'--run',
	'--interrupt',
	'--response',
	'--response-file',
	'--dest',
	'--envelope-file',
	'--branch-name',
	'--learning-insight',
	'--learning-scope',
	'--learning-type',
	'--learning-key',
	'--learning-query',
	'--key',
	'--spec-hash',
	'--role',
	'--fixture',
	'--phase',
	'--turns',
	'--from-run',
	'--step',
	'--executor',
	'--root',
]);

const BOOLEAN_FLAGS = new Set([
	'--json',
	'--skip-canary',
	'--stdin',
	'--overwrite',
	'--interactive',
	'--create-branch',
	'--create-local-commits',
	'--push',
	'--open-pr',
	'--draft',
	'--apply',
	'--yes',
	'--retry',
	'--dry-run',
]);

const COMMAND_FLAGS = new Map<string, Set<string>>([
	[
		'start',
		new Set([
			'--slug',
			'--goal',
			'--goal-file',
			'--task-plan-file',
			'--author-vendor',
			'--executor',
			'--skip-canary',
			'--root',
			'--json',
		]),
	],
	[
		'resume',
		new Set([
			'--run',
			'--retry',
			'--response',
			'--response-file',
			'--author-vendor',
			'--learning-insight',
			'--learning-scope',
			'--learning-type',
			'--learning-key',
			'--learning-query',
			'--json',
		]),
	],
	['status', new Set(['--run', '--json'])],
	['approve', new Set(['--run', '--spec-hash', '--json'])],
	['list', new Set(['--json'])],
	['answer', new Set(['--run', '--interrupt', '--response-file', '--stdin', '--json'])],
	[
		'authorize',
		new Set([
			'--run',
			'--envelope-file',
			'--interactive',
			'--create-branch',
			'--create-local-commits',
			'--push',
			'--open-pr',
			'--branch-name',
			'--json',
		]),
	],
	['pr', new Set(['--run', '--push', '--open-pr', '--draft', '--json'])],
	['cancel', new Set(['--run', '--json'])],
	['export', new Set(['--run', '--dest', '--overwrite', '--json'])],
	[
		'post-mortem',
		new Set([
			'--run',
			'--learning-insight',
			'--learning-scope',
			'--learning-type',
			'--learning-key',
			'--learning-query',
			'--json',
		]),
	],
	['prune-runs', new Set(['--dry-run', '--json'])],
	['skills', new Set(['--run', '--apply', '--key', '--yes', '--json'])],
	['help', new Set(['--json'])],
	['check-spec', new Set(['--goal', '--goal-file', '--task-plan-file', '--json'])],
	['reliability replay', new Set(['--json'])],
	['reliability report', new Set(['--run', '--json'])],
	['reliability routes', new Set(['--run', '--json'])],
	['canary check', new Set(['--goal-file', '--task-plan-file', '--json'])],
	['canary qualify', new Set(['--run', '--json'])],
	[
		'canary step',
		new Set([
			'--role',
			'--fixture',
			'--phase',
			'--turns',
			'--from-run',
			'--step',
			'--dest',
			'--json',
		]),
	],
	[
		'shell start',
		new Set([
			'--slug',
			'--goal-file',
			'--task-plan-file',
			'--response-file',
			'--executor',
			'--skip-canary',
			'--json',
		]),
	],
	['shell status', new Set(['--run', '--json'])],
	['shell reply', new Set(['--run', '--response-file', '--json'])],
	['shell watch', new Set(['--run', '--json'])],
	['host check', new Set(['--root', '--json'])],
]);

/**
 * `--hitl-tty` and `interview` were removed in favor of the `shell`
 * subcommand (docs/specs/retired/agent-sdlc-operator-shell.md). Fail closed
 * rather than silently ignoring the flag/command so stale callers learn the
 * replacement immediately instead of getting an unexpectedly different run.
 */
function rejectRemovedInteractiveSurface(normalizedArgs: readonly string[]): void {
	if (normalizedArgs[0] === 'interview') {
		throw new SdlcError(
			'INVALID_INPUT',
			"The 'interview' command was removed; use 'shell reply' (see the agent-sdlc-shell skill) instead",
		);
	}
	if (normalizedArgs.includes('--hitl-tty')) {
		throw new SdlcError(
			'INVALID_INPUT',
			"'--hitl-tty' was removed; use the 'shell' subcommand (see the agent-sdlc-shell skill) instead",
		);
	}
}

export function parseArguments(args: readonly string[]): ParsedArguments {
	let normalizedArgs = Array.isArray(args) && args[0] === '--' ? args.slice(1) : args;
	if (!Array.isArray(normalizedArgs) || normalizedArgs.length === 0) {
		throw new SdlcError('INVALID_INPUT', usage());
	}
	rejectRemovedInteractiveSurface(normalizedArgs);
	let command = normalizedArgs[0] ?? '';
	if (
		(command === 'reliability' ||
			command === 'canary' ||
			command === 'shell' ||
			command === 'host') &&
		typeof normalizedArgs[1] === 'string' &&
		!normalizedArgs[1].startsWith('-')
	) {
		command = `${command} ${normalizedArgs[1]}`;
		normalizedArgs = [command, ...normalizedArgs.slice(2)];
	}
	if (
		command === '--help' ||
		command === '-h' ||
		command === 'help' ||
		normalizedArgs.includes('--help') ||
		normalizedArgs.includes('-h')
	) {
		return { command: 'help', values: new Map(), booleans: new Set() };
	}
	const values = new Map<string, string>();
	const booleans = new Set<string>();
	for (let index = 1; index < normalizedArgs.length; index += 1) {
		const argument = normalizedArgs[index] ?? '';
		if (VALUE_FLAGS.has(argument)) {
			const nextArg = normalizedArgs[index + 1];
			if (
				values.has(argument) ||
				index + 1 >= normalizedArgs.length ||
				typeof nextArg !== 'string' ||
				nextArg.startsWith('--')
			) {
				throw new SdlcError('INVALID_INPUT', `Invalid or duplicate value for ${argument}`);
			}
			values.set(argument, nextArg);
			index += 1;
		} else if (BOOLEAN_FLAGS.has(argument)) {
			if (booleans.has(argument)) {
				throw new SdlcError('INVALID_INPUT', `Duplicate flag ${argument}`);
			}
			booleans.add(argument);
		} else {
			throw new SdlcError('INVALID_INPUT', `Unknown argument '${argument}'`);
		}
	}
	const allowed = COMMAND_FLAGS.get(command);
	if (!allowed) throw new SdlcError('INVALID_INPUT', `Unknown command '${command}'`);
	for (const flag of [...values.keys(), ...booleans]) {
		if (!allowed.has(flag)) {
			throw new SdlcError('INVALID_INPUT', `${flag} is not valid for ${command}`);
		}
	}
	return { command, values, booleans };
}

export function requiredValue(parsed: ParsedArguments, flag: string): string {
	const value = parsed.values.get(flag);
	if (!value) throw new SdlcError('INVALID_INPUT', `${flag} is required`);
	return value;
}

export function usage(): string {
	return [
		'Usage: agent-sdlc <command> [options]',
		'',
		'Commands:',
		'  start        Start a new autonomous SDLC run',
		'               --slug <slug> --goal <text> | --goal-file <path> [--task-plan-file <path>] [--executor minimal] [--skip-canary] [--json]',
		'  check-spec   Validate a spec without creating a run',
		'               --goal <text> | --goal-file <path> [--task-plan-file <path>] [--json]',
		'  reliability replay',
		'               Replay the provider-free sanitized reliability corpus [--json]',
		'  reliability report',
		'               Aggregate read-only reliability evidence [--run <run-id>] [--json]',
		'  reliability routes',
		'               Compare implementer routes within comparable strata [--run <run-id>] [--json]',
		'  canary check Validate a one-task hosted canary before creating a run',
		'               --goal-file <path> --task-plan-file <path> [--json]',
		'  canary qualify',
		'               Qualify a completed hosted canary --run <run-id> [--json]',
		'  resume       Resume until the next human gate',
		'               --run <run-id> [--retry] [--response <resp>] [--response-file <path>] [--json]',
		'  approve      Approve the pending specification',
		'               --run <run-id> --spec-hash <hash> [--json]',
		'  status       Show current run status and pending actions',
		'               --run <run-id> [--json]',
		'  list         List all local runs [--json]',
		'  answer       Answer a pending question interrupt non-interactively',
		'               --run <run-id> --response-file <path> | --stdin [--json]',
		'  authorize    Authorize spec implementation with envelope',
		'               --run <run-id> --envelope-file <path> [--create-local-commits] [--push] [--open-pr]',
		'  pr           Prepare draft pull request for a finished run',
		'               --run <run-id> [--push] [--open-pr] [--draft]',
		'  cancel       Cancel a running or pending run [--run <run-id>]',
		'  export       Export run artifacts to a destination directory',
		'               --run <run-id> --dest <path> [--overwrite]',
		'  prune-runs   Clean merged worktrees and archive idle runs [--dry-run] [--json]',
		'  skills       Trace skill learning and prompt attribution',
		'               [--run <run-id>] [--apply --key <key> [--yes]] [--json]',
		'  shell start  Operator shell: validate a goal and start a run once a brief is confirmed',
		'               --goal-file <path> [--slug <slug>] [--task-plan-file <path>] [--response-file <path>] [--executor minimal] [--skip-canary] [--json]',
		'  shell status Operator shell: read-only status and pending continuation card',
		'               --run <run-id> [--json]',
		'  shell reply  Operator shell: submit an operator response for the pending continuation card',
		'               --run <run-id> --response-file <path> [--json]',
		'  shell watch  Operator shell: replay mechanical continuation cards until a human gate is reached',
		'               --run <run-id> [--json]',
		'  help, -h     Show this help message',
	].join('\n');
}
