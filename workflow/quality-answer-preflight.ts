import { sha256, type RuntimeState } from '../policy/contracts.ts';
import type { QualityAnswer } from '../policy/contracts/quality-schema.ts';
import { SdlcError } from '../policy/errors.ts';
import { validateQualityAnswerClaims } from '../policy/quality-answer-validation.ts';
import { getAndValidateAuthorization, type WorkflowRuntimeLike } from './node-helpers.ts';

export function preflightQualityAnswer(
	runtime: WorkflowRuntimeLike, snapshot: Readonly<RuntimeState>, answer: QualityAnswer,
): void {
	const quality = runtime.runtimeStore.quality;
	const pending = runtime.runtimeStore.getInterrupt(answer.interruptId);
	const binding = quality.getInterruptBinding(snapshot.runId, answer.interruptId);
	const plan = runtime.runtimeStore.getTaskPlan(snapshot.runId);
	if (!pending || pending.kind !== 'quality_review' || !binding ||
		answer.bindingHash !== snapshot.qualityCheckpointBindingHash ||
		binding.bindingHash !== answer.bindingHash || plan?.schemaVersion !== '2.0.0') {
		throw new SdlcError('INVALID_INPUT', 'Quality answer has stale candidate or plan provenance');
	}
	const request = runtime.artifactStore.readJson(pending.requestArtifact);
	validateQualityAnswerClaims(answer, request, runtime.artifactStore);
	if (!Array.isArray(request.allowedActions) || !request.allowedActions.includes(answer.action)) {
		throw new SdlcError('POLICY_VIOLATION', 'Quality action is not permitted for this blocker');
	}
	for (const expected of binding.expectedRevisions) {
		const current = quality.getCurrentTaskRevision(snapshot.runId, expected.taskId);
		if (!current || current.executionRevision !== expected.executionRevision) {
			throw new SdlcError('INVALID_INPUT', 'Quality answer has stale task revisions');
		}
	}
	for (const hash of answer.evidenceHashes) {
		if (runtime.artifactStore.read) runtime.artifactStore.read(hash);
		else runtime.artifactStore.readJson(hash);
	}
	if (answer.action === 'refute' && !quality.listClosures(snapshot.runId)
		.some(closure => sha256(closure.binding) === answer.bindingHash)) {
		throw new SdlcError('INVALID_CONTRACT', 'Missing refuted checkpoint');
	}
	if (!answer.correction) return;
	if (answer.correction.expectedBudgetLedgerHash !== quality.budgetHash(snapshot.runId)) {
		throw new SdlcError('INVALID_INPUT', 'Quality answer has stale budget');
	}
	const auth = getAndValidateAuthorization(runtime, snapshot);
	const contains = (prefix: string, file: string) => file === prefix || file.startsWith(`${prefix.replace(/\/$/, '')}/`);
	for (const owner of answer.correction.owners) {
		const task = plan.tasks.find(entry => entry.taskId === owner.taskId);
		if (!task || !binding.affectedTaskIds.includes(owner.taskId) ||
			!binding.expectedRevisions.some(r => r.taskId === owner.taskId && r.executionRevision === owner.expectedRevision) ||
			owner.editPaths.some(file => !(task.authoredPaths ?? task.pathPrefixes).some(prefix => contains(prefix, file)) ||
				!auth.allowedPathPrefixes.some(prefix => contains(prefix, file)))) {
			throw new SdlcError('PATH_CONTAINMENT_VIOLATION', 'Correction edit paths widen task/run authorization');
		}
	}
	if (answer.correction.rerunObligationIds.some(id => !plan.evidenceObligations.some(entry => entry.obligationId === id))) {
		throw new SdlcError('INVALID_CONTRACT', 'Correction names foreign rerun obligations');
	}
}
