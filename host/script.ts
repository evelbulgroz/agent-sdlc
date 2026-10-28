import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SdlcError } from '../policy/errors.ts';
import type { HydrationRunnerFn } from '../workflow/hydration.ts';
import {
	HOST_PROFILE_RELATIVE_PATH,
	loadHostProfile,
	type HostProfile,
	type ScriptHostProfile,
} from './host-profile.ts';

const FORBIDDEN_ARG_PATTERNS: readonly RegExp[] = Object.freeze([
	/[;&|`$\n\r\0]/,
	/\$\(/,
	/(^|[\\/])\.git([\\/]|$)/,
	/(^|[\\/])\.agent-sdlc([\\/]|$)/,
	/\.git/,
	/\.agent-sdlc/,
]);

function assertSafeToken(token: unknown, label: string): asserts token is string {
	if (typeof token !== 'string' || token.trim().length === 0) {
		throw new SdlcError('INVALID_INPUT', `Script command ${label} must be a non-empty string`);
	}
	for (const pattern of FORBIDDEN_ARG_PATTERNS) {
		if (pattern.test(token)) {
			throw new SdlcError(
				'INVALID_INPUT',
				`Command ${label} '${token}' contains forbidden characters or paths`,
			);
		}
	}
}

function resolveCommandsList(
	profileOrCommands?:
		| HostProfile
		| { commands?: readonly (readonly string[])[] }
		| readonly (readonly string[])[],
): readonly (readonly string[])[] {
	if (!profileOrCommands) {
		return [];
	}
	if (Array.isArray(profileOrCommands)) {
		return profileOrCommands;
	}
	if ('commands' in profileOrCommands && Array.isArray(profileOrCommands.commands)) {
		return profileOrCommands.commands;
	}
	return [];
}

export function validateScriptCommand(
	command: unknown,
	args: readonly unknown[],
	profileOrCommands?:
		| HostProfile
		| { commands?: readonly (readonly string[])[] }
		| readonly (readonly string[])[],
): void {
	assertSafeToken(command, 'executable');
	if (!Array.isArray(args)) {
		throw new SdlcError('INVALID_INPUT', 'Command arguments must be an array');
	}
	const stringArgs: string[] = [];
	for (const arg of args) {
		assertSafeToken(arg, 'argument');
		stringArgs.push(arg);
	}
	const candidate = [command, ...stringArgs];
	const allowedCommands = resolveCommandsList(profileOrCommands);
	const matched = allowedCommands.some(
		(entry) =>
			entry.length === candidate.length &&
			entry.every((token, index) => token === candidate[index]),
	);
	if (!matched) {
		throw new SdlcError(
			'INVALID_INPUT',
			`Command '${candidate.join(' ')}' is not allowlisted in host profile commands`,
		);
	}
}

export const validateCommand = validateScriptCommand;

function resolveScriptHydration({
	worktreeDir,
	rootDir,
	profile,
	hydration,
}: {
	worktreeDir: string;
	rootDir?: string;
	profile?: HostProfile | ScriptHostProfile;
	hydration?: readonly (readonly string[])[];
}): readonly (readonly string[])[] {
	if (hydration) {
		return hydration;
	}
	if (profile && profile.adapter === 'script') {
		return Array.isArray(profile.hydration) ? profile.hydration : (profile.hydration?.steps ?? []);
	}
	const targetRoot =
		rootDir ??
		(fs.existsSync(path.join(worktreeDir, HOST_PROFILE_RELATIVE_PATH))
			? worktreeDir
			: undefined);
	if (targetRoot) {
		const loaded = loadHostProfile(targetRoot);
		if (loaded.adapter === 'script') {
			return Array.isArray(loaded.hydration) ? loaded.hydration : (loaded.hydration?.steps ?? []);
		}
	}
	return [];
}

export async function hydrateScriptWorktree({
	worktreeDir,
	rootDir,
	profile,
	hydration,
	runner = execFileSync as HydrationRunnerFn,
}: {
	worktreeDir: string;
	rootDir?: string;
	profile?: HostProfile | ScriptHostProfile;
	hydration?: readonly (readonly string[])[];
	runner?: HydrationRunnerFn;
}): Promise<{ status: 'HYDRATED'; stepsCompleted: string[] }> {
	const steps = resolveScriptHydration({ worktreeDir, rootDir, profile, hydration });
	const stepsCompleted: string[] = [];
	for (const argv of steps) {
		const executable = argv[0] ?? '';
		const args = argv.slice(1);
		await Promise.resolve(
			runner(executable, args, {
				cwd: worktreeDir,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			}),
		);
		stepsCompleted.push(argv.join(' '));
	}
	return {
		status: 'HYDRATED',
		stepsCompleted,
	};
}

export const hydrate = hydrateScriptWorktree;
