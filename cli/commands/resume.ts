import fs from 'node:fs';
import path from 'node:path';
import { loadLearningStore } from '../../host/learnings.ts';
import { RepositoryModelGovernor } from '../../adapters/model-governor.ts';
import type { CandidateLearningInput } from '../../persistence/learning-records.ts';
import {
	type DagTask,
	type RuntimeState,
	TERMINAL_STATES,
	createEvent,
} from '../../policy/contracts.ts';
import { SdlcError, isGovernorRecoverableError } from '../../policy/errors.ts';
import {
	localPolicyChanged,
	localPolicyFingerprint,
} from '../../policy/local-policy-fingerprint.ts';
import { canonicalizeAuthorVendor } from '../../review/author-vendor.ts';
import { resolveTargetScope } from '../../roles/upstream-recall.ts';
import { type ParsedArguments, requiredValue } from '../arguments.ts';
import {
	isInfrastructureContinuation,
	isRunDeadlineHalt,
} from '../continuation.ts';
import { validatePendingResponse } from '../hitl.ts';
import { type OpenContextOptions, openContext } from '../run-context.ts';
import type { CliStreams } from '../shell-driver.ts';
import {
	promptOptionalLearning,
	synthesizeLearningPayload,
} from './candidate-learning.ts';
import { verifyContainmentAndOracles } from './resume-escalation.ts';

function collectTaskDescendants(
	tasks: readonly DagTask[],
	rootTaskIds: ReadonlySet<string>,
): Set<string> {
	const descendants = new Set(rootTaskIds);
	let changed = true;
	while (changed) {
		changed = false;
		for (const task of tasks) {
			if (
				!descendants.has(task.taskId) &&
				task.dependsOn.some((dependency) => descendants.has(dependency))
			) {
				descendants.add(task.taskId);
				changed = true;
			}
		}
	}
	return descendants;
}

export async function resumeRun(
	parsed: ParsedArguments,
	{
		rootDir,
		governor: injectedGovernor,
		onBoundary,
		gitCli,
		execCli,
		ghCli,
		streams,
		localPolicyPath = null,
	}: {
		rootDir: string;
		governor?: OpenContextOptions['governor'];
		onBoundary?: OpenContextOptions['onBoundary'];
		gitCli?: OpenContextOptions['gitCli'];
		execCli?: OpenContextOptions['execCli'];
		ghCli?: OpenContextOptions['ghCli'];
		streams?: CliStreams;
		localPolicyPath?: string | null;
	},
): Promise<Record<string, unknown>> {
	const runId = requiredValue(parsed, '--run');
	const governor = injectedGovernor ?? new RepositoryModelGovernor({ rootDir, localPolicyPath });
	if (typeof governor.assertAvailable === 'function') {
		await governor.assertAvailable();
	}
	const context = openContext({
		rootDir,
		runId,
		governor,
		onBoundary,
		gitCli,
		execCli,
		ghCli,
		localPolicyPath,
	});
	try {
		await context.projection.reconcile();
		let state = context.store.getRun(runId);
		if (state.state !== 'SNAPSHOT_GENERATION') {
			state = await context.runtime.synchronizeCheckpoint(state);
		}
		if (parsed.values.has('--author-vendor')) {
			const authorVendor = canonicalizeAuthorVendor(parsed.values.get('--author-vendor'));
			state = { ...state, authorVendor };
		}

		const isRetry = parsed.booleans.has('--retry');
		const auth = context.store.getAuthorization(runId);
		const maxSemanticRepairs = auth?.maxSemanticRepairs ?? 2;
		const taskPlan = context.store.getTaskPlan(runId);
		const hasFailedTask = Boolean(
			taskPlan?.tasks?.some(
				(task) => task.status === 'failed' || task.status === 'blocked',
			),
		);
		const isExhaustedRepair =
			(state.state === 'FAILED' || state.state === 'ESCALATED') &&
			((state.semanticRepairsCount ?? 0) >= maxSemanticRepairs ||
				state.blockedReason === 'REPAIR_BUDGET_EXHAUSTED' ||
				state.lastError?.code === 'REPAIR_BUDGET_EXHAUSTED');
		const isRetryableTaskFailure =
			(state.state === 'FAILED' ||
				state.state === 'ESCALATED' ||
				((state.state === 'BLOCKED' || state.state === 'BUDGET_EXHAUSTED') &&
					isRetry &&
					hasFailedTask)) &&
			(hasFailedTask ||
				state.lastError?.code === 'TASK_EXECUTION_FAILED' ||
				state.lastError?.code === 'BUDGET_EXHAUSTED' ||
				state.lastError?.metadata?.implementerStatus === 'step_limit_reached');
		const isRetryableFailure = isExhaustedRepair || isRetryableTaskFailure;

		if (isRetry && !isRetryableFailure) {
			throw new SdlcError(
				'INVALID_INPUT',
				'resume --retry is only permitted for a failed task or an exhausted semantic repair budget in FAILED or ESCALATED',
			);
		}

		if (isRetryableFailure && !isRetry) {
			return { ...context.projection.readStatusResult(), state: state.state };
		}

		if (
			TERMINAL_STATES.has(state.state) &&
			!(
				state.state === 'FAILED' &&
				(isGovernorRecoverableError(state.lastError) ||
					state.taskPlanHash ||
					context.store.getTaskPlan(runId))
			)
		) {
			return { ...context.projection.readStatusResult(), state: state.state };
		}
		const pending = context.store.getPendingInterrupt(runId);
		const lastOperationId = state.lastError?.metadata?.operationId;
		const recoverableReviewerBudgetDenial =
			state.state === 'BUDGET_EXHAUSTED' &&
			state.lastError?.code === 'GOVERNOR_BUDGET_DENIED' &&
			(state.lastError?.metadata?.dimension === 'maxPromptTokens' ||
				state.lastError?.metadata?.dimension === 'totalTokens') &&
			(lastOperationId === `${runId}:reviewer:g${state.activeGeneration}` ||
				(typeof lastOperationId === 'string' && lastOperationId.includes(':reviewer:')) ||
				(typeof lastOperationId === 'string' && lastOperationId.includes(':critic:'))) &&
			Boolean(state.taskPlanHash && (state.targetTreeSha || state.integrationWorktreePath));
		if (
			pending?.status === 'PENDING' &&
			(parsed.values.has('--response') || parsed.values.has('--response-file'))
		) {
			let rawResponse: Record<string, unknown>;
			if (parsed.values.has('--response-file')) {
				const responseFile = path.resolve(
					rootDir,
					parsed.values.get('--response-file') ?? '',
				);
				rawResponse = JSON.parse(fs.readFileSync(responseFile, 'utf8')) as Record<
					string,
					unknown
				>;
			} else {
				const raw = parsed.values.get('--response') ?? '';
				try {
					rawResponse = JSON.parse(raw) as Record<string, unknown>;
				} catch {
					rawResponse = { action: raw };
				}
			}
			const responseObj = {
				interruptId: pending.interruptId,
				stateHash: pending.stateHash,
				...rawResponse,
			};
			const request = context.artifacts.readJson(pending.requestArtifact);
			const draft = context.artifacts.readJson(state.draftArtifact);
			const validated = validatePendingResponse({
				state,
				interrupt: pending,
				request,
				response: responseObj,
				draft,
			});
			const responseArtifact = context.artifacts.writeJson(
				'human-response',
				validated.response,
			);
			context.store.recordInterruptResponse(pending.interruptId, responseArtifact);
			state = await context.runtime.invokeStoredResponse(state);
		} else if (pending?.status === 'RESPONSE_RECORDED') {
			state = await context.runtime.invokeStoredResponse(state);
		} else if (pending) {
			return { ...context.projection.readStatusResult(), state: state.state };
		} else if (!pending) {
			if (state.state === 'SNAPSHOT_GENERATION') {
				state = await context.runtime.startExternalTransition(state);
			} else if (isRetry || recoverableReviewerBudgetDenial) {
				if (isRetry) {
					context.store.clearContinuationAttempts(runId);
				}
				const authRecord = context.store.getAuthorization(runId);
				if (!authRecord) {
					if (!state.approvedSpecHash && state.completeness?.complete) {
						state = await context.runtime.startExternalTransition(state);
					} else {
						throw new SdlcError(
							'AUTHORIZATION_INVALID',
							`Cannot resume run '${runId}' without authorization envelope`,
						);
					}
				} else {
					const worktreeDir = state.integrationWorktreePath || state.worktreePath;
					if (!worktreeDir || !fs.existsSync(worktreeDir)) {
						throw new SdlcError(
							'WORKTREE_FAILED',
							`Worktree directory does not exist for run '${runId}'`,
						);
					}

					verifyContainmentAndOracles({
						worktreeDir,
						auth: authRecord,
						targetTreeSha: state.targetTreeSha,
						firstGen: context.store.getGeneration(runId, 0),
						gitCli: context.gitCli,
					});

					let candidateLearning: CandidateLearningInput | null = null;
					let insight = parsed.values.get('--learning-insight');
					let rawScope = parsed.values.get('--learning-scope');
					if (!insight && streams?.stdin?.isTTY) {
						const prompted = await promptOptionalLearning(streams);
						if (prompted) {
							insight = prompted.insight;
							rawScope = prompted.scope;
						}
					}

					const hasMultiTaskPlan = Boolean(
						taskPlan && taskPlan.tasks && taskPlan.tasks.length > 0,
					);
					const maxRecordedGen = context.store.getMaxRecordedGeneration?.(runId) ?? -1;
					const currentGeneration = state.activeGeneration ?? 0;
					const nextGeneration = Math.max(currentGeneration + 1, maxRecordedGen + 1);

					if (insight) {
						const scope = resolveTargetScope([
							rawScope ||
								authRecord.allowedPathPrefixes?.[0] ||
								authRecord.allowedPackages?.[0] ||
								'global',
						]);
						const existingLearnings = await loadLearningStore(path.join(rootDir, '.learnings.jsonl'));
						const existingCandidates = context.store.listCandidateLearnings(runId);
						candidateLearning = await synthesizeLearningPayload({
							runId,
							generation: nextGeneration,
							insight,
							scope,
							type: parsed.values.get('--learning-type'),
							key: parsed.values.get('--learning-key'),
							query: parsed.values.get('--learning-query'),
							sourceRole: 'operator',
							existingLearnings,
							existingCandidates,
						});
					}

					const targetState: RuntimeState['state'] =
						hasMultiTaskPlan && !state.integrationWorktreePath
							? 'EXECUTING_IMPLEMENTATION'
							: 'SNAPSHOT_GENERATION';
					const nextState: RuntimeState = {
						...state,
						state: targetState,
						activeGeneration: nextGeneration,
						runtimeRevision: state.runtimeRevision + 1,
						blockedReason: null,
						lastError: null,
						semanticRepairsCount: 0,
						updatedAt: new Date().toISOString(),
					};

					if (taskPlan && hasMultiTaskPlan && !state.integrationWorktreePath) {
						const failedTaskIds = new Set(
							taskPlan.tasks
								.filter(
									(task) =>
										task.status === 'failed' ||
										task.status === 'blocked' ||
										state.lastError?.metadata?.taskId === task.taskId,
								)
								.map((task) => task.taskId),
						);
						const retryTaskIds =
							failedTaskIds.size > 0
								? collectTaskDescendants(taskPlan.tasks, failedTaskIds)
								: new Set(
										taskPlan.tasks
											.filter((task) => task.status !== 'completed')
											.map((task) => task.taskId),
									);
						for (const t of taskPlan.tasks) {
							if (t.status !== 'completed' && retryTaskIds.has(t.taskId)) {
								context.store.updateTaskStatus(runId, t.taskId, {
									status: 'pending',
									repairCount: 0,
									failurePacketArtifact: null,
								});
								const taskWorktreeDir = t.worktreeSubdir
									? path.resolve(rootDir, 'tools/.agent-sdlc', runId, t.worktreeSubdir)
									: null;
								if (taskWorktreeDir && fs.existsSync(taskWorktreeDir)) {
									try {
										context.gitCli('git', ['checkout', '.'], {
											cwd: taskWorktreeDir,
											stdio: 'ignore',
										});
										context.gitCli('git', ['clean', '-fd'], {
											cwd: taskWorktreeDir,
											stdio: 'ignore',
										});
									} catch {
										// ignore clean failure
									}
								}
							}
						}
					}

					const eventPayload = {
						previousGeneration: currentGeneration,
						resumedGeneration: nextGeneration,
						postMortemCaptured: Boolean(candidateLearning),
					};
					const event = createEvent({
						eventType: 'RESUME_FROM_ESCALATION',
						runId,
						runtimeRevision: nextState.runtimeRevision,
						state: nextState,
						input: state,
						output: eventPayload,
						causalId: `${runId}:operator:resume:${nextGeneration}`,
						payload: eventPayload,
					});

					context.store.saveResumeFromEscalation({
						expectedRevision: state.runtimeRevision,
						nextState,
						event,
						candidateLearning,
					});
					await onBoundary?.('resume-transition-recorded', {
						runId,
						runtimeRevision: nextState.runtimeRevision,
						generation: nextGeneration,
					});

					state = await context.runtime.startExternalTransition(nextState);
				}
			} else if (state.state === 'BLOCKED' && isInfrastructureContinuation(state)) {
				const blockedReason = state.blockedReason;
				const record = blockedReason
					? context.store.getContinuationAttempt(runId, blockedReason)
					: { attempts: 0, policyFingerprint: null, updatedAt: null };
				const policyChanged = localPolicyChanged(record, rootDir, localPolicyPath);
				const priorAttempts = policyChanged ? 0 : record.attempts;
				const policyFingerprint = localPolicyFingerprint(rootDir, localPolicyPath);
				if (priorAttempts >= 1) {
					if (blockedReason) {
						context.store.recordContinuationAttempt(runId, blockedReason, {
							policyFingerprint,
						});
					}
					await context.projection.reconcile();
					const published = await context.projection.publishChangedContinuationCard();
					const result = context.projection.readStatusResult();
					return {
						...result,
						state: state.state,
						continuation: published.continuation,
						hostInvocation: published.hostInvocation,
					};
				}
				state = await context.runtime.continue(state);
				if (state.state === 'BLOCKED' && state.blockedReason === blockedReason && blockedReason) {
					context.store.recordContinuationAttempt(runId, blockedReason, {
						policyFingerprint,
						reset: policyChanged,
					});
					await context.projection.reconcile();
					const published = await context.projection.publishChangedContinuationCard();
					const result = context.projection.readStatusResult();
					return {
						...result,
						state: state.state,
						continuation: published.continuation,
						hostInvocation: published.hostInvocation,
					};
				}
				if (policyChanged && blockedReason) {
					context.store.deleteContinuationAttempt(runId, blockedReason);
				}
			} else if (
				state.state === 'BUDGET_EXHAUSTED' ||
				state.state === 'FAILED' ||
				state.state === 'ESCALATED' ||
				isRunDeadlineHalt(state)
			) {
				return { ...context.projection.readStatusResult(), state: state.state };
			} else {
				state = await context.runtime.continue(state);
			}
		}
		await context.projection.reconcile();
		return { ...context.projection.readStatusResult(), state: state.state };
	} finally {
		context.store.close();
	}
}
