import type { HostProfile } from './host-profile.ts';

export interface CommandPolicy {
	/** Verbs allowed after `pnpm --filter <pkg> [run]`. */
	readonly allowedVerbs: ReadonlySet<string>;
	/** Exact argv lists (starting `pnpm run`) allowed to run unfiltered, beyond the built-in `pnpm run test:unit`. */
	readonly repositoryScripts: readonly (readonly string[])[];
	/** Unfiltered scripts appended to the verification commands of contract-producing tasks. Implicitly allowlisted. */
	readonly contractGateScripts: readonly (readonly string[])[];
}

export const DEFAULT_ALLOWED_VERBS: readonly string[] = [
	'test',
	'build',
	'lint',
	'typecheck',
	'build:contracts',
	'check:contract-drift',
];

export const DEFAULT_COMMAND_POLICY: CommandPolicy = Object.freeze({
	allowedVerbs: new Set(DEFAULT_ALLOWED_VERBS),
	repositoryScripts: [],
	contractGateScripts: [],
});

export function resolveCommandPolicy(
	profile: Pick<HostProfile, 'commandPolicy'> | null | undefined,
): CommandPolicy {
	const declared = profile?.commandPolicy;
	if (!declared) return DEFAULT_COMMAND_POLICY;
	return {
		allowedVerbs: new Set(declared.allowedVerbs ?? DEFAULT_ALLOWED_VERBS),
		repositoryScripts: [...(declared.repositoryScripts ?? []), ...(declared.contractGateScripts ?? [])],
		contractGateScripts: declared.contractGateScripts ?? [],
	};
}

export function matchesRepositoryScript(
	args: readonly string[],
	policy: CommandPolicy,
): boolean {
	const argv = ['pnpm', ...args];
	return policy.repositoryScripts.some(
		(script) => script.length === argv.length && script.every((part, index) => part === argv[index]),
	);
}
