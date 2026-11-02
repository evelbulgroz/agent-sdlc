// Document packing for critic prompts: plan, spec, and QA excerpts. Leaf module.

import { canonicalJson } from '../policy/contracts.ts';
import { projectTaskPlan } from '../policy/contracts/dag-schema.ts';
import { SdlcError } from '../policy/errors.ts';
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
	schemaVersion?: unknown;
	planPolicyHash?: unknown;
	baseCommitSha?: unknown;
	isParallel?: unknown;
	integrationOrder?: unknown;
	tasks?: readonly PlanTaskPackingInput[];
	[key: string]: unknown;
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

export const PLAN_DOCUMENT_MAX_BYTES = 20480;

export function packPlanDocument(plan: PlanDocumentPackingInput): string {
	const immutableTaskPlan =
		plan.schemaVersion === '2.0.0' ? projectTaskPlan(plan) : undefined;
	const document = {
		planPolicyHash: plan.planPolicyHash,
		baseCommitSha: plan.baseCommitSha,
		changeClass: derivePlanChangeClass(plan.tasks ?? []),
		doneBar:
			'host verify command (sdlc-host.json verify.argv) is run by the engine after tasks complete and must return a receipt with status=OK and canonical=true; task verificationCommand values are separate per-task checks and need not equal verify.argv',
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
		...(immutableTaskPlan ? { immutableTaskPlan } : {}),
	};
	const packed = canonicalJson(document);
	if (
		immutableTaskPlan &&
		Buffer.byteLength(packed, 'utf8') > PLAN_DOCUMENT_MAX_BYTES
	) {
		throw new SdlcError(
			'INVALID_CONTRACT',
			`Plan critic document exceeds ${PLAN_DOCUMENT_MAX_BYTES} bytes; the complete immutable v2 plan cannot be reviewed`,
		);
	}
	return packed;
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
