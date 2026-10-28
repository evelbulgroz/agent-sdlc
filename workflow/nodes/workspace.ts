// Workspace nodes: prepare the worktree and hydrate it. Hydration stays in hydration.ts.

import { type RuntimeState, createEvent } from '../../policy/contracts.ts';
import { SdlcError } from '../../policy/errors.ts';
import { createLocalBranch } from '../git-manager.ts';
import { hydrateWorktree } from '../hydration.ts';
import {
	type GraphStateValues,
	type WorkflowRuntimeLike,
	getAndValidateAuthorization,
	shouldDeferGitMaterialization,
} from '../node-helpers.ts';
import { assertPlanFrozenThenCreateWorktree } from '../worktree-guard.ts';

export function createPrepareWorkspaceNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced };
		const auth = getAndValidateAuthorization(runtime, snapshot);
		if (!auth.allowedOperations?.createDetachedWorktree) {
			throw new SdlcError(
				'OPERATION_NOT_PERMITTED',
				'createDetachedWorktree operation is not permitted',
			);
		}
		const existingCommit = runtime.runtimeStore.getGitCommit(snapshot.runId);
		const deferGitMaterialization = shouldDeferGitMaterialization(auth);
		const worktreeResult = assertPlanFrozenThenCreateWorktree({
			snapshot,
			runId: snapshot.runId,
			baseCommitSha: auth.baseCommitSha,
			expectedCommitSha: existingCommit?.commitSha,
			targetBranch:
				auth.allowedOperations?.createBranch && !deferGitMaterialization
					? auth.targetBranch
					: undefined,
			gitCli: runtime.gitCli,
		});

		let branchResult: { branchName: string; created: boolean; reused: boolean } | null = null;
		if (auth.allowedOperations?.createBranch && !deferGitMaterialization) {
			branchResult = createLocalBranch({
				worktreeDir: worktreeResult.worktreeDir,
				baseCommitSha: auth.baseCommitSha,
				branchName: auth.targetBranch ?? '',
				gitCli: runtime.gitCli,
			});
			if (branchResult.created) {
				const alreadyRecorded = runtime.runtimeStore
					.listEvents(snapshot.runId)
					.some((event) => event.eventType === 'GIT_BRANCH_CREATED');
				if (!alreadyRecorded) {
					const branchEvent = createEvent({
						eventType: 'GIT_BRANCH_CREATED',
						runId: snapshot.runId,
						runtimeRevision: snapshot.runtimeRevision,
						causalId: `git-branch-created-${snapshot.runtimeRevision}`,
						payload: {
							branchName: auth.targetBranch,
							baseCommitSha: auth.baseCommitSha,
						},
						now: runtime.now(),
					});
					runtime.runtimeStore.appendEvent(branchEvent);
				}
				await runtime.onBoundary('branch-created-transition-recorded', {
					runId: snapshot.runId,
					branchName: auth.targetBranch,
				});
			}
		}

		const next = runtime.transition(snapshot, {
			to: 'HYDRATING_WORKSPACE',
			eventType: 'WORKTREE_PREPARED',
			causalId: `prepare-worktree-${snapshot.runtimeRevision}`,
			updates: {
				worktreePath: worktreeResult.worktreeDir,
			},
			payload: {
				worktreeDir: worktreeResult.worktreeDir,
				baseCommitSha: auth.baseCommitSha,
				branchName: branchResult?.branchName ?? null,
			},
		});
		await runtime.onBoundary('worktree-prepared-transition-recorded', {
			runId: next.runId,
			runtimeRevision: next.runtimeRevision,
		});
		return { snapshot: next };
	};
}

export function createHydrateWorkspaceNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced };
		const auth = getAndValidateAuthorization(runtime, snapshot);
		if (!snapshot.worktreePath) {
			throw new SdlcError(
				'POLICY_VIOLATION',
				'hydrate_workspace requires a prepared worktreePath',
			);
		}
		if (!auth.allowedOperations?.runAllowlistedCommands) {
			throw new SdlcError(
				'OPERATION_NOT_PERMITTED',
				'runAllowlistedCommands operation is not permitted',
			);
		}
		try {
			const hydrationResult = await hydrateWorktree({
				worktreeDir: snapshot.worktreePath,
				allowedPackages: auth.allowedPackages,
				runner: runtime.execCli,
			});
			const next = runtime.transition(snapshot, {
				to: 'EXECUTING_IMPLEMENTATION',
				eventType: 'WORKTREE_HYDRATED',
				causalId: `hydrate-worktree-${snapshot.runtimeRevision}`,
				updates: {
					activeGeneration: 0,
				},
				payload: {
					hydrationFingerprint: hydrationResult.fingerprint,
					cached: hydrationResult.status === 'CACHED',
				},
			});
			await runtime.onBoundary('worktree-hydrated-transition-recorded', {
				runId: next.runId,
				runtimeRevision: next.runtimeRevision,
			});
			return { snapshot: next };
		} catch (error: unknown) {
			const rec =
				error && typeof error === 'object'
					? (error as { code?: unknown; message?: unknown })
					: null;
			const code =
				typeof rec?.code === 'string' && rec.code.length > 0
					? rec.code
					: 'HYDRATION_FAILED';
			const message = error instanceof Error ? error.message : String(rec?.message ?? error);
			return {
				snapshot: runtime.transition(snapshot, {
					to: 'BLOCKED',
					eventType: 'RUN_BLOCKED',
					causalId: `hydrate-failed-${snapshot.runtimeRevision}`,
					updates: {
						blockedReason: 'HYDRATION_FAILED',
						lastError: {
							code,
							message,
						},
					},
					payload: { reason: 'HYDRATION_FAILED', error: message },
				}),
			};
		}
	};
}
