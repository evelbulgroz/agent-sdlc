import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildReliabilityReport,
	compareReliabilityRoutes,
} from './report.ts';
import {
	mutationAttempt,
	routeStratum,
	runSummary,
	taskSummary,
	verificationAttempt,
} from '../../testing/reliability-fixtures.mjs';

test('@ac AC-04 AC-05 AC-06 reports stable denominators and keeps invalid edits visible', () => {
	const completed = taskSummary({
		taskId: 'completed',
		mutationAttempts: [
			mutationAttempt('completed', 1),
			mutationAttempt('completed', 2),
			mutationAttempt('completed', 3, 'rejected'),
			mutationAttempt('completed', 4, 'rejected'),
		],
	});
	const transient = taskSummary({
		taskId: 'transient',
		verificationAttempts: [
			verificationAttempt('transient', 1, 'failed'),
			verificationAttempt('transient', 2, 'passed', 'confirmation'),
		],
	});
	const repaired = taskSummary({
		taskId: 'repaired',
		repairInvoked: true,
		verificationAttempts: [
			verificationAttempt('repaired', 1, 'failed'),
			verificationAttempt('repaired', 2, 'passed', 'repair'),
		],
	});
	const cancelled = taskSummary({
		taskId: 'cancelled',
		status: 'cancelled',
		dispatched: false,
		mutationAttempts: [],
		verificationAttempts: [],
	});
	const report = buildReliabilityReport({
		rootDir: process.cwd(),
		runIds: [],
		summaries: [
			runSummary('run-metrics', [completed, transient, repaired, cancelled]),
		],
	});
	assert.deepEqual(report.metrics.taskCompletion, {
		numerator: 3,
		denominator: 3,
		exclusions: 1,
		rate: '100.00%',
	});
	assert.deepEqual(report.metrics.validEdit, {
		numerator: 4,
		denominator: 6,
		exclusions: 0,
		rate: '66.67%',
	});
	assert.equal(report.metrics.firstPassVerification.numerator, 1);
	assert.equal(report.metrics.firstPassVerification.denominator, 3);
	assert.deepEqual(report.metrics.repairSuccess, {
		numerator: 1,
		denominator: 1,
		exclusions: 3,
		rate: '100.00%',
	});
});

test('first-pass metric excludes a passing verification followed by an accepted mutation', () => {
	const laterMutation = mutationAttempt('task-a', 2);
	laterMutation.occurredAt = '2026-09-29T00:02:00.000Z';
	const report = buildReliabilityReport({
		rootDir: process.cwd(),
		runIds: [],
		summaries: [
			runSummary('run-post-verification-mutation', [
				taskSummary({
					mutationAttempts: [mutationAttempt('task-a', 1), laterMutation],
				}),
			]),
		],
	});

	assert.deepEqual(report.metrics.firstPassVerification, {
		numerator: 0,
		denominator: 1,
		exclusions: 0,
		rate: '0.00%',
	});
});

test('@ac AC-07 AC-08 recurrence deduplicates summaries and UNCLASSIFIED makes output incomplete', () => {
	const failures = [1, 2, 3].map((index) => ({
		runId: `run-${index}`,
		taskId: 'task-a',
		category: index === 3 ? 'UNCLASSIFIED' : 'INVALID_EDIT',
		occurredAt: `2026-09-2${index}T00:00:00.000Z`,
		evidence: 'bounded evidence',
	}));
	const summaries = failures.map((failure, index) =>
		runSummary(`run-${index + 1}`, [taskSummary()], [failure]),
	);
	const report = buildReliabilityReport({
		rootDir: process.cwd(),
		runIds: [],
		summaries: [...summaries, summaries[0]],
	});
	assert.equal(report.evidence.runs, 3);
	assert.equal(report.status, 'INCOMPLETE');
	assert.equal(
		report.failureRecurrence.find((entry) => entry.category === 'UNCLASSIFIED')
			.status,
		'PROVISIONAL',
	);
});

test('@ac AC-10 AC-11 route comparison requires five comparable attempts and stays advisory', () => {
	const insufficient = compareReliabilityRoutes({
		strata: [
			{
				...routeStratum('route-a', 4, 4, 4),
			},
			routeStratum('route-b', 4, 3, 3),
		],
	});
	assert.equal(insufficient.status, 'INSUFFICIENT_EVIDENCE');
	assert.equal(insufficient.preferredRoute, null);

	const sufficient = compareReliabilityRoutes({
		strata: [
			routeStratum('route-a', 5, 5, 5),
			routeStratum('route-b', 5, 3, 3),
		],
	});
	assert.equal(sufficient.status, 'OPERATOR_REVIEW_RECOMMENDED');
	assert.equal(sufficient.preferredRoute, 'route-a');
});

test('mutationAttempt with no status override records an accepted attempt', () => {
	const attempt = mutationAttempt('task-a', 1);
	assert.equal(attempt.status, 'accepted');
	assert.equal(attempt.rejectionCategory, null);
});
