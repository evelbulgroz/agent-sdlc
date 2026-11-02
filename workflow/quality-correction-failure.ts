import path from 'node:path';
import fs from 'node:fs';
import { captureTaskDelta } from '../execution/task-tree-delta.ts';
import { liveRunRoot } from '../persistence/run-paths.ts';
import { sha256, type RuntimeState } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import type { WorkflowRuntimeLike } from './node-helpers.ts';

function failureInterruptId(runId: string, correctionId: string): string {
	return sha256({ runId, correctionId, kind: 'failed-correction-adjudication' }).slice(0, 32);
}

export function pendingCorrectionAdjudication(runtime: WorkflowRuntimeLike, runId: string,
	correctionId: string): Readonly<RuntimeState> | null {
	const pending = runtime.runtimeStore.getInterrupt(failureInterruptId(runId, correctionId));
	if (!pending || pending.kind !== 'quality_review') return null;
	const request = runtime.artifactStore.readJson(pending.requestArtifact);
	return request.failedCorrectionId === correctionId ? runtime.runtimeStore.getRun(runId) : null;
}

export function blockFailedCorrection({
	runtime, snapshot, correctionId, message, code,
}: {
	runtime: WorkflowRuntimeLike; snapshot: Readonly<RuntimeState>;
	correctionId: string; message: string; code: string;
}): Readonly<RuntimeState> {
	const existing = pendingCorrectionAdjudication(runtime, snapshot.runId, correctionId);
	if (existing) return existing;
	const quality = runtime.runtimeStore.quality;
	const plan = runtime.runtimeStore.getTaskPlan(snapshot.runId);
	const observe = (taskId: string, parentTreeSha: string, worktreeDir: string) => {
		if (!fs.existsSync(worktreeDir)) return null;
		try {
			const files = String(runtime.gitCli('git', ['ls-files', '-co', '--exclude-standard'], {
				cwd: worktreeDir, encoding: 'utf8',
			})).trim().split('\n').filter(Boolean);
			const delta = captureTaskDelta({ task: { taskId, parentTreeSha, pathPrefixes: files },
				worktreeDir, rootDir: runtime.rootDir, gitCli: runtime.gitCli, rawPatchHash: true });
			return { treeSha: delta.targetTreeSha, patchHash: delta.patchHash };
		} catch (error) {
			return { unavailable: error instanceof Error ? error.message : String(error) };
		}
	};
	const stagedRevisions = quality.listTaskRevisions(snapshot.runId)
		.filter(revision => revision.correctionId === correctionId).map(revision => {
			const worktreeDir = path.join(liveRunRoot(runtime.rootDir), snapshot.runId,
				'worktrees', `${revision.taskId}-r${revision.executionRevision}`);
			// Capture provenance only; never checkout, verify, or replay an interrupted edit.
			return { revision, observation: observe(revision.taskId, revision.parentTreeSha, worktreeDir) };
		});
	const failedClosures = quality.listClosures(snapshot.runId).filter(closure =>
		quality.getStagedClosure(snapshot.runId, correctionId,
			closure.binding.checkpointId, closure.binding.candidateRevision) !== null);
	const integrationObservation = plan ? observe('integration-failure', plan.baseCommitSha,
		path.join(liveRunRoot(runtime.rootDir), snapshot.runId, 'worktrees/integration')) : null;
	const failedCandidate = { correctionId,
		originalBindingHash: quality.getCorrection(snapshot.runId, correctionId)?.binding.bindingHash ?? null,
		failedCheckpointBindingHash: snapshot.qualityCheckpointBindingHash,
		stagedRevisions, integrationObservation, failedClosures: failedClosures.map(closure => closure.binding) };
	const bindingHash = sha256(failedCandidate);
	const failureId = `failure-${sha256({ bindingHash, code, message }).slice(0, 32)}`;
	const interruptId = failureInterruptId(snapshot.runId, correctionId);
	const stateHash = sha256({ runId: snapshot.runId, bindingHash, failureId });
	const checkpointId = `failed-correction-${correctionId}`;
	const treeSha = integrationObservation?.treeSha ?? failedClosures.at(-1)?.binding.treeSha ??
		stagedRevisions.at(-1)?.observation?.treeSha ?? snapshot.qualityCheckpointTreeSha;
	const requestArtifact = runtime.artifactStore.writeJson('quality-review-interrupt', {
		schemaVersion: '1.0.0', kind: 'quality_review', interruptId, stateHash,
		expectedResponse: { interruptId, bindingHash }, bindingHash, checkpointId,
		checkpointKind: snapshot.qualityCheckpointKind, treeSha,
		status: 'CORRECTION_FAILED', reason: message, failureId, findings: [],
		failedCorrectionId: correctionId, failedCandidate, allowedActions: ['confirm'],
		resolution: 'Confirm acknowledges the halted correction; it does not accept edits or authorize a new correction.',
	});
	return runtime.runtimeStore.transaction(() => {
		const current = runtime.runtimeStore.getRun(snapshot.runId);
		const next = runtime.transition({ ...snapshot,
			runtimeRevision: Math.max(snapshot.runtimeRevision, current.runtimeRevision) }, {
			to: 'BLOCKED', eventType: 'RUN_BLOCKED', causalId: `quality-correction-adjudication-${interruptId}`,
			updates: { pendingInterruptId: interruptId, blockedReason: 'QUALITY_REVIEW_BLOCKED',
				qualityCheckpointId: checkpointId, qualityCheckpointTreeSha: treeSha,
				qualityCheckpointBindingHash: bindingHash,
				lastError: { code, message: `${message}; operator adjudication required`,
					metadata: { correctionId, requestArtifact, sourceEditsReplayed: false,
						recovery: 'operator-adjudication-required' } } },
			payload: { correctionId, interruptId, bindingHash, failureId, reason: 'QUALITY_REVIEW_BLOCKED' },
			effects: { createInterrupt: { interruptId, runId: snapshot.runId, kind: 'quality_review',
				stateHash, requestArtifact, createdAt: runtime.now().toISOString() } },
		});
		quality.bindInterrupt({ runId: snapshot.runId, interruptId, bindingHash,
			findingIds: [failureId], expectedRevisions: [], affectedTaskIds: [] });
		return next;
	});
}

export function correctionNeedsAdjudication(error: unknown, interruptedEdit: boolean): boolean {
	return interruptedEdit || (error instanceof SdlcError && [
		'PATH_CONTAINMENT_VIOLATION', 'POLICY_VIOLATION', 'TASK_EXECUTION_FAILED', 'BUDGET_EXHAUSTED',
		'INVALID_CONTRACT', 'STORE_RECONCILIATION_FAILED', 'RECONCILIATION_CONFLICT', 'WORKTREE_FAILED',
	].includes(error.code)) || (typeof error === 'object' && error !== null && 'status' in error) ||
	/unrecognized|provenance changed|identity changed/.test(error instanceof Error ? error.message : String(error));
}
