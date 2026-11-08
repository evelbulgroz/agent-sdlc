import { invalidHostProfile } from './profile-validation.ts';

export const HOST_PROFILE_SCHEMA_VERSION = '1.7.0';
export const COMMANDS_HOST_PROFILE_SCHEMA_VERSION = '1.6.0';
export const ACCEPTANCE_HOST_PROFILE_SCHEMA_VERSION = '1.5.0';
export const ADAPTERS_HOST_PROFILE_SCHEMA_VERSION = '1.4.0';
export const PREVIOUS_HOST_PROFILE_SCHEMA_VERSION = '1.3.0';
export const LEGACY_HOST_PROFILE_SCHEMA_VERSION = '1.2.0';
const SUPPORTED_VERSIONS: readonly unknown[] = [
	HOST_PROFILE_SCHEMA_VERSION,
	COMMANDS_HOST_PROFILE_SCHEMA_VERSION,
	ACCEPTANCE_HOST_PROFILE_SCHEMA_VERSION,
	ADAPTERS_HOST_PROFILE_SCHEMA_VERSION,
	PREVIOUS_HOST_PROFILE_SCHEMA_VERSION,
	LEGACY_HOST_PROFILE_SCHEMA_VERSION,
];

/** Rejects fields that the declared schemaVersion does not yet support, before schema parsing. */
export function assertProfileVersionGates(rawRecord: Record<string, unknown>): void {
	if (!SUPPORTED_VERSIONS.includes(rawRecord.schemaVersion)) {
		invalidHostProfile(
			`Expected schemaVersion '${HOST_PROFILE_SCHEMA_VERSION}', got '${String(rawRecord.schemaVersion)}'`,
			{ schemaVersion: String(rawRecord.schemaVersion ?? '') },
		);
	}

	if (rawRecord.schemaVersion === LEGACY_HOST_PROFILE_SCHEMA_VERSION) {
		for (const requiredKey of ['stateDir', 'reviewDir', 'specDraftDir']) {
			if (typeof rawRecord[requiredKey] !== 'string' || rawRecord[requiredKey].length === 0) {
				invalidHostProfile(
					`Field '${requiredKey}' is required at schemaVersion '${LEGACY_HOST_PROFILE_SCHEMA_VERSION}'`,
					{ fieldName: requiredKey, schemaVersion: rawRecord.schemaVersion },
				);
			}
		}
		for (const key of ['runsDir', 'git', 'policy', 'architecture', 'qualityGate', 'learnings', 'telemetry', 'commandPolicy', 'engine', 'verificationPreparation']) {
			if (rawRecord[key] !== undefined) {
				invalidHostProfile(`Field '${key}' requires schemaVersion '${PREVIOUS_HOST_PROFILE_SCHEMA_VERSION}'`, {
					fieldName: key,
					schemaVersion: rawRecord.schemaVersion,
				});
			}
			if (rawRecord.evidenceAdapters !== undefined) {
				invalidHostProfile(`Field 'evidenceAdapters' requires schemaVersion '${ADAPTERS_HOST_PROFILE_SCHEMA_VERSION}'`, {
					fieldName: 'evidenceAdapters',
					schemaVersion: rawRecord.schemaVersion,
				});
			}
		}
		if (rawRecord.adapter === 'default') {
			for (const forbidden of ['hydration', 'commands', 'workspace']) {
				if (rawRecord[forbidden] !== undefined) {
					invalidHostProfile(
						`default profile at schemaVersion '${LEGACY_HOST_PROFILE_SCHEMA_VERSION}' cannot include '${forbidden}'`,
						{ fieldName: forbidden },
					);
				}
			}
		}
	} else {
		if (
			rawRecord.schemaVersion === PREVIOUS_HOST_PROFILE_SCHEMA_VERSION &&
			rawRecord.evidenceAdapters !== undefined
		) {
			invalidHostProfile(`Field 'evidenceAdapters' requires schemaVersion '${ADAPTERS_HOST_PROFILE_SCHEMA_VERSION}'`, {
				fieldName: 'evidenceAdapters',
				schemaVersion: rawRecord.schemaVersion,
			});
		}
		if (rawRecord.adapter === 'default' && rawRecord.commands !== undefined) {
			invalidHostProfile("default profile cannot include 'commands'", { fieldName: 'commands' });
		}
	}

	if (rawRecord.telemetry !== undefined && rawRecord.schemaVersion !== HOST_PROFILE_SCHEMA_VERSION) {
		invalidHostProfile(`Field 'telemetry' requires schemaVersion '${HOST_PROFILE_SCHEMA_VERSION}'`, {
			fieldName: 'telemetry',
			schemaVersion: String(rawRecord.schemaVersion),
		});
	}

	if (rawRecord.acceptanceEvidence !== undefined && rawRecord.schemaVersion !== HOST_PROFILE_SCHEMA_VERSION &&
		rawRecord.schemaVersion !== COMMANDS_HOST_PROFILE_SCHEMA_VERSION &&
		rawRecord.schemaVersion !== ACCEPTANCE_HOST_PROFILE_SCHEMA_VERSION) {
		invalidHostProfile(`Field 'acceptanceEvidence' requires schemaVersion '${ACCEPTANCE_HOST_PROFILE_SCHEMA_VERSION}'`, {
			fieldName: 'acceptanceEvidence',
			schemaVersion: String(rawRecord.schemaVersion),
		});
	}
}
