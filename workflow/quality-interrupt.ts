import { sha256 } from '../policy/contracts.ts';
import type { RuntimeState } from '../policy/contracts/runtime-vocabulary.ts';
import { SdlcError } from '../policy/errors.ts';
import { affectedCorrectionTasks } from '../execution/correction-rematerialization.ts';
import type { CheckpointQualityContext, WorkflowRuntimeLike } from './node-helpers.ts';
import { blockFailedCorrection } from './quality-correction-failure.ts';

function findingPath(finding: unknown): string {
	if (!finding || typeof finding !== 'object') return '';
	const record = finding as Record<string, unknown>;
	return typeof record.path === 'string'
		? record.path
		: typeof record.file === 'string'
			? record.file
			: '';
}

function correctionOwners(context: CheckpointQualityContext, findings: readonly unknown[]): string[] {
	const ownerId = context.closure.binding.ownerId;
	const candidates = context.plan.tasks.filter((task) =>
		context.closure.binding.checkpointKind === 'final' || task.sliceId === ownerId,
	);
	const paths = findings.map(findingPath).filter(Boolean);
	if (paths.length === 0) return candidates.map((task) => task.taskId);
	const matching = candidates.filter((task) => {
		const prefixes = [...(task.authoredPaths ?? []), ...task.pathPrefixes];
		return paths.some((finding) => prefixes.some((prefix) =>
			finding === prefix || finding.startsWith(`${prefix.replace(/\/+$/, '')}/`),
		));
	});
	return (matching.length > 0 ? matching : candidates).map((task) => task.taskId);
}

export async function blockQualityCheckpoint({
	runtime,
	snapshot,
	context,
	status,
	reason,
	findings = [],
}: {
	runtime: WorkflowRuntimeLike;
	snapshot: Readonly<RuntimeState>;
	context: CheckpointQualityContext;
	status: string;
	reason: string;
	findings?: readonly unknown[];
}): Promise<Readonly<RuntimeState>> {
	if (context.correctionId) {
		runtime.runtimeStore.quality.setCorrectionStatus(
			snapshot.runId,
			context.correctionId,
			'failed',
		);
		const failed = blockFailedCorrection({
			runtime, snapshot, correctionId: context.correctionId, message: reason, code: status,
		});
		await runtime.onBoundary('quality-correction-review-failed', {
			runId: failed.runId,
			correctionId: context.correctionId,
			runtimeRevision: failed.runtimeRevision,
		});
		return failed;
	}
	const bindingHash = snapshot.qualityCheckpointBindingHash;
	if (!bindingHash) throw new SdlcError('POLICY_VIOLATION', 'Quality interrupt has no candidate binding');
	const findingRecords = findings.map((finding, index) => ({
		findingId: sha256({ bindingHash, finding, index }).slice(0, 32),
		finding,
	}));
	const failureId = findingRecords.length ? null : `failure-${sha256({ bindingHash, status, reason }).slice(0, 32)}`;
	const findingIds = failureId ? [failureId] : findingRecords.map((record) => record.findingId);
	const allowedActions = status === 'FAIL' && !failureId
		? ['refute', 'confirm', 'approve-correction']
		: ['approve-correction'];
	const quality = runtime.runtimeStore.quality;
	const ownerTaskIds = correctionOwners(context, findings);
	const rematerializationCandidates = affectedCorrectionTasks(
		context.plan,
		ownerTaskIds,
	);
	const selectedCurrentRevisions = rematerializationCandidates.flatMap((taskId) => {
		const current = quality.getCurrentTaskRevision(snapshot.runId, taskId);
		return current ? [{ taskId, executionRevision: current.executionRevision }] : [];
	});
	const affectedTaskIds = selectedCurrentRevisions.map(({ taskId }) => taskId);
	const expectedRevisions = selectedCurrentRevisions;
	const interruptId = sha256({
		runId: snapshot.runId,
		bindingHash,
		runtimeRevision: snapshot.runtimeRevision,
		status,
		reason,
	}).slice(0, 32);
	const stateHash = sha256({
		runId: snapshot.runId,
		bindingHash,
		qualityCheckpointId: snapshot.qualityCheckpointId,
		status,
		findingIds,
	});
	const requestArtifact = runtime.artifactStore.writeJson('quality-review-interrupt', {
		schemaVersion: '1.0.0',
		kind: 'quality_review',
		interruptId,
		stateHash,
		expectedResponse: { interruptId, bindingHash },
		bindingHash,
		checkpointId: snapshot.qualityCheckpointId,
		checkpointKind: snapshot.qualityCheckpointKind,
		treeSha: snapshot.qualityCheckpointTreeSha,
		status,
		reason,
		findings: findingRecords,
		failureId,
		allowedActions,
	});
	const next = runtime.transition(snapshot, {
		to: 'BLOCKED',
		eventType: 'RUN_BLOCKED',
		causalId: `quality-review-blocked-${snapshot.runtimeRevision}`,
		updates: {
			pendingInterruptId: interruptId,
			blockedReason: 'QUALITY_REVIEW_BLOCKED',
			lastError: { code: status, message: reason, metadata: { requestArtifact } },
		},
		payload: {
			reason: 'QUALITY_REVIEW_BLOCKED',
			status,
			interruptId,
			requestArtifact,
			bindingHash,
			findingIds,
		},
		effects: {
			createInterrupt: {
				interruptId,
				runId: snapshot.runId,
				kind: 'quality_review',
				stateHash,
				requestArtifact,
				createdAt: runtime.now().toISOString(),
			},
		},
	});
	quality.bindInterrupt({
		runId: snapshot.runId,
		interruptId,
		bindingHash,
		findingIds,
		expectedRevisions,
		affectedTaskIds,
	});
	await runtime.onBoundary('quality-review-interrupt-recorded', {
		runId: next.runId,
		interruptId,
		runtimeRevision: next.runtimeRevision,
	});
	return next;
}
