import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFailurePacket } from '../policy/contracts.ts';
import { buildFailurePacket } from '../review/failure-packet.ts';
import { buildStatusDocument } from './status-document.ts';
import { computeContinuation } from './continuation.ts';
import { buildIntegrationFailure, integrationFailureFromState } from './status-integration-failure.ts';

const INPUT = {
	state: {
		runId: 'run-1',
		state: 'PLANNING_TASKS',
		runtimeRevision: 1,
		semanticRepairsCount: 0,
		draftHash: 'draft',
		pendingInterruptId: null,
		updatedAt: '2026-10-22T00:00:00.000Z',
	},
	reservation: {
		projectionRevision: 1,
		updatedAt: '2026-10-22T00:00:00.000Z',
		git: { branch: 'main', headSha: 'abc', worktreePath: null, dirty: false },
	},
	auth: null,
	taskPlan: null,
	continuation: { action: 'resume', reason: 'INFRASTRUCTURE_RETRY' },
	hostInvocation: { argv: ['pnpm', 'run', 'agent:sdlc', '--', 'resume'] },
	rootDir: '/tmp/repo',
	runDir: '/tmp/repo/run',
	eventLogHash: 'event',
};

const packet = { classification: 'quality_failure', targetPaths: ['services/billing/src/kept.ts'] };

test('@ac AC-01 @case AC-01.1 coverage floor failure maps to coverage_floor_regression', () => {
	const record = buildIntegrationFailure({
		haltPath: 'AUTONOMOUS_REPAIR_RETIRED',
		failurePacket: packet,
		diagnostics: { schemaVersion: '1', coverageFloor: { pass: false, paths: ['services/billing/src/orphan.ts'] } },
	});
	assert.equal(record.haltPath, 'AUTONOMOUS_REPAIR_RETIRED');
	assert.equal(record.classification, 'quality_failure');
	assert.equal(record.category, 'coverage_floor_regression');
	assert.deepEqual([...record.targetPaths], ['services/billing/src/orphan.ts']);
	assert.equal(record.continuation, 'stop');
});

test('@ac AC-01 @case AC-01.2 an unchanged jscpd clone at new lines maps to baseline_clone_line_shift', () => {
	const record = buildIntegrationFailure({
		haltPath: 'AUTONOMOUS_REPAIR_RETIRED',
		failurePacket: packet,
		diagnostics: {
			schemaVersion: '1',
			clones: [{ tool: 'jscpd', baseline: 'services/billing/src/a.ts:1-2', observed: 'services/billing/src/a.ts:9-10', textUnchanged: true }],
		},
	});
	assert.equal(record.category, 'baseline_clone_line_shift');
	assert.deepEqual([...record.targetPaths], ['services/billing/src/a.ts']);
});

test('@ac AC-01 @case AC-01.3 a changed clone maps to quality_regression', () => {
	const record = buildIntegrationFailure({
		haltPath: 'AUTONOMOUS_REPAIR_RETIRED',
		failurePacket: packet,
		diagnostics: {
			schemaVersion: '1',
			clones: [{ tool: 'jscpd', baseline: 'services/billing/src/a.ts:1-2', observed: 'services/billing/src/a.ts:1-2', textUnchanged: false }],
		},
	});
	assert.equal(record.category, 'quality_regression');
});

test('@ac AC-01 @case AC-01.4 a contract drift failure maps to contract_drift', () => {
	const record = buildIntegrationFailure({
		haltPath: 'AUTONOMOUS_REPAIR_RETIRED',
		failurePacket: packet,
		diagnostics: { schemaVersion: '1', contractDrift: { pass: false, paths: ['services/billing/src/api.ts'] } },
	});
	assert.equal(record.category, 'contract_drift');
	assert.deepEqual([...record.targetPaths], ['services/billing/src/api.ts']);
});

test('@ac AC-01 @case AC-01.5 a missing diagnostics object maps to unclassified and falls back to packet paths', () => {
	const record = buildIntegrationFailure({ haltPath: 'AUTONOMOUS_REPAIR_RETIRED', failurePacket: packet, diagnostics: null });
	assert.equal(record.category, 'unclassified');
	assert.deepEqual([...record.targetPaths], ['services/billing/src/kept.ts']);
	assert.equal(integrationFailureFromState({ lastError: null }), null);
	assert.equal(integrationFailureFromState({ lastError: { metadata: { integrationFailure: { haltPath: 'NOPE' } } } }), null);
});

test('@ac AC-01 @case AC-01.6 a committed-tree halt uses the same record shape', () => {
	const record = buildIntegrationFailure({
		haltPath: 'AUTONOMOUS_REPAIR_RETIRED',
		failurePacket: { classification: 'test_failure', targetPaths: [] },
		diagnostics: { schemaVersion: '1', contractDrift: { pass: false, paths: ['services/billing/src/api.ts'] } },
	});
	assert.deepEqual(Object.keys(record).sort(), ['category', 'classification', 'continuation', 'haltPath', 'targetPaths']);
	assert.equal(record.classification, 'test_failure');
	assert.equal(record.category, 'contract_drift');
});

test('@ac AC-03 @case AC-03.1 coverage_floor_regression carries paths and no remedy text', () => {
	const record = buildIntegrationFailure({
		haltPath: 'QUALITY_CHECKPOINT_PREFLIGHT',
		failurePacket: packet,
		diagnostics: { schemaVersion: '1', coverageFloor: { pass: false, paths: ['services/billing/src/orphan.ts'] } },
	});
	assert.equal(record.continuation, 'approve-correction');
	assert.equal(JSON.stringify(record).includes('delet'), false);
	assert.equal(Object.hasOwn(record, 'remedy'), false);
});

test('@ac AC-03 @case AC-03.3 validateFailurePacket still rejects an extra category key', () => {
	const built = buildFailurePacket({
		runId: '2026-11-10-sdlc-packet',
		failedCommand: 'pnpm test',
		exitCode: 1,
		output: 'assertion failed',
		targetPaths: ['services/billing'],
		baseCommitSha: 'a'.repeat(40),
	});
	assert.throws(() => validateFailurePacket({ ...built, category: 'coverage_floor_regression' }), /unknown field 'category'/);
});

test('@ac AC-03 @case AC-03.4 AC_COVERAGE_FAILED prose is not relabeled coverage_floor_regression', () => {
	const record = buildIntegrationFailure({
		haltPath: 'AUTONOMOUS_REPAIR_RETIRED',
		failurePacket: { classification: 'test_failure', targetPaths: ['services/billing'], sanitizedOutput: 'AC_COVERAGE_FAILED' },
		diagnostics: null,
	});
	assert.equal(record.category, 'unclassified');
});

test('@ac AC-02 @case AC-02.2 an out-of-scope halt forces unclassified', () => {
	const record = buildIntegrationFailure({
		haltPath: 'VERIFICATION_OUTSIDE_AUTHORIZED_SCOPE',
		failurePacket: packet,
		diagnostics: { schemaVersion: '1', coverageFloor: { pass: false, paths: ['services/billing/src/orphan.ts'] } },
	});
	assert.equal(record.category, 'unclassified');
	assert.deepEqual([...record.targetPaths], ['services/billing/src/kept.ts']);
	assert.equal(record.continuation, 'stop');
});

test('@ac AC-04 @case AC-04.1 escalated repair retirement is visible and continuation stops', () => {
	const integrationFailure = buildIntegrationFailure({
		haltPath: 'AUTONOMOUS_REPAIR_RETIRED',
		failurePacket: packet,
		diagnostics: null,
	});
	const state = {
		...INPUT.state,
		state: 'ESCALATED',
		blockedReason: 'AUTONOMOUS_REPAIR_RETIRED',
		lastError: { code: 'AUTONOMOUS_REPAIR_RETIRED', message: 'retired', metadata: { integrationFailure } },
	};
	const continuation = computeContinuation(state);
	const status = buildStatusDocument({ ...INPUT, state, continuation });
	assert.equal(status.blockedReason, 'AUTONOMOUS_REPAIR_RETIRED');
	assert.equal(status.continuation.action, 'stop');
	assert.equal(status.integrationFailure.category, 'unclassified');
	assert.equal(status.integrationFailure.haltPath, 'AUTONOMOUS_REPAIR_RETIRED');
});

test('@ac AC-04 @case AC-04.2 a run with no preflight failure omits integrationFailure', () => {
	const status = buildStatusDocument(INPUT);
	assert.equal(Object.hasOwn(status, 'integrationFailure'), false);
	assert.equal(status.blockedReason, null);
	const escalatedWithoutReason = buildStatusDocument({
		...INPUT,
		state: { ...INPUT.state, state: 'ESCALATED', blockedReason: null, lastError: null },
	});
	assert.equal(escalatedWithoutReason.blockedReason, null);
	assert.equal(Object.hasOwn(escalatedWithoutReason, 'integrationFailure'), false);
});
