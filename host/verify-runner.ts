import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { COMMAND_MAX_BUFFER_BYTES } from '../execution/tool-commands.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import {
	DEFAULT_VERIFY_HEAD_FIELD,
	DEFAULT_VERIFY_REQUIRE,
	HOST_PROFILE_RELATIVE_PATH,
	loadHostProfile,
	type HostProfile,
	type HostVerifyConfig,
} from './host-profile.ts';

export type VerifyExecCliFn = (
	command: string,
	args: readonly string[],
	options: {
		cwd: string;
		encoding: 'utf8';
		stdio: ['ignore', 'pipe', 'pipe'];
		maxBuffer?: number;
		env?: NodeJS.ProcessEnv;
	},
) => unknown;

export interface HostVerifyPassOutcome {
	status: 'PASS';
	ok: true;
	exitCode: 0;
	command: string;
	argv: readonly string[];
	result: Record<string, unknown>;
	preflightResult: Record<string, unknown>;
}

export interface HostVerifyFailOutcome {
	status: 'FAIL';
	ok: false;
	exitCode: number;
	command: string;
	argv: readonly string[];
	output: string;
	processFailed: boolean;
}

export type HostVerifyOutcome = HostVerifyPassOutcome | HostVerifyFailOutcome;

function resolveVerifyConfig({
	worktreeDir,
	rootDir,
	profile,
	verify,
}: {
	worktreeDir: string;
	rootDir?: string;
	profile?: HostProfile;
	verify?: HostVerifyConfig;
}): HostVerifyConfig {
	if (verify) {
		return verify;
	}
	if (profile) {
		return profile.verify;
	}
	if (rootDir) {
		return loadHostProfile(rootDir).verify;
	}
	const worktreeProfilePath = path.join(worktreeDir, HOST_PROFILE_RELATIVE_PATH);
	if (fs.existsSync(worktreeProfilePath)) {
		return loadHostProfile(worktreeDir).verify;
	}
	return loadHostProfile(REPOSITORY_ROOT).verify;
}

export async function runHostVerify({
	worktreeDir,
	rootDir,
	profile,
	verify,
	baseSha,
	baseCommitSha,
	expectedHead,
	expectedHeadSha,
	headLabel = 'authorized base',
	expectedBase,
	execCli = execFileSync,
}: {
	worktreeDir: string;
	rootDir?: string;
	profile?: HostProfile;
	verify?: HostVerifyConfig;
	baseSha?: string;
	baseCommitSha?: string;
	expectedHead?: string;
	expectedHeadSha?: string;
	headLabel?: string;
	expectedBase?: string;
	execCli?: VerifyExecCliFn;
}): Promise<HostVerifyOutcome> {
	const verifyConfig = resolveVerifyConfig({ worktreeDir, rootDir, profile, verify });
	const resolvedBaseSha = baseSha ?? baseCommitSha ?? '';
	const resolvedExpectedHead = expectedHead ?? expectedHeadSha ?? resolvedBaseSha;
	const argv = Object.freeze(
		verifyConfig.argv.map((token) => token.replaceAll('{baseSha}', resolvedBaseSha)),
	);
	const executable = argv[0] ?? '';
	const args = argv.slice(1);
	const command = argv.join(' ');

	let stdout = '';
	let stderr = '';
	let exitCode = 0;
	try {
		const rawOut = await Promise.resolve(
			execCli(executable, args, {
				cwd: worktreeDir,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				maxBuffer: COMMAND_MAX_BUFFER_BYTES,
				env: {
					...process.env,
					CI: 'true',
				},
			}),
		);
		stdout = String(rawOut ?? '');
	} catch (error: unknown) {
		const errObj =
			error && typeof error === 'object'
				? (error as {
						status?: unknown;
						code?: unknown;
						stdout?: unknown;
						stderr?: unknown;
						message?: unknown;
				  })
				: {};
		const rawExit = errObj.status ?? errObj.code;
		exitCode = typeof rawExit === 'number' ? rawExit : 1;
		stdout = errObj.stdout != null ? String(errObj.stdout) : '';
		stderr =
			errObj.stderr != null
				? String(errObj.stderr)
				: typeof errObj.message === 'string'
					? errObj.message
					: '';
	}

	if (!verifyConfig.resultPath) {
		if (exitCode !== 0) {
			return {
				status: 'FAIL',
				ok: false,
				exitCode,
				command,
				argv,
				output: `${stdout}\n${stderr}`,
				processFailed: true,
			};
		}
		const preflightResult: Record<string, unknown> = {
			status: 'OK',
			canonical: true,
			exitCode: 0,
			base: resolvedBaseSha,
			gitHeadSha: resolvedExpectedHead,
		};
		return {
			status: 'PASS',
			ok: true,
			exitCode: 0,
			command,
			argv,
			result: preflightResult,
			preflightResult,
		};
	}

	const resultFilePath = path.join(worktreeDir, verifyConfig.resultPath);
	if (exitCode !== 0 || !fs.existsSync(resultFilePath)) {
		return {
			status: 'FAIL',
			ok: false,
			exitCode: exitCode !== 0 ? exitCode : 1,
			command,
			argv,
			output: `${stdout}\n${stderr}`,
			processFailed: true,
		};
	}

	let preflightResult: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(resultFilePath, 'utf8'));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('Preflight JSON is not an object');
		}
		preflightResult = parsed as Record<string, unknown>;
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			status: 'FAIL',
			ok: false,
			exitCode: 1,
			command,
			argv,
			output: `Failed to parse ${path.basename(verifyConfig.resultPath)}: ${message}`,
			processFailed: false,
		};
	}

	const requiredOutcome = verifyConfig.require ?? DEFAULT_VERIFY_REQUIRE;
	const headField = verifyConfig.headField ?? DEFAULT_VERIFY_HEAD_FIELD;

	if (
		preflightResult.status !== requiredOutcome.status ||
		preflightResult.canonical !== requiredOutcome.canonical
	) {
		const resultExit =
			typeof preflightResult.exitCode === 'number' && preflightResult.exitCode !== 0
				? preflightResult.exitCode
				: 1;
		return {
			status: 'FAIL',
			ok: false,
			exitCode: resultExit,
			command,
			argv,
			output: `Preflight reported non-canonical outcome: status=${String(preflightResult.status)}, canonical=${String(preflightResult.canonical)}`,
			processFailed: false,
		};
	}

	if (
		typeof expectedBase === 'string' &&
		expectedBase.length > 0 &&
		preflightResult.base !== undefined &&
		preflightResult.base !== expectedBase
	) {
		return {
			status: 'FAIL',
			ok: false,
			exitCode: 1,
			command,
			argv,
			output: `Preflight result base commit '${String(preflightResult.base)}' does not match authorized base '${expectedBase}'`,
			processFailed: false,
		};
	}

	const actualHead = preflightResult[headField];
	if (resolvedExpectedHead.length > 0 && actualHead !== resolvedExpectedHead) {
		return {
			status: 'FAIL',
			ok: false,
			exitCode: 1,
			command,
			argv,
			output: `Preflight result ${headField} '${String(actualHead)}' does not match ${headLabel} '${resolvedExpectedHead}'`,
			processFailed: false,
		};
	}

	return {
		status: 'PASS',
		ok: true,
		exitCode: 0,
		command,
		argv,
		result: preflightResult,
		preflightResult,
	};
}
