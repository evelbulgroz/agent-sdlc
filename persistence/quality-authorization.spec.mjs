import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';
import { sha256 } from '../policy/contracts/primitives.ts';
import { H, T, initialize, makeFixture, policy } from '../testing/quality-test-support.mjs';
import { RuntimeStore } from './runtime-store.ts';
import { commandRegistrationFixture } from '../testing/command-registration-fixture.mjs';

test('approved quality authorization survives reopening and rejects changed contents under the same policy hash', () => {
	const fixture = makeFixture('quality-authorization');
	try {
		initialize(fixture);
		const adapter = commandRegistrationFixture({ adapterId: 'offline', limits: { timeoutMs: 100, maxReportBytes: 1000, maxArtifactBytes: 1000, maxArtifacts: 1 } });
		const qualityPlan = { qualityPolicy: policy, adapterBindings: [adapter], evidenceObligations: [{
			obligationId: 'obligation-a', criterionId: 'AC-01', caseId: null, owner: { kind: 'task', id: 'task-a' },
			observableOutcome: 'Visible', setupAction: 'Exercise', expectedResult: 'Pass',
			layer: 'unit', requiredCapabilities: [], implementationPaths: ['src/a.ts'],
			testCases: [{ file: 'src/a.spec.mjs', caseKey: 'case-a' }], adapterBindingHash: sha256(adapter), profileId: 'unit',
		}] };
		const authorization = createDefaultAuthorizationEnvelope({ runId: fixture.runId, approvedSpecHash: H,
			repositoryId: 'offline', baseCommitSha: T, allowedPackages: ['src'], allowedPathPrefixes: ['src'], qualityPlan });
		fixture.store.saveAuthorization(authorization);
		assert.deepEqual(fixture.store.getAuthorization(fixture.runId).qualityPlan, qualityPlan);
		assert.throws(() => fixture.store.saveAuthorization({ ...authorization, qualityPlan: {
			...qualityPlan, qualityPolicy: { ...policy, followUpDispatches: 0 },
		} }), /changed contents/);
		assert.deepEqual(fixture.store.getAuthorization(fixture.runId).qualityPlan, qualityPlan);
		fixture.store.close();
		const reopened = new RuntimeStore(path.join(fixture.runtimeDir, 'runtime.sqlite'));
		try {
			assert.deepEqual(reopened.getAuthorization(fixture.runId).qualityPlan, qualityPlan);
			const legacy = createDefaultAuthorizationEnvelope({ runId: fixture.runId, approvedSpecHash: H,
				repositoryId: 'offline', baseCommitSha: T, allowedPackages: ['src'], allowedPathPrefixes: ['src'] });
			reopened.saveAuthorization(legacy);
			assert.equal('qualityPlan' in reopened.getAuthorization(fixture.runId), false);
		} finally { reopened.close(); }
	} finally { fixture.close(); }
});
