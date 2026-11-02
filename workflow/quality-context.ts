import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256 } from '../policy/contracts.ts';
import type { ClosureRecord, QualityPolicy } from '../policy/contracts/quality-schema.ts';
import { getCheckpointQualityPolicy } from '../policy/contracts/quality-policy.ts';
import type { RuntimeState, TaskPlan } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import type { WorkflowRuntimeLike } from './node-helpers.ts';

export interface CheckpointQualityContext {
	readonly plan: Extract<TaskPlan, { schemaVersion: '2.0.0' }>;
	readonly policy: QualityPolicy;
	readonly closure: Readonly<ClosureRecord>;
	readonly worktreeDir: string;
	readonly correctionId?: string;
}

function checkpointQualityPolicy(plan: TaskPlan): QualityPolicy | null {
	const hasQualityFields = 'qualityPolicy' in plan ||
		'qualityPolicyHash' in plan ||
		'adapterBindings' in plan ||
		'evidenceObligations' in plan;
	if (plan.schemaVersion === '1.0.0' && hasQualityFields) {
		throw new SdlcError('TASK_PLAN_INVALID', 'Legacy task plans cannot contain quality policy fields');
	}
	return getCheckpointQualityPolicy(plan);
}

export function getRunCheckpointQualityPolicy(
	runtime: WorkflowRuntimeLike,
	snapshot: Readonly<RuntimeState>,
): QualityPolicy | null {
	const plan = runtime.runtimeStore.getTaskPlan(snapshot.runId);
	if (!plan) {
		if (snapshot.qualityPolicy !== undefined) {
			throw new SdlcError('TASK_PLAN_INVALID', 'Quality policy snapshot has no frozen task plan');
		}
		return null;
	}
	const policy = checkpointQualityPolicy(plan);
	if (
		policy &&
		snapshot.qualityPolicy &&
		canonicalJson(snapshot.qualityPolicy) !== canonicalJson(policy)
	) {
		throw new SdlcError('TASK_PLAN_INVALID', 'Runtime quality policy differs from the frozen task plan');
	}
	if (!policy && snapshot.qualityPolicy !== undefined) {
		throw new SdlcError('TASK_PLAN_INVALID', 'Legacy task plan cannot carry checkpoint quality state');
	}
	return policy;
}

export function resolveCheckpointQualityContext(
	runtime: WorkflowRuntimeLike,
	snapshot: Readonly<RuntimeState>,
	{ allowAccepted = false }: { allowAccepted?: boolean } = {},
): CheckpointQualityContext | null {
	const plan = runtime.runtimeStore.getTaskPlan(snapshot.runId);
	if (!plan) {
		if (snapshot.qualityPolicy !== undefined) {
			throw new SdlcError('TASK_PLAN_INVALID', 'Quality policy snapshot has no frozen task plan');
		}
		return null;
	}
	const policy = getRunCheckpointQualityPolicy(runtime, snapshot);
	if (!policy) {
		if (snapshot.qualityCheckpointId !== undefined) {
			throw new SdlcError('TASK_PLAN_INVALID', 'Legacy task plan cannot carry checkpoint quality state');
		}
		return null;
	}
	if (plan.schemaVersion !== '2.0.0') {
		throw new SdlcError('TASK_PLAN_INVALID', 'Checkpoint quality requires task-plan schema 2.0.0');
	}
	const checkpointId = snapshot.qualityCheckpointId;
	const checkpointKind = snapshot.qualityCheckpointKind;
	const treeSha = snapshot.qualityCheckpointTreeSha;
	const bindingHash = snapshot.qualityCheckpointBindingHash;
	if (!checkpointId || !checkpointKind || !treeSha || !bindingHash || !snapshot.qualityPolicy) {
		throw new SdlcError('POLICY_VIOLATION', 'New-policy QA requires an explicit bound checkpoint');
	}
	const quality = runtime.runtimeStore.quality;
	if (!quality) {
		throw new SdlcError('STORE_RECONCILIATION_FAILED', 'Quality record store is unavailable');
	}
	const matches = quality.listClosures(snapshot.runId).filter((closure) =>
		closure.binding.checkpointId === checkpointId &&
		closure.binding.treeSha === treeSha &&
		sha256(closure.binding) === bindingHash,
	);
	if (matches.length !== 1) {
		throw new SdlcError('POLICY_VIOLATION', 'Quality checkpoint binding is missing or ambiguous');
	}
	const closure = matches[0];
	if (!closure) throw new SdlcError('POLICY_VIOLATION', 'Quality checkpoint binding is missing');
	const binding = closure.binding;
	const stagedCorrectionIds = new Set(closure.selectedRevisions.flatMap((revision) => {
		const taskRevision = quality.getTaskRevision(snapshot.runId, revision.taskId, revision.executionRevision);
		return taskRevision?.correctionId ? [taskRevision.correctionId] : [];
	}));
	let stagedCorrectionId: string | null = null;
	if (stagedCorrectionIds.size > 0) {
		if (stagedCorrectionIds.size !== 1) {
			throw new SdlcError('POLICY_VIOLATION', 'Checkpoint mixes revisions from multiple corrections');
		}
		const correctionId = [...stagedCorrectionIds][0];
		if (!correctionId) {
			throw new SdlcError('POLICY_VIOLATION', 'Staged correction identity is missing');
		}
		stagedCorrectionId = correctionId;
		const correction = quality.getCorrection(snapshot.runId, stagedCorrectionId);
		if (
			!correction ||
			!['rebuilding', 'verifying'].includes(correction.status) ||
			correction.binding.affectedTaskIds.some((taskId) => {
				const staged = closure.selectedRevisions.find((revision) => revision.taskId === taskId);
				if (!staged) return false;
				return quality.getTaskRevision(snapshot.runId, taskId, staged.executionRevision)?.correctionId !== stagedCorrectionId;
			})
		) {
			throw new SdlcError('POLICY_VIOLATION', 'Checkpoint is not a staged closure for its active correction');
		}
	} else if (quality.hasIncompleteCorrection(snapshot.runId)) {
		throw new SdlcError('POLICY_VIOLATION', 'An incomplete quality correction blocks review');
	}
	const registration = quality.getWorktree(snapshot.runId, closure.registryId);
	if (
		!registration ||
		registration.bindingHash !== bindingHash ||
		registration.kind !== checkpointKind ||
		registration.ownerId !== binding.ownerId
	) {
		throw new SdlcError('POLICY_VIOLATION', 'Quality checkpoint worktree is not registered to its binding');
	}
	const runDir = path.dirname(runtime.artifactStore.artifactsDir);
	const worktreeDir = path.resolve(runDir, registration.relativePath);
	const relativeWorktree = path.relative(runDir, worktreeDir);
	if (relativeWorktree.startsWith('..') || path.isAbsolute(relativeWorktree)) {
		throw new SdlcError('POLICY_VIOLATION', 'Quality checkpoint worktree escapes its run directory');
	}
	try {
		if (!fs.statSync(worktreeDir).isDirectory()) throw new Error('not a directory');
		const realRunDir = fs.realpathSync(runDir);
		const realWorktreeDir = fs.realpathSync(worktreeDir);
		const realRelative = path.relative(realRunDir, realWorktreeDir);
		if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('outside run directory');
	} catch (error: unknown) {
		throw new SdlcError('POLICY_VIOLATION', 'Quality checkpoint worktree is unavailable or unsafe', { cause: error });
	}
	if (
		binding.checkpointKind !== checkpointKind ||
		binding.taskPlanHash !== snapshot.taskPlanHash ||
		binding.approvedSpecHash !== snapshot.approvedSpecHash ||
		binding.qualityPolicyHash !== sha256(policy) ||
		(checkpointKind === 'slice' && binding.ownerId !== snapshot.qualityCheckpointSliceId) ||
		(checkpointKind === 'final' && binding.ownerId !== null) ||
		(closure.status !== 'reviewing' && !(allowAccepted && closure.status === 'accepted')) ||
		closure.receiptHashes.length === 0
	) {
		throw new SdlcError('POLICY_VIOLATION', 'Quality checkpoint is stale or lacks verified evidence');
	}
	if (stagedCorrectionId && !closure.selectedRevisions.every((selected) => {
		const revision = quality.getTaskRevision(snapshot.runId, selected.taskId, selected.executionRevision);
		return revision && (revision.correctionId === stagedCorrectionId || !revision.correctionId);
	})) {
		throw new SdlcError('POLICY_VIOLATION', 'Staged checkpoint revisions do not match the active correction');
	}
	if (checkpointKind === 'final') {
		if (!snapshot.preflightBindingArtifact) {
			throw new SdlcError('POLICY_VIOLATION', 'Final quality review requires canonical preflight');
		}
		const preflight = runtime.artifactStore.readJson(snapshot.preflightBindingArtifact);
		if (
			preflight.status !== 'OK' ||
			preflight.canonical !== true ||
			preflight.targetTreeSha !== treeSha
		) {
			throw new SdlcError('POLICY_VIOLATION', 'Final preflight does not bind the quality candidate');
		}
	}
	return Object.freeze({
		plan,
		policy,
		closure,
		worktreeDir,
		...(stagedCorrectionId ? { correctionId: stagedCorrectionId } : {}),
	});
}
