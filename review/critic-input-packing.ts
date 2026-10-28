// Document packing for critic prompts: plan, spec, and QA excerpts. Leaf module.

import { canonicalJson } from '../policy/contracts.ts';
import { truncateBody } from '@evelbulgroz/model-usage-govenor/sanitize-failure-text';

export interface PlanTaskPackingInput {
	taskId?: unknown;
	title?: unknown;
	targetPackage?: unknown;
	pathPrefixes?: unknown;
	dependsOn?: unknown;
	worktreeSubdir?: unknown;
	integrationOrder?: unknown;
	changeClass?: string | null;
	complexityInputs?: unknown;
	complexityScore?: unknown;
	shadowPaths?: unknown;
	highRisk?: unknown;
	humanReviewEvidence?: unknown;
	verificationCommand?: unknown;
}

export interface PlanDocumentPackingInput {
	planPolicyHash?: unknown;
	baseCommitSha?: unknown;
	isParallel?: unknown;
	integrationOrder?: unknown;
	tasks?: readonly PlanTaskPackingInput[];
}

export interface SpecDocumentPackingInput {
	goal?: unknown;
	nonGoals?: unknown;
	owningContext?: unknown;
	touchedSurfaces?: unknown;
	invariantsAndConstraints?: unknown;
	publicContractImpact?: unknown;
	acceptanceCriteria?: unknown;
	failureDefenses?: unknown;
	verificationPlan?: unknown;
	assumptions?: unknown;
}

export function packPlanDocument(plan: PlanDocumentPackingInput): string {
	return canonicalJson({
		planPolicyHash: plan.planPolicyHash,
		baseCommitSha: plan.baseCommitSha,
		changeClass: derivePlanChangeClass(plan.tasks ?? []),
		doneBar:
			'pnpm run agent:preflight; success requires status=OK and canonical=true',
		isParallel: plan.isParallel,
		integrationOrder: plan.integrationOrder,
		tasks: (plan.tasks ?? []).map((task) => ({
			taskId: task.taskId,
			title: task.title,
			targetPackage: task.targetPackage,
			pathPrefixes: task.pathPrefixes,
			dependsOn: task.dependsOn,
			worktreeSubdir: task.worktreeSubdir,
			integrationOrder: task.integrationOrder,
			changeClass: task.changeClass,
			complexityInputs: task.complexityInputs,
			complexityScore: task.complexityScore,
			shadowPaths: task.shadowPaths,
			highRisk: task.highRisk,
			humanReviewEvidence: task.humanReviewEvidence,
			verificationCommand: task.verificationCommand,
		})),
	});
}

export function derivePlanChangeClass(
	tasks: readonly { changeClass?: string | null }[],
): string | null {
	const classes = new Set(
		tasks.map((task) => task.changeClass).filter((c): c is string => Boolean(c)),
	);
	if (classes.size === 0) return null;
	if (classes.size === 1) return [...classes][0] ?? null;
	return 'E';
}

export const SPEC_PACKING_TARGET_BYTES = 20480;

export function packSpecDocument(
	draft: SpecDocumentPackingInput,
	targetBytes = SPEC_PACKING_TARGET_BYTES,
): string {
	const base = {
		goal: draft.goal,
		nonGoals: draft.nonGoals,
		owningContext: draft.owningContext,
		touchedSurfaces: draft.touchedSurfaces,
		invariantsAndConstraints: draft.invariantsAndConstraints,
		publicContractImpact: draft.publicContractImpact,
		acceptanceCriteria: draft.acceptanceCriteria,
		failureDefenses: draft.failureDefenses,
	};
	const full = {
		...base,
		verificationPlan: draft.verificationPlan,
		assumptions: draft.assumptions,
	};
	let serialized = canonicalJson(full);
	if (Buffer.byteLength(serialized, 'utf8') <= targetBytes) {
		return serialized;
	}
	const withoutAssumptions = {
		...base,
		verificationPlan: draft.verificationPlan,
	};
	serialized = canonicalJson(withoutAssumptions);
	if (Buffer.byteLength(serialized, 'utf8') <= targetBytes) {
		return serialized;
	}
	return canonicalJson(base);
}

export function packQaExcerpts(preflightResult: unknown): string {
	if (preflightResult == null) return '';
	const record =
		typeof preflightResult === 'object' ? (preflightResult as Record<string, unknown>) : null;
	const raw =
		typeof preflightResult === 'string'
			? preflightResult
			: [
					record?.stdout,
					record?.stderr,
					record?.output,
					record?.status ? `status=${String(record.status)}` : '',
					record?.canonical != null
						? `canonical=${String(record.canonical)}`
						: '',
				]
					.filter((part) => part != null && String(part).length > 0)
					.join('\n');
	return truncateBody(raw, 8000);
}
