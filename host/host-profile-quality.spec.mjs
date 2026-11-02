import assert from 'node:assert/strict';
import test from 'node:test';
import { HostProfileSchema } from './host-profile.ts';

test('HostProfileSchema accepts 1.4.0 evidence adapter registrations and legacy profile versions', () => {
	const profile = {
		schemaVersion: '1.4.0',
		profileId: 'quality-host',
		repositoryId: 'quality-host',
		adapter: 'default',
		evidenceAdapters: [{
			adapterId: 'unit-runner',
			protocolVersion: '1.0.0',
			bundleFiles: [{ path: 'tools/adapter.mjs', sha256: 'a'.repeat(64) }],
			dependencyFiles: [],
			configurationFiles: [],
			argv: ['node', 'tools/adapter.mjs'],
			profiles: [{ profileId: 'unit', layers: ['unit'], capabilities: [] }],
			qualificationArtifactHash: 'b'.repeat(64),
			limits: { timeoutMs: 1_000, maxReportBytes: 10_000, maxArtifactBytes: 10_000, maxArtifacts: 1 },
		}],
	};
	assert.equal(HostProfileSchema.parse(profile).evidenceAdapters.length, 1);
	assert.equal(HostProfileSchema.parse({ ...profile, schemaVersion: '1.3.0', evidenceAdapters: undefined }).schemaVersion, '1.3.0');
	assert.equal(HostProfileSchema.parse({ ...profile, schemaVersion: '1.2.0', evidenceAdapters: undefined }).schemaVersion, '1.2.0');
	assert.equal(HostProfileSchema.safeParse({ ...profile, evidenceAdapters: [{ ...profile.evidenceAdapters[0], unexpected: true }] }).success, false);
});
