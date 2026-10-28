// Aggregates sanitized run summaries into completion, strata, and route comparison.

import { listContainedRunIds, resolveRunPaths } from '../../persistence/run-paths.ts';
import {
	RELIABILITY_SCHEMA_VERSION,
	type ReliabilityFailureCategory,
	canonicalJson,
} from '../contracts.ts';
import {
	type SanitizedFailureSummary,
	type SanitizedRunSummary,
	type SanitizedTaskSummary,
	readRuntimeEvidence,
	summaryFromRuntimeEvidence,
	validateSanitizedRunSummary,
} from './run-evidence.ts';
import { invalidContract, redactEvidence } from './sanitization.ts';

const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
	'completed',
	'failed',
	'blocked',
	'cancelled',
]);

export interface RateMetric {
	numerator: number;
	denominator: number;
	exclusions: number;
	rate: string;
}

export interface DistributionMetric {
	count: number;
	total: number | null;
	mean: number | null;
}

export interface ReliabilityStratum {
	complexityBand: string;
	targetPackage: string;
	deliveryLayers: string[];
	highRisk: boolean;
	routeId: string;
	modelId: string;
	failover: boolean;
	terminalAttempts: number;
	completion: RateMetric;
	validEdit: RateMetric;
	firstPassVerification: RateMetric;
	repairSuccess: RateMetric;
	latencyMs: DistributionMetric;
	inputTokens: DistributionMetric;
	outputTokens: DistributionMetric;
	costMicrousd: DistributionMetric;
}

export interface FailureRecurrenceEntry {
	category: ReliabilityFailureCategory;
	affectedRuns: number;
	affectedTasks: number;
	totalOccurrences: number;
	mostRecentOccurrence: string | null;
	status: 'RECOMMENDED' | 'PROVISIONAL';
}

export interface ReliabilityReport {
	schemaVersion: string;
	status: 'COMPLETE' | 'INCOMPLETE';
	evidence: {
		runs: number;
		tasks: number;
		exclusions: Array<{ runId: string; code: string; message: string }>;
	};
	metrics: {
		taskCompletion: RateMetric;
		validEdit: RateMetric;
		firstPassVerification: RateMetric;
		repairSuccess: RateMetric;
	};
	strata: ReliabilityStratum[];
	failureRecurrence: FailureRecurrenceEntry[];
	[key: string]: unknown;
}

export function buildReliabilityReport({
	rootDir,
	runIds = null,
	summaries = [],
}: {
	rootDir: string;
	runIds?: readonly string[] | null;
	summaries?: readonly unknown[];
}): ReliabilityReport {
	const selectedRunIds = runIds ?? listContainedRunIds(rootDir);
	const exclusions: Array<{ runId: string; code: string; message: string }> = [];
	const loaded: SanitizedRunSummary[] = [];
	for (const runId of selectedRunIds) {
		try {
			const paths = resolveRunPaths(runId, rootDir);
			loaded.push(summaryFromRuntimeEvidence(readRuntimeEvidence(paths.databasePath)));
		} catch (error) {
			const errObj = error as { code?: string; message?: string } | null;
			exclusions.push({
				runId,
				code: errObj?.code ?? 'INVALID_EVIDENCE',
				message: redactEvidence(errObj?.message ?? 'Evidence could not be read'),
			});
		}
	}
	for (const summary of summaries) {
		loaded.push(validateSanitizedRunSummary(summary));
	}
	const deduplicated = deduplicateSummaries(loaded);
	const tasks = deduplicated.flatMap((summary) =>
		summary.tasks.map((task) => ({ ...task, runId: summary.runId })),
	);
	const failures = deduplicated.flatMap((summary) => summary.failures);
	return {
		schemaVersion: RELIABILITY_SCHEMA_VERSION,
		status:
			exclusions.length > 0 ||
			failures.some((failure) => failure.category === 'UNCLASSIFIED')
				? 'INCOMPLETE'
				: 'COMPLETE',
		evidence: {
			runs: deduplicated.length,
			tasks: tasks.length,
			exclusions,
		},
		metrics: {
			taskCompletion: rate(
				tasks.filter(
					(task) =>
						task.dispatched &&
						!task.inconclusive &&
						TERMINAL_TASK_STATUSES.has(task.status),
				),
				(task) => task.status === 'completed',
				tasks.filter((task) => !task.dispatched || task.inconclusive).length,
			),
			validEdit: rateFromCounts(
				sum(
					tasks,
					(task) =>
						task.mutationAttempts.filter((item) => item.status === 'accepted').length,
				),
				sum(tasks, (task) => task.mutationAttempts.length),
				0,
			),
			firstPassVerification: rate(
				tasks.filter((task) => task.verificationAttempts.length > 0),
				hasFinalMutationBoundFirstPass,
				tasks.filter(
					(task) => task.dispatched && task.verificationAttempts.length === 0,
				).length,
			),
			repairSuccess: rate(
				tasks.filter((task) => task.repairInvoked),
				(task) => task.status === 'completed',
				tasks.filter((task) => !task.repairInvoked).length,
			),
		},
		strata: aggregateStrata(tasks),
		failureRecurrence: aggregateFailureRecurrence(failures),
	};
}

export function compareReliabilityRoutes(
	report: { strata: readonly ReliabilityStratum[] },
	{ minimumSample = 5 }: { minimumSample?: number } = {},
): Record<string, unknown> {
	const groups = new Map<string, ReliabilityStratum[]>();
	for (const stratum of report.strata) {
		if (stratum.routeId === 'unknown') continue;
		const key = canonicalJson({
			complexityBand: stratum.complexityBand,
			targetPackage: stratum.targetPackage,
			deliveryLayers: stratum.deliveryLayers,
			highRisk: stratum.highRisk,
			modelId: stratum.modelId,
			failover: stratum.failover,
		});
		const entries = groups.get(key) ?? [];
		entries.push(stratum);
		groups.set(key, entries);
	}
	const comparable = [...groups.entries()]
		.map(([key, entries]) => ({ key: JSON.parse(key) as unknown, entries }))
		.filter(({ entries }) => entries.length >= 2);
	const eligible = comparable.filter(({ entries }) =>
		entries.every((entry) => entry.terminalAttempts >= minimumSample),
	);
	if (eligible.length === 0) {
		return {
			schemaVersion: RELIABILITY_SCHEMA_VERSION,
			status: 'INSUFFICIENT_EVIDENCE',
			preferredRoute: null,
			minimumSample,
			comparable,
		};
	}
	const comparisons = eligible.map(({ key, entries }) => {
		const ranked = [...entries].sort(
			(left, right) =>
				routeScore(right) - routeScore(left) ||
				left.routeId.localeCompare(right.routeId),
		);
		const difference = routeScore(ranked[0]) - routeScore(ranked[1]);
		return { stratum: key, routes: ranked, scoreDifference: difference };
	});
	const recommended = comparisons.find(
		(comparison) => comparison.scoreDifference >= 0.1,
	);
	return {
		schemaVersion: RELIABILITY_SCHEMA_VERSION,
		status: recommended
			? 'OPERATOR_REVIEW_RECOMMENDED'
			: 'NO_MATERIAL_DIFFERENCE',
		preferredRoute: recommended?.routes[0]?.routeId ?? null,
		minimumSample,
		comparisons,
	};
}

function aggregateStrata(
	tasks: ReadonlyArray<SanitizedTaskSummary & { runId: string }>,
): ReliabilityStratum[] {
	const groups = new Map<
		string,
		{
			complexityBand: string;
			targetPackage: string;
			deliveryLayers: string[];
			highRisk: boolean;
			routeId: string;
			modelId: string;
			failover: boolean;
			tasks: Array<SanitizedTaskSummary & { runId: string }>;
		}
	>();
	for (const task of tasks) {
		const routeId = task.routeSequence.at(-1) ?? 'unknown';
		const modelId = task.modelSequence.at(-1) ?? 'unknown';
		const keyObject = {
			complexityBand: task.complexityBand,
			targetPackage: task.targetPackage,
			deliveryLayers: task.deliveryLayers,
			highRisk: task.highRisk,
			routeId,
			modelId,
			failover: task.failover,
		};
		const key = canonicalJson(keyObject);
		const bucket = groups.get(key) ?? { ...keyObject, tasks: [] };
		bucket.tasks.push(task);
		groups.set(key, bucket);
	}
	return [...groups.values()]
		.map((bucket) => ({
			complexityBand: bucket.complexityBand,
			targetPackage: bucket.targetPackage,
			deliveryLayers: bucket.deliveryLayers,
			highRisk: bucket.highRisk,
			routeId: bucket.routeId,
			modelId: bucket.modelId,
			failover: bucket.failover,
			terminalAttempts: bucket.tasks.filter((task) =>
				TERMINAL_TASK_STATUSES.has(task.status),
			).length,
			completion: rate(
				bucket.tasks.filter((task) => TERMINAL_TASK_STATUSES.has(task.status)),
				(task) => task.status === 'completed',
				0,
			),
			validEdit: rateFromCounts(
				sum(
					bucket.tasks,
					(task) =>
						task.mutationAttempts.filter((item) => item.status === 'accepted').length,
				),
				sum(bucket.tasks, (task) => task.mutationAttempts.length),
				0,
			),
			firstPassVerification: rate(
				bucket.tasks.filter((task) => task.verificationAttempts.length > 0),
				hasFinalMutationBoundFirstPass,
				0,
			),
			repairSuccess: rate(
				bucket.tasks.filter((task) => task.repairInvoked),
				(task) => task.status === 'completed',
				0,
			),
			latencyMs: distribution(bucket.tasks.map((task) => task.latencyMs)),
			inputTokens: distribution(bucket.tasks.map((task) => task.inputTokens)),
			outputTokens: distribution(bucket.tasks.map((task) => task.outputTokens)),
			costMicrousd: distribution(bucket.tasks.map((task) => task.costMicrousd)),
		}))
		.sort((left, right) =>
			canonicalJson(left).localeCompare(canonicalJson(right)),
		);
}

function aggregateFailureRecurrence(
	failures: readonly SanitizedFailureSummary[],
): FailureRecurrenceEntry[] {
	const identities = new Set<string>();
	const groups = new Map<
		ReliabilityFailureCategory,
		{
			category: ReliabilityFailureCategory;
			runs: Set<string>;
			tasks: Set<string>;
			totalOccurrences: number;
			mostRecentOccurrence: string | null;
		}
	>();
	for (const failure of failures) {
		const identity = `${failure.runId}\0${failure.taskId ?? ''}\0${failure.category}\0${failure.occurredAt}`;
		if (identities.has(identity)) continue;
		identities.add(identity);
		const bucket = groups.get(failure.category) ?? {
			category: failure.category,
			runs: new Set<string>(),
			tasks: new Set<string>(),
			totalOccurrences: 0,
			mostRecentOccurrence: null,
		};
		bucket.runs.add(failure.runId);
		if (failure.taskId) bucket.tasks.add(`${failure.runId}:${failure.taskId}`);
		bucket.totalOccurrences += 1;
		if (
			!bucket.mostRecentOccurrence ||
			failure.occurredAt > bucket.mostRecentOccurrence
		) {
			bucket.mostRecentOccurrence = failure.occurredAt;
		}
		groups.set(failure.category, bucket);
	}
	return [...groups.values()]
		.map((bucket) => ({
			category: bucket.category,
			affectedRuns: bucket.runs.size,
			affectedTasks: bucket.tasks.size,
			totalOccurrences: bucket.totalOccurrences,
			mostRecentOccurrence: bucket.mostRecentOccurrence,
			status: (bucket.runs.size >= 3 ? 'RECOMMENDED' : 'PROVISIONAL') as
				| 'RECOMMENDED'
				| 'PROVISIONAL',
		}))
		.sort((left, right) => left.category.localeCompare(right.category));
}

function deduplicateSummaries(
	summaries: readonly SanitizedRunSummary[],
): SanitizedRunSummary[] {
	const byRun = new Map<string, SanitizedRunSummary>();
	for (const summary of summaries) {
		const existing = byRun.get(summary.runId);
		if (!existing) {
			byRun.set(summary.runId, summary);
			continue;
		}
		if (existing.evidenceHash !== summary.evidenceHash) {
			throw invalidContract(
				`Conflicting duplicate reliability summary for ${summary.runId}`,
			);
		}
	}
	return [...byRun.values()].sort((left, right) =>
		left.runId.localeCompare(right.runId),
	);
}

function rate<T>(
	population: readonly T[],
	predicate: (item: T) => boolean,
	exclusions: number,
): RateMetric {
	return rateFromCounts(
		population.filter(predicate).length,
		population.length,
		exclusions,
	);
}

function hasFinalMutationBoundFirstPass(task: SanitizedTaskSummary): boolean {
	const firstVerification = [...task.verificationAttempts].sort(
		(left, right) => left.attempt - right.attempt,
	)[0];
	if (!firstVerification || firstVerification.status !== 'passed') return false;
	const verifiedAt = Date.parse(firstVerification.occurredAt);
	return !task.mutationAttempts.some(
		(attempt) =>
			attempt.status === 'accepted' &&
			Date.parse(attempt.occurredAt) >= verifiedAt,
	);
}

function rateFromCounts(
	numerator: number,
	denominator: number,
	exclusions: number,
): RateMetric {
	return {
		numerator,
		denominator,
		exclusions,
		rate:
			denominator === 0
				? 'not-applicable'
				: `${((numerator / denominator) * 100).toFixed(2)}%`,
	};
}

function sum<T>(items: readonly T[], selector: (item: T) => number): number {
	return items.reduce((total, item) => total + selector(item), 0);
}

function distribution(values: ReadonlyArray<number | null>): DistributionMetric {
	const known = values.filter(
		(value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
	);
	if (known.length === 0) return { count: 0, total: null, mean: null };
	const total = known.reduce((sumValue, value) => sumValue + value, 0);
	return { count: known.length, total, mean: Math.round(total / known.length) };
}

function routeScore(stratum: ReliabilityStratum): number {
	const completion =
		stratum.completion.denominator === 0
			? 0
			: stratum.completion.numerator / stratum.completion.denominator;
	const firstPass =
		stratum.firstPassVerification.denominator === 0
			? 0
			: stratum.firstPassVerification.numerator /
				stratum.firstPassVerification.denominator;
	return completion * 0.6 + firstPass * 0.4;
}
