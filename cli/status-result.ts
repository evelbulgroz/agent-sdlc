// Read-only status result assembled from a projection instance.
import fs from 'node:fs';
import path from 'node:path';
import {
	type CoverageAdvisory,
	coverageAdvisoryFromSource,
} from '../execution/coverage-advisory.ts';
import type { ArtifactStore } from '../persistence/artifacts.ts';
import type { RunPaths } from '../persistence/run-paths.ts';
import type { RuntimeStore } from '../persistence/runtime-store.ts';
import type { RuntimeState } from '../policy/contracts.ts';
import { type ContinuationInputs, computeContinuation } from './continuation.ts';
import { projectHostInvocation } from './host-invocation.ts';
import { readCandidateLearnings } from './projection-artifacts.ts';
import { projectTaskProgress, projectTasks } from './status-document.ts';

export interface StatusProjectionLike {
	readonly rootDir: string;
	readonly paths: RunPaths;
	readonly runtimeStore: RuntimeStore;
	readonly artifactStore: ArtifactStore;
	continuationInputs(state: Readonly<RuntimeState>): ContinuationInputs;
}

export interface QaDivergenceItem {
	severity?: string;
	ruleId?: string;
	message?: string;
	evidence?: string;
	[key: string]: unknown;
}

export function assembleStatusResult(projection: StatusProjectionLike) {
	const state = projection.runtimeStore.getRun(projection.paths.runId);
	const inputs = projection.continuationInputs(state);
	const pending = inputs.pendingInterrupt;
	const auth = inputs.authorization;
	const maxGen = projection.runtimeStore.getMaxRecordedGeneration?.(projection.paths.runId) ?? 0;
	const gen =
		projection.runtimeStore.getGeneration(
			projection.paths.runId,
			state.activeGeneration ?? maxGen,
		) ??
		projection.runtimeStore.getGeneration(
			projection.paths.runId,
			state.semanticRepairsCount ?? 0,
		) ??
		projection.runtimeStore.getGeneration(projection.paths.runId, 0);
	const defaultWorktreePath = path.join(projection.paths.runtimeDir, 'worktree');
	const resolvedWorktreePath =
		state.integrationWorktreePath && fs.existsSync(state.integrationWorktreePath)
			? state.integrationWorktreePath
			: state.worktreePath && fs.existsSync(state.worktreePath)
				? state.worktreePath
				: fs.existsSync(defaultWorktreePath)
					? defaultWorktreePath
					: null;
	const events = projection.runtimeStore.listEvents(projection.paths.runId);
	const readyEvent = events
		.slice()
		.reverse()
		.find((e) => e.eventType === 'RUN_READY_FOR_GIT_APPROVAL');
	const doneEvent = events
		.slice()
		.reverse()
		.find((e) => e.eventType === 'RUN_COMPLETED');
	const readyPayload = readyEvent?.payload as Record<string, unknown> | undefined;
	const donePayload = doneEvent?.payload as Record<string, unknown> | undefined;
	const patchSummary =
		(donePayload?.patchSummary as string | null | undefined) ??
		(readyPayload?.patchSummary as string | null | undefined) ??
		null;
	const verificationEvidenceHash =
		(donePayload?.verificationEvidenceHash as string | null | undefined) ??
		(readyPayload?.verificationEvidenceHash as string | null | undefined) ??
		null;
	const frictionEvent = events
		.slice()
		.reverse()
		.find((e) => e.eventType === 'PROMPT_FRICTION_DETECTED');
	const frictionPayload = frictionEvent?.payload as Record<string, unknown> | undefined;
	const frictionAdvisory = (frictionPayload?.advisory as string | null | undefined) ?? null;
	const criticFailures = events
		.filter((event) => event.eventType === 'CRITIC_REVIEW_FAILED')
		.map((event) => {
			const payload = event.payload as Record<string, unknown> | undefined;
			return {
				phase: (payload?.phase as string | undefined) ?? 'unknown',
				code: (payload?.code as string | undefined) ?? 'GOVERNOR_ROUTES_EXHAUSTED',
				message:
					(payload?.message as string | undefined) ??
					'Critic unavailable after all configured provider routes failed',
			};
		});

	let qaDivergences: readonly QaDivergenceItem[] | null =
		(donePayload?.qaDivergences as readonly QaDivergenceItem[] | null | undefined) ??
		(readyPayload?.qaDivergences as readonly QaDivergenceItem[] | null | undefined) ??
		null;
	let coverageAdvisories: CoverageAdvisory | null =
		(donePayload?.coverageAdvisories as CoverageAdvisory | null | undefined) ??
		(readyPayload?.coverageAdvisories as CoverageAdvisory | null | undefined) ??
		null;

	if (!coverageAdvisories) {
		const covEvent = events
			.slice()
			.reverse()
			.find((e) => e.eventType === 'AC_COVERAGE_PASSED');
		const covPayload = covEvent?.payload as Record<string, unknown> | undefined;
		if (typeof covPayload?.coverageArtifact === 'string') {
			try {
				const coverage = projection.artifactStore.readJson(covPayload.coverageArtifact);
				if (coverage) coverageAdvisories = coverageAdvisoryFromSource(coverage);
			} catch {}
		}
		if (!coverageAdvisories && covPayload) {
			coverageAdvisories = coverageAdvisoryFromSource(covPayload);
		}
	}

	if (!qaDivergences) {
		const qaReviews = projection.runtimeStore
			.listCriticReviews(projection.paths.runId)
			.filter((r) => r.phase === 'qa');
		const first = qaReviews[0];
		if (first) {
			try {
				const manifestPath = path.isAbsolute(first.manifestPath)
					? first.manifestPath
					: path.join(projection.rootDir, first.manifestPath);
				if (fs.existsSync(manifestPath)) {
					const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
						reviews?: Array<{ reviewId?: string; phase?: string; reportPath?: string }>;
					};
					const entry = manifest.reviews?.find(
						(r) => r.reviewId === first.reviewId || r.phase === 'qa',
					);
					if (entry?.reportPath) {
						const reportPath = path.isAbsolute(entry.reportPath)
							? entry.reportPath
							: path.join(projection.rootDir, entry.reportPath);
						if (fs.existsSync(reportPath)) {
							const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
								findings?: QaDivergenceItem[];
							};
							qaDivergences = report.findings ?? [];
						}
					}
				}
			} catch {}
		}
	}
	if (!qaDivergences) qaDivergences = [];

	const gitCommit = projection.runtimeStore.getGitCommit(projection.paths.runId);
	const pullRequest = projection.runtimeStore.getPullRequest(projection.paths.runId);
	const taskPlan = projection.runtimeStore.getTaskPlan(projection.paths.runId);
	const tasks = projectTasks(taskPlan, state);
	const taskProgress = projectTaskProgress(taskPlan, tasks, state);
	const falseEconomyDiagnostics = projection.runtimeStore
		.listDiagnostics(projection.paths.runId, 'FALSE_ECONOMY_DETECTED')
		.map((d) => d.payload);
	const candidateLearnings = readCandidateLearnings({
		mode: 'lenient',
		legacyPath: path.join(projection.paths.runtimeDir, 'candidate-learnings.json'),
	});
	const continuation = computeContinuation(state, inputs);
	const hostInvocation = projectHostInvocation(state, inputs);
	return Object.freeze({
		schemaVersion: '1.0.0',
		runId: state.runId,
		runtimeRevision: state.runtimeRevision,
		state: state.state,
		draftHash: state.draftHash,
		approvedSpecHash: state.approvedSpecHash,
		completeness: state.completeness,
		blockedReason: state.blockedReason,
		continuation,
		hostInvocation,
		lastError: state.lastError,
		worktreePath: resolvedWorktreePath,
		baseCommitSha: auth?.baseCommitSha ?? null,
		targetTreeSha: state.targetTreeSha ?? gen?.targetTreeSha ?? null,
		commitSha: gitCommit?.commitSha ?? null,
		branch: gitCommit?.targetBranch ?? null,
		pullRequest: pullRequest
			? {
					url: pullRequest.prUrl,
					number: pullRequest.prNumber,
					draft: pullRequest.draft,
					branchName: pullRequest.branchName,
					baseBranch: pullRequest.baseBranch,
				}
			: null,
		tasks,
		taskProgress,
		optionalRoles: projection.runtimeStore
			.listOptionalRoleExecutions(projection.paths.runId)
			.map((r) => ({
				roleId: r.roleId,
				insertionPoint: r.insertionPoint,
				generation: r.generation,
				status: r.status,
				summary: r.summary,
			})),
		criticReviews: projection.runtimeStore
			.listCriticReviews(projection.paths.runId)
			.map((c) => ({
				phase: c.phase,
				generation: c.generation,
				reviewerVendor: c.reviewerVendor,
				reviewerModel: c.reviewerModel,
				findingsCount: c.findingsCount,
				hasP1: c.hasP1,
			})),
		...(falseEconomyDiagnostics.length > 0
			? { diagnostics: { falseEconomy: falseEconomyDiagnostics } }
			: {}),
		...(candidateLearnings ? { candidateLearnings } : {}),
		activeGeneration: gen?.generation ?? null,
		semanticRepairsCount: state.semanticRepairsCount ?? 0,
		patchSummary,
		verificationEvidenceHash,
		frictionAdvisory,
		criticFailures,
		qaDivergences,
		coverageAdvisories,
		pendingInterrupt: pending
			? {
					interruptId: pending.interruptId,
					kind: pending.kind,
					status: pending.status,
					request: pending.request,
				}
			: null,
	});
}

export type AssembledStatusResult = ReturnType<typeof assembleStatusResult>;
