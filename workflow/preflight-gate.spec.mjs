import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';
import { canonicalJson, sha256 } from '../policy/contracts.ts';
import { createMockExecCli, makeFixture } from '../testing/test-support.mjs';
import { collectQaBriefAndAdvisories } from './node-helpers.ts';
import { applyAcCoverageGate, executePreflightForSnapshot } from './preflight-gate.ts';

function persistRuntimeSnapshot(fixture, snapshot) {
	fixture.store.database
		.prepare('UPDATE runs SET state = ?, state_json = ?, state_hash = ? WHERE run_id = ?')
		.run(snapshot.state, canonicalJson(snapshot), sha256(snapshot), fixture.runId);
}

function prepareVerifierSnapshot(fixture, state) {
	const approvedSpecHash = 'a'.repeat(64);
	const baseCommitSha = 'b'.repeat(40);
	const targetTreeSha = 'c'.repeat(40);
	const initial = fixture.runtime.initialize({ runId: fixture.runId, goal: 'Retire autonomous repair' });
	const snapshot = {
		...initial,
		state,
		approvedSpecHash,
		worktreePath: fixture.runtimeDir,
		integrationWorktreePath: fixture.runtimeDir,
		targetTreeSha,
		activeGeneration: 0,
	};
	persistRuntimeSnapshot(fixture, snapshot);
	fixture.store.saveAuthorization(createDefaultAuthorizationEnvelope({
		runId: fixture.runId,
		approvedSpecHash,
		baseCommitSha,
		allowedPackages: ['apps/services/conditioning'],
		allowedPathPrefixes: ['apps/services/conditioning'],
	}));
	return { snapshot, baseCommitSha, targetTreeSha };
}

test('@ac AC-03 @case AC-03.3 @ac AC-05 applyAcCoverageGate does not block completion or trigger REPAIRING_FAILURE when criteria are uncovered', async () => {
	const fixture = makeFixture('graph-ac-05-advisory', []);
	try {
		const worktreeDir = fixture.rootDir;
		const draftArtifact = fixture.artifacts.writeJson('draft', {
			goal: 'Sample goal',
			acceptanceCriteria: ['AC-01: First test', 'AC-02: Second test'],
		});
		const preflightBindingArtifact = fixture.artifacts.writeJson('preflight-binding', {
			status: 'OK',
			canonical: true,
			preflightResultHash: sha256('preflight-pass'),
		});
		const initial = fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Sample goal',
		});
		const snapshot = {
			...initial,
			state: 'VERIFYING_PREFLIGHT',
			targetTreeSha: '0123456789abcdef0123456789abcdef01234567',
			activeGeneration: 0,
			worktreePath: worktreeDir,
			draftArtifact,
			preflightBindingArtifact,
		};
		fixture.store.database
			.prepare('UPDATE runs SET state = ?, state_json = ?, state_hash = ? WHERE run_id = ?')
			.run('VERIFYING_PREFLIGHT', canonicalJson(snapshot), sha256(snapshot), fixture.runId);
		const auth = {
			baseCommitSha: '0123456789abcdef0123456789abcdef01234567',
			allowedPathPrefixes: ['apps/services/conditioning'],
		};

		const { snapshot: next } = applyAcCoverageGate(
			fixture.runtime,
			snapshot,
			auth,
			worktreeDir,
			{
				preflightBindingArtifact,
				verificationEvidenceHash: sha256('preflight-pass'),
			},
		);

		assert.equal(next.state, 'REVIEWING_QA');
		const events = fixture.store.listEvents(fixture.runId);
		assert.equal(events.some((e) => e.eventType === 'AC_COVERAGE_FAILED'), false);
		assert.equal(events.some((e) => e.eventType === 'AC_COVERAGE_PASSED'), true);
		const passEvent = events.find((e) => e.eventType === 'AC_COVERAGE_PASSED');
		assert.equal(passEvent.payload.coveragePass, false);
		assert.ok(passEvent.payload.coverageArtifact);
		const savedArtifact = fixture.artifacts.readJson(passEvent.payload.coverageArtifact);
		assert.equal(savedArtifact.pass, false);
		const { coverageAdvisories } = collectQaBriefAndAdvisories(fixture.runtime, next);
		assert.equal(coverageAdvisories.coveragePass, false);
		assert.ok(Array.isArray(coverageAdvisories.uncoveredAcIds));
	} finally {
		fixture.close();
	}
});

test('@ac AC-03 @case AC-03.4 @ac AC-05 @case AC-05.1 a repairable preflight FAIL escalates with AUTONOMOUS_REPAIR_RETIRED', async () => {
	const fixture = makeFixture('graph-repair-retired-preflight', []);
	try {
		const { snapshot } = prepareVerifierSnapshot(fixture, 'VERIFYING_PREFLIGHT');
		fixture.runtime.execCli = createMockExecCli({ preflightStatus: 'FAIL' });
		const result = await executePreflightForSnapshot(fixture.runtime, snapshot);
		assert.equal(result.snapshot.state, 'ESCALATED');
		assert.equal(result.snapshot.blockedReason, 'AUTONOMOUS_REPAIR_RETIRED');
		assert.equal(fixture.governor.calls.length, 0);
		const blocked = fixture.store.listEvents(fixture.runId).filter((event) => event.eventType === 'RUN_BLOCKED').at(-1);
		assert.equal(blocked.payload.reason, 'AUTONOMOUS_REPAIR_RETIRED');
		assert.ok(blocked.payload.failurePacket);
	} finally {
		fixture.close();
	}
});
