import { commandBindingHash } from '../host/command-evidence.ts';
import type { CommandPinRecord, CommandPretestStep } from '../policy/contracts/quality-evidence-schema.ts';

const PROFILES = [{ profileId: 'unit', layers: ['unit'], capabilities: [] }];
const LIMITS = { timeoutMs: 5_000, maxReportBytes: 10_000, maxArtifactBytes: 10_000, maxArtifacts: 2 };

/** A schema-valid command registration for fixtures that never execute it; pass overrides for any field. */
export interface CommandRegistrationOverrides {
	argv?: string[];
	executable?: { path: string; sha256: string };
	pins?: CommandPinRecord[];
	pretest?: CommandPretestStep[];
	[key: string]: unknown;
}

export function commandRegistrationFixture(overrides: CommandRegistrationOverrides = {}) {
	const argv = overrides.argv ?? ['/usr/bin/node', 'run.mjs'];
	const executable = overrides.executable ?? { path: argv[0], sha256: 'a'.repeat(64) };
	const pins = overrides.pins ?? [];
	return {
		kind: 'command', adapterId: 'unit-adapter', protocolVersion: '1.0.0', argv, cwd: 'src', reportFormat: 'junit',
		retries: 0, executable, pins, commandSha256: commandBindingHash(argv, executable.sha256, pins, overrides.pretest ?? []),
		profiles: PROFILES, limits: LIMITS, ...overrides,
	};
}
