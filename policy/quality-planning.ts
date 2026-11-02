import { validateTaskPlan, type TaskPlan } from './contracts.ts';
import {
	qualityPolicyHash,
	validateAuthorizedQualityPlan,
	validateQualityPlan,
	type AuthorizedQualityPlan,
} from './contracts/quality-schema.ts';
import { SdlcError } from './errors.ts';
import { parseAcceptanceCriterion } from '../workflow/acceptance-criteria.ts';

export function attachApprovedQualityPlan(
	legacyPlan: TaskPlan,
	qualityInput: unknown,
	criteria: readonly string[],
): TaskPlan {
	const quality = validateAuthorizedQualityPlan(qualityInput);
	if (!legacyPlan.slices?.length) throw new SdlcError('TASK_PLAN_INVALID', 'Quality plan requires explicit slices');
	const criterionCases: Record<string, readonly string[]> = {};
	const expected = new Set<string>();
	for (const [index, text] of criteria.entries()) {
		const parsed = parseAcceptanceCriterion(text, index);
		if (!parsed.ok) throw new SdlcError('TASK_PLAN_INVALID', 'Quality evidence requires valid acceptance criteria');
		if (Object.hasOwn(criterionCases, parsed.id)) {
			throw new SdlcError('TASK_PLAN_INVALID', `Duplicate acceptance criterion '${parsed.id}'`);
		}
		criterionCases[parsed.id] = parsed.cases.map((entry) => entry.id);
		if (parsed.cases.length) {
			for (const entry of parsed.cases) expected.add(`${parsed.id}\0${entry.id}`);
		} else {
			expected.add(`${parsed.id}\0`);
		}
	}
	const seen = new Set<string>();
	for (const obligation of quality.evidenceObligations) {
		const identity = `${obligation.criterionId}\0${obligation.caseId ?? ''}`;
		if (!expected.has(identity) || seen.has(identity)) {
			throw new SdlcError('TASK_PLAN_INVALID', `Foreign or duplicate quality obligation '${obligation.caseId ?? obligation.criterionId}'`);
		}
		seen.add(identity);
		const task = obligation.owner.kind === 'task'
			? legacyPlan.tasks.find((entry) => entry.taskId === obligation.owner.id)
			: undefined;
		const sliceId = obligation.owner.kind === 'task' ? task?.sliceId : obligation.owner.id;
		const slice = legacyPlan.slices.find((entry) => entry.sliceId === sliceId);
		if (!slice || slice.kind === 'enabling' || !slice.acceptanceCriteria.includes(obligation.criterionId)) {
			throw new SdlcError('TASK_PLAN_INVALID', `Invalid obligation ownership '${obligation.obligationId}'`);
		}
		if (obligation.owner.kind === 'task' &&
			(!task || (task.acceptanceCriteria && !task.acceptanceCriteria.includes(obligation.criterionId)))) {
			throw new SdlcError('TASK_PLAN_INVALID', `Invalid task owner for '${obligation.obligationId}'`);
		}
	}
	if (seen.size !== expected.size) throw new SdlcError('TASK_PLAN_INVALID', 'Quality plan omits acceptance obligations');
	validateQualityPlan({
		...quality,
		qualityPolicyHash: qualityPolicyHash(quality.qualityPolicy),
		slices: legacyPlan.slices,
		tasks: legacyPlan.tasks,
	}, { criterionCases });
	const runtimeFields = [
		'status', 'worktreeSubdir', 'baseCommitSha', 'parentTreeSha', 'parentCommitSha',
		'targetTreeSha', 'patchHash', 'failurePacketArtifact', 'repairCount', 'failureMetadata',
		'humanReviewEvidence', 'exceededLimits',
	] as const;
	const immutableTasks = legacyPlan.tasks.map((task) => {
		const definition = { ...task } as Record<string, unknown>;
		for (const key of runtimeFields) delete definition[key];
		return definition;
	});
	return validateTaskPlan({
		...legacyPlan,
		schemaVersion: '2.0.0',
		tasks: immutableTasks,
		qualityPolicy: quality.qualityPolicy,
		qualityPolicyHash: qualityPolicyHash(quality.qualityPolicy),
		adapterBindings: quality.adapterBindings,
		evidenceObligations: quality.evidenceObligations,
	});
}

export type { AuthorizedQualityPlan };
