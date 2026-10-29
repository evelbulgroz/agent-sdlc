import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sanitize } from '@evelbulgroz/model-usage-govenor/sanitize-failure-text';
import {
	HOST_PROFILE_RELATIVE_PATH,
	loadHostProfile,
	type HostProfile,
} from '../host/host-profile.ts';
import {
	DEFAULT_COMMAND_POLICY,
	matchesRepositoryScript,
	resolveCommandPolicy,
	type CommandPolicy,
} from '../host/command-policy.ts';
import { validateScriptCommand } from '../host/script.ts';
import { SdlcError } from '../policy/errors.ts';
import {
	type ParsedTestExecutionEvidence,
	parseTestExecutionEvidence,
} from './test-execution-evidence.ts';
import { presentPagedText } from './tool-read.ts';

const VERIFY_BASE_SHA_TOKEN_PATTERN = /^(?:[0-9a-f]{7,40}|HEAD)$/;
const ALLOWED_TARGETED_TEST_VERBS: ReadonlySet<string> = new Set([
	'test:unit',
	'test:integration',
	'test:e2e',
]);
const SHELL_INJECTION_PATTERN = /[;&|><`$\n\r]/;
export const ROLE_COMMAND_TIMEOUT_MS = 15 * 60 * 1000;

export type CommandExecFn = (
	command: string,
	args: readonly string[],
	options?: Record<string, unknown>,
) => string | Buffer;

export function validateCommandAllowlist(
	command: unknown,
	args: unknown,
	allowedPackages: readonly string[] = [],
	worktreeDir: string | null = null,
	policy: CommandPolicy = DEFAULT_COMMAND_POLICY,
): true {
	if (command !== 'pnpm') {
		throw new SdlcError(
			'INVALID_INPUT',
			`Only 'pnpm' commands are allowlisted, got: ${String(command)}`,
		);
	}

	if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
		throw new SdlcError('INVALID_INPUT', 'Command args must be an array of strings');
	}
	const strArgs = args as readonly string[];

	for (const arg of strArgs) {
		if (SHELL_INJECTION_PATTERN.test(arg)) {
			throw new SdlcError('INVALID_INPUT', `Argument '${arg}' contains disallowed shell characters`);
		}
		if (arg.includes('.git') || arg.includes('.agent-sdlc')) {
			throw new SdlcError('INVALID_INPUT', `Argument '${arg}' references forbidden directory`);
		}
	}

	if (strArgs.length === 0) {
		throw new SdlcError('INVALID_INPUT', 'Command arguments cannot be empty');
	}

	let targetPkg: string | null = null;
	let verbIndex = -1;

	if (strArgs[0] === '--filter') {
		if (strArgs.length < 3) {
			throw new SdlcError('INVALID_INPUT', 'pnpm --filter requires package target and command');
		}
		targetPkg = strArgs[1] ?? null;
		verbIndex = strArgs[2] === 'run' ? 3 : 2;
		const expectedLength = strArgs[2] === 'run' ? 4 : 3;
		const verb = strArgs[verbIndex] ?? '';
		const extraArgs = strArgs.slice(expectedLength);
		const targetedTestVerb = ALLOWED_TARGETED_TEST_VERBS.has(verb);
		const evidenceArgs = targetedTestVerb ? extraArgs : extraArgs.slice(1);
		const reporterArgs = evidenceArgs.filter(
			(arg) => arg === '--reporter=json' || arg === '--json',
		);
		const evidencePaths = evidenceArgs.filter(
			(arg) => arg !== '--reporter=json' && arg !== '--json',
		);
		const safeTestEvidenceArgs =
			(verb === 'test' || ALLOWED_TARGETED_TEST_VERBS.has(verb)) &&
			(targetedTestVerb || extraArgs[0] === '--') &&
			reporterArgs.length <= 1 &&
			evidencePaths.length > 0 &&
			evidencePaths.every(
				(arg) =>
					!arg.startsWith('-') &&
					!arg.includes('..') &&
					!arg.includes('\\') &&
					!path.posix.isAbsolute(arg) &&
					/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(arg),
			);
		if (strArgs.length !== expectedLength && !safeTestEvidenceArgs) {
			throw new SdlcError(
				'INVALID_INPUT',
				`Filtered role commands must exactly match an allowlisted test, build, lint, or typecheck command, optionally with a closed test-evidence suffix`,
			);
		}
	} else if (strArgs[0] === 'run') {
		verbIndex = 1;
		const isUnfilteredTestUnit = strArgs.length === 2 && strArgs[1] === 'test:unit';
		if (!isUnfilteredTestUnit && !matchesRepositoryScript(strArgs, policy)) {
			throw new SdlcError(
				'INVALID_INPUT',
				`Unfiltered repository role commands must exactly match 'pnpm run test:unit' or a script declared in the host profile commandPolicy.repositoryScripts`,
			);
		}
	} else {
		throw new SdlcError(
			'INVALID_INPUT',
			`Command must use 'pnpm --filter <pkg>' or 'pnpm run <verb>', got: pnpm ${strArgs.join(' ')}`,
		);
	}

	const verb = strArgs[verbIndex];
	if (targetPkg !== null) {
		if (!verb || (!policy.allowedVerbs.has(verb) && !ALLOWED_TARGETED_TEST_VERBS.has(verb))) {
			throw new SdlcError(
				'INVALID_INPUT',
				`Command verb '${String(verb)}' is not allowlisted (allowed: ${[
					...policy.allowedVerbs,
					...ALLOWED_TARGETED_TEST_VERBS,
				].join(', ')})`,
			);
		}
	}

	if (targetPkg !== null) {
		if (targetPkg.includes('...')) {
			throw new SdlcError(
				'INVALID_INPUT',
				`Package filter '${targetPkg}' cannot include '...' dependency expansion`,
			);
		}

		if (allowedPackages.length > 0) {
			const allowedSet = new Set<string>();
			for (const allowed of allowedPackages) {
				const cleanAllowed = allowed.replace(/\/+$/, '');
				allowedSet.add(cleanAllowed);
				const lookupDir = worktreeDir || process.cwd();
				const candidatePkgJson = path.join(lookupDir, cleanAllowed, 'package.json');
				if (fs.existsSync(candidatePkgJson)) {
					try {
						const parsed = JSON.parse(fs.readFileSync(candidatePkgJson, 'utf8')) as {
							name?: unknown;
						};
						if (typeof parsed.name === 'string' && parsed.name) {
							allowedSet.add(parsed.name);
						}
					} catch {}
				}
			}

			const cleanTarget = targetPkg.replace(/\/+$/, '');
			if (!allowedSet.has(cleanTarget)) {
				throw new SdlcError(
					'INVALID_INPUT',
					`Package filter '${targetPkg}' is not within authorized packages: ${allowedPackages.join(', ')}`,
					{ targetPkg, allowedPackages: [...allowedPackages] },
				);
			}
		}
	}

	return true;
}

export const MAX_COMMAND_OUTPUT_CHARS = 100_000;

export function truncateCommandOutput(
	text: unknown,
	maxChars = MAX_COMMAND_OUTPUT_CHARS,
): string {
	if (typeof text !== 'string' || text.length <= maxChars) {
		return typeof text === 'string' ? text : '';
	}
	if (maxChars < 120) {
		return text.slice(-maxChars);
	}
	const headLen = Math.min(2000, Math.floor(maxChars * 0.1));
	const reserved = 70;
	const tailLen = Math.max(0, maxChars - headLen - reserved);
	const omitted = text.length - headLen - tailLen;
	const result = `${text.slice(0, headLen)}\n... [output truncated: ${omitted} characters omitted] ...\n${text.slice(-tailLen)}`;
	return result.length <= maxChars ? result : result.slice(0, maxChars);
}

/**
 * Fits test-runner output into a prompt budget. Passing-test lines carry no
 * repair signal, so they go first; the rest keeps a short head (command echo)
 * and the tail, where failing assertions and the summary appear.
 */
export function condenseVerificationOutput(
	text: unknown,
	maxChars: number,
	headChars = 400,
): string {
	const value = String(text ?? '');
	if (value.length <= maxChars) return value;
	const kept = value
		.split('\n')
		.filter((line) => !/^\s*(?:✓|✔|↓)\s/.test(line))
		.join('\n');
	if (kept.length <= maxChars) return kept;
	const marker = '\n... [middle omitted for prompt budget] ...\n';
	const tailChars = Math.max(0, maxChars - headChars - marker.length);
	return `${kept.slice(0, headChars)}${marker}${kept.slice(-tailChars)}`;
}

export interface DiagnosticResultLike {
	readonly exitCode?: number;
	readonly stdout?: string;
	readonly stderr?: string;
	readonly error?: unknown;
}

export function formatRawDiagnosticOutput(
	result: DiagnosticResultLike | null | undefined,
	maxChars = MAX_COMMAND_OUTPUT_CHARS,
): string {
	const exitCode = result?.exitCode ?? (result?.error ? 1 : 0);
	const stdout = sanitize(result?.stdout ?? '').trim();
	const stderr = sanitize(result?.stderr ?? (result?.error ? String(result.error) : '')).trim();
	const parts: string[] = [];
	if (exitCode !== 0) {
		parts.push(`Process exited with code ${exitCode}.`);
	}
	if (stdout) {
		parts.push(`STDOUT:\n${stdout}`);
	}
	if (stderr) {
		parts.push(`STDERR:\n${stderr}`);
	}
	if (parts.length === 0) {
		return exitCode !== 0
			? `Process exited with code ${exitCode}.`
			: 'Command completed successfully with no output.';
	}
	return truncateCommandOutput(parts.join('\n\n'), maxChars);
}

function presentCommandStream(
	text: string,
	{
		worktreeDir,
		pageOverflow,
		label,
	}: { worktreeDir: string; pageOverflow: boolean; label: string },
): { text: string; pagedPath: string | null } {
	if (pageOverflow === true) {
		return presentPagedText(text, {
			worktreeDir,
			name: `cmd-${label}-${crypto.randomBytes(4).toString('hex')}`,
		});
	}
	return { text: truncateCommandOutput(text), pagedPath: null };
}

export interface RunCommandParameters {
	readonly command?: unknown;
	readonly args?: unknown;
	readonly [key: string]: unknown;
}

export interface RunCommandContext {
	readonly worktreeDir: string;
	readonly rootDir?: string;
	readonly profile?: HostProfile;
	readonly allowedPackages?: readonly string[];
	readonly execCli?: CommandExecFn;
	readonly pageOverflow?: boolean;
}

function matchesHostVerifyArgv(
	command: unknown,
	args: unknown,
	verifyArgv: readonly string[],
): boolean {
	if (typeof command !== 'string' || command.trim().length === 0 || !Array.isArray(args)) {
		return false;
	}
	if (args.some((arg) => typeof arg !== 'string' || arg.trim().length === 0)) {
		return false;
	}
	const candidate = [command, ...(args as readonly string[])];
	for (const token of candidate) {
		if (SHELL_INJECTION_PATTERN.test(token) || token.includes('\0') || token.includes('$(')) {
			throw new SdlcError('INVALID_INPUT', `Argument '${token}' contains disallowed shell characters`);
		}
		if (token.includes('.git') || token.includes('.agent-sdlc')) {
			throw new SdlcError('INVALID_INPUT', `Argument '${token}' references forbidden directory`);
		}
	}
	if (candidate.length !== verifyArgv.length) {
		return false;
	}
	return verifyArgv.every((expected, index) => {
		const actual = candidate[index] ?? '';
		return expected === '{baseSha}'
			? VERIFY_BASE_SHA_TOKEN_PATTERN.test(actual)
			: actual === expected;
	});
}

export function validateHostCommand(
	command: unknown,
	args: unknown,
	{
		worktreeDir = null,
		rootDir,
		profile,
		allowedPackages = [],
	}: {
		worktreeDir?: string | null;
		rootDir?: string;
		profile?: HostProfile;
		allowedPackages?: readonly string[];
	} = {},
): true {
	const resolvedProfile =
		profile ??
		(rootDir
			? loadHostProfile(rootDir)
			: worktreeDir && fs.existsSync(path.join(worktreeDir, HOST_PROFILE_RELATIVE_PATH))
				? loadHostProfile(worktreeDir)
				: null);
	if (resolvedProfile && matchesHostVerifyArgv(command, args, resolvedProfile.verify.argv)) {
		return true;
	}
	if (resolvedProfile && resolvedProfile.adapter === 'script') {
		validateScriptCommand(
			command,
			Array.isArray(args) ? args : [],
			resolvedProfile,
		);
		return true;
	}
	return validateCommandAllowlist(
		command,
		args,
		allowedPackages,
		worktreeDir,
		resolveCommandPolicy(resolvedProfile),
	);
}

export interface RunCommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly pagedPath?: string;
	readonly pagedStderrPath?: string;
	readonly testExecutionEvidence?: ParsedTestExecutionEvidence;
}

export function runCommandTool(
	parameters: RunCommandParameters | null | undefined,
	{
		worktreeDir,
		rootDir,
		profile,
		allowedPackages = [],
		execCli = execFileSync as CommandExecFn,
		pageOverflow = false,
	}: RunCommandContext,
): RunCommandResult {
	const command = parameters?.command;
	const args = parameters?.args;

	validateHostCommand(command, args, {
		worktreeDir,
		rootDir,
		profile,
		allowedPackages,
	});
	const validCommand = command as string;
	const validArgs = args as readonly string[];

	const execOptions: {
		cwd: string;
		encoding: BufferEncoding;
		stdio: ['ignore', 'pipe', 'pipe'];
		env: NodeJS.ProcessEnv;
		timeout: number;
	} = {
		cwd: worktreeDir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			CI: 'true',
		},
		timeout: ROLE_COMMAND_TIMEOUT_MS,
	};
	let exitCode = 0;
	let rawStdout = '';
	let rawStderr = '';
	try {
		const out = execCli(validCommand, validArgs, execOptions);
		rawStdout = typeof out === 'string' ? out : (out?.toString('utf8') ?? '');
	} catch (error) {
		const errObj = error as {
			stdout?: { toString(): string };
			stderr?: { toString(): string };
			message?: string;
			status?: number;
			code?: number;
		};
		rawStdout = errObj?.stdout?.toString() ?? '';
		rawStderr = errObj?.stderr?.toString() ?? errObj?.message ?? '';
		exitCode = errObj?.status ?? errObj?.code ?? 1;
	}
	const sanitizedStdout = sanitize(rawStdout);
	const sanitizedStderr = sanitize(rawStderr);
	const testExecutionEvidence = parseTestExecutionEvidence(
		exitCode === 0 ? sanitizedStdout : `${sanitizedStdout}\n${sanitizedStderr}`,
	);
	const stdout = presentCommandStream(sanitizedStdout, {
		worktreeDir,
		pageOverflow,
		label: 'stdout',
	});
	const stderr = presentCommandStream(sanitizedStderr, {
		worktreeDir,
		pageOverflow,
		label: 'stderr',
	});
	return {
		exitCode,
		stdout: stdout.text,
		stderr: stderr.text,
		...(stdout.pagedPath ? { pagedPath: stdout.pagedPath } : {}),
		...(stderr.pagedPath ? { pagedStderrPath: stderr.pagedPath } : {}),
		...(testExecutionEvidence.format ? { testExecutionEvidence } : {}),
	};
}
