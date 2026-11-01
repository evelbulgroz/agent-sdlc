import assert from 'node:assert/strict';
import test from 'node:test';
import { validateStatus } from '../agent-status-validate.ts';
import { buildStatusDocument } from './status-document.ts';
import { projectVerificationPreparation } from './status-preparation.ts';

const POLICY = 'a'.repeat(64);
const SELECTION = 'b'.repeat(64);

function prepared(taskId, status, timestamp, extra = {}) {
	return {
		eventType: 'VERIFICATION_PREPARED',
		timestamp,
		payload: { taskId, status, evidenceArtifact: 'c'.repeat(64), selectionHash: 'd'.repeat(64), candidateDigest: 'e'.repeat(64), failure: null, ...extra },
	};
}

const INPUT = {
	state: { runId: '2026-11-01-prep-status', state: 'EXECUTING_TASKS', runtimeRevision: 4, semanticRepairsCount: 0, draftHash: 'draft', pendingInterruptId: null, updatedAt: '2026-11-01T00:00:00.000Z' },
	reservation: { projectionRevision: 1, updatedAt: '2026-11-01T00:00:00.000Z', git: { branch: 'main', headSha: 'abc', worktreePath: null, dirty: false }, stateHash: 'state' },
	auth: null,
	taskPlan: null,
	continuation: { action: 'resume', reason: 'INFRASTRUCTURE_RETRY' },
	hostInvocation: { argv: ['pnpm', 'run', 'agent:sdlc', '--', 'resume'] },
	rootDir: '/tmp/repo',
	runDir: '/tmp/repo/run',
	eventLogHash: 'event',
};

test('@ac AC-05 @case AC-05.3 status identifies the bound policy, selection and latest outcome per task', () => {
	const failure = { stepId: 'build-base', reason: 'build-failed' };
	const projection = projectVerificationPreparation(
		[
			prepared('task-1', 'passed', '2026-11-01T00:00:01.000Z'),
			{ eventType: 'TASK_COMPLETED', payload: { taskId: 'task-1' } },
			prepared('final', 'failed', '2026-11-01T00:00:03.000Z', { failure }),
			prepared('task-1', 'failed', '2026-11-01T00:00:02.000Z', { failure }),
		],
		{ preparationPolicyHash: POLICY },
		{ preparationSelectionHash: SELECTION },
	);
	assert.equal(projection.policyHash, POLICY);
	assert.equal(projection.selectionHash, SELECTION);
	assert.deepEqual(projection.latest.map((entry) => [entry.taskId, entry.status]), [['final', 'failed'], ['task-1', 'failed']]);
	assert.deepEqual(projection.latest[1].failure, failure);
	assert.equal(projection.latest[1].recordedAt, '2026-11-01T00:00:02.000Z');
});

test('@ac AC-05 @case AC-05.4 runs without preparation project nothing new', () => {
	assert.equal(projectVerificationPreparation([], null, {}), null);
	assert.equal(projectVerificationPreparation([{ eventType: 'TASK_COMPLETED', payload: {} }], { preparationPolicyHash: null }, { preparationSelectionHash: null }), null);
	const status = buildStatusDocument(INPUT);
	assert.equal(Object.hasOwn(status.verification, 'preparation'), false);
});

test('preparation projection is published under verification and adds no status validation errors', () => {
	const preparation = projectVerificationPreparation([prepared('task-1', 'passed', '2026-11-01T00:00:01.000Z')], { preparationPolicyHash: POLICY }, { preparationSelectionHash: SELECTION });
	const withPreparation = buildStatusDocument({ ...INPUT, preparation });
	const without = buildStatusDocument(INPUT);
	assert.deepEqual(withPreparation.verification.preparation, preparation);
	assert.notEqual(withPreparation.orchestration.projectionHash, without.orchestration.projectionHash);
	// The minimal fixture has unrelated validator findings; preparation must not add any.
	assert.deepEqual(validateStatus(withPreparation).errors, validateStatus(without).errors);
});

test('@ac AC-03 @case AC-03.8 exploratory preparation for model commands is kept out of status', () => {
	const projection = projectVerificationPreparation(
		[
			prepared('task-1', 'passed', '2026-11-01T00:00:01.000Z'),
			prepared('task-1', 'failed', '2026-11-01T00:00:02.000Z', { purpose: 'exploratory' }),
		],
		{ preparationPolicyHash: POLICY },
		{ preparationSelectionHash: SELECTION },
	);
	assert.deepEqual(projection.latest.map((entry) => entry.status), ['passed']);
	assert.equal(projectVerificationPreparation([prepared('task-1', 'passed', 't', { purpose: 'exploratory' })], null, {}), null);
});
