import { commandBindingHash } from '../host/command-evidence.ts';

const PROFILES = [{ profileId: 'unit', layers: ['unit'], capabilities: [] }];
const LIMITS = { timeoutMs: 5_000, maxReportBytes: 10_000, maxArtifactBytes: 10_000, maxArtifacts: 2 };

/** A schema-valid command registration for fixtures that never execute it; pass overrides for any field. */
export function commandRegistrationFixture(overrides = {}) {
	const argv = overrides.argv ?? ['/usr/bin/node', 'run.mjs'];
	const executable = overrides.executable ?? { path: argv[0], sha256: 'a'.repeat(64) };
	const pins = overrides.pins ?? [];
	return {
		kind: 'command', adapterId: 'unit-adapter', protocolVersion: '1.0.0', argv, cwd: 'src', reportFormat: 'junit',
		retries: 0, executable, pins, commandSha256: commandBindingHash(argv, executable.sha256, pins, overrides.pretest ?? []),
		profiles: PROFILES, limits: LIMITS, ...overrides,
	};
}
