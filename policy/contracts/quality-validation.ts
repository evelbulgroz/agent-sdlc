import { z } from 'zod';
import { Capability, QualityPolicySchema } from './quality-primitives.ts';
import { sha256 } from './primitives.ts';
import { AdapterRegistrationSchema, EvidenceReportSchema, EvidenceRequestSchema } from './quality-evidence-schema.ts';
import type { AdapterRegistration, EvidenceAdapterProfile, EvidenceObligation, EvidenceReport, EvidenceRequest, InvocationRecord } from './quality-evidence-schema.ts';
import type { QualityPolicy } from './quality-primitives.ts';
import {
	AuthorizedQualityPlanSchema,
	QualityPlanFieldsSchema,
	type AuthorizedQualityPlan,
	type QualityPlanFields,
} from './quality-records-schema.ts';

export type QualityPlanValidationContext = {
	readonly criterionCases?: Readonly<Record<string, readonly string[]>>;
};

export function qualityPolicyHash(policy: QualityPolicy | unknown): string {
	return sha256(QualityPolicySchema.parse(policy));
}

export function adapterBindingHash(registration: AdapterRegistration | unknown): string {
	return sha256(AdapterRegistrationSchema.parse(registration));
}

export function hashWithoutField(value: unknown, field: string): string {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('hash input must be an object');
	const { [field]: omitted, ...projection } = value as Record<string, unknown>;
	void omitted;
	return sha256(projection);
}

export function validateQualityPlan(input: unknown, context: QualityPlanValidationContext = {}): Readonly<QualityPlanFields> {
	const quality = QualityPlanFieldsSchema.parse({
		qualityPolicy: (input as Record<string, unknown>)?.qualityPolicy,
		qualityPolicyHash: (input as Record<string, unknown>)?.qualityPolicyHash,
		adapterBindings: (input as Record<string, unknown>)?.adapterBindings,
		evidenceObligations: (input as Record<string, unknown>)?.evidenceObligations,
	});
	if (quality.qualityPolicyHash !== qualityPolicyHash(quality.qualityPolicy)) throw new Error('qualityPolicyHash does not match qualityPolicy');
	const bindings = new Map<string, { registration: AdapterRegistration; profiles: Map<string, EvidenceAdapterProfile> }>();
	for (const registration of quality.adapterBindings) {
		const hash = adapterBindingHash(registration);
		if (bindings.has(hash)) throw new Error(`duplicate adapter binding '${hash}'`);
		bindings.set(hash, { registration, profiles: new Map(registration.profiles.map((profile) => [profile.profileId, profile])) });
	}

	const obligations = new Set<string>();
	const assignments = new Set<string>();
	for (const obligation of quality.evidenceObligations) {
		if (obligations.has(obligation.obligationId)) throw new Error(`duplicate obligation '${obligation.obligationId}'`);
		obligations.add(obligation.obligationId);
		if (obligation.caseId !== null) {
			if (!obligation.caseId.startsWith(`${obligation.criterionId}.`)) throw new Error(`case '${obligation.caseId}' does not belong to '${obligation.criterionId}'`);
			const assignment = `${obligation.criterionId}\0${obligation.caseId}`;
			if (assignments.has(assignment)) throw new Error(`duplicate obligation assignment '${obligation.caseId}'`);
			assignments.add(assignment);
		} else {
			const assignment = `${obligation.criterionId}\0`;
			if (assignments.has(assignment)) throw new Error(`duplicate criterion-level obligation '${obligation.criterionId}'`);
			assignments.add(assignment);
		}
		const adapter = bindings.get(obligation.adapterBindingHash);
		if (!adapter) throw new Error(`unknown adapter binding for obligation '${obligation.obligationId}'`);
		const profile = adapter.profiles.get(obligation.profileId);
		if (!profile) throw new Error(`unknown adapter profile for obligation '${obligation.obligationId}'`);
		if (!profile.layers.includes(obligation.layer)) throw new Error(`adapter profile does not support ${obligation.layer}`);
		if (obligation.requiredCapabilities.some((capability) => !profile.capabilities.includes(capability))) {
			throw new Error(`adapter profile lacks a required capability for '${obligation.obligationId}'`);
		}
	}
	for (const [criterionId, caseIds] of Object.entries(context.criterionCases ?? {})) {
		if (caseIds.length === 0 && !assignments.has(`${criterionId}\0`)) {
			throw new Error(`missing criterion-level evidence obligation for '${criterionId}'`);
		}
		if (caseIds.length > 0 && assignments.has(`${criterionId}\0`)) {
			throw new Error(`criterion '${criterionId}' cannot mix criterion-level and case-level obligations`);
		}
		for (const caseId of caseIds) {
			if (!assignments.has(`${criterionId}\0${caseId}`)) throw new Error(`missing evidence obligation for '${caseId}'`);
		}
	}
	const plan = input as Record<string, unknown>;
	const slices = Array.isArray(plan.slices) ? plan.slices as Array<{ kind?: string }> : [];
	const s = slices.filter((slice) => slice.kind === 'vertical' || slice.kind === 'activation').length;
	const { additionalCandidateReviews: r, followUpDispatches: f, review } = quality.qualityPolicy;
	const capacity = (s + 1) * (r + 1) * (f + 1);
	if (review.maxLogicalDispatches < capacity) throw new Error(`quality review capacity ${review.maxLogicalDispatches} is below required ${capacity}`);
	if (Array.isArray(plan.tasks) && Array.isArray(plan.slices)) validatePlanOwnership(plan, quality.evidenceObligations);
	return Object.freeze(structuredClone(quality));
}

export function validateAuthorizedQualityPlan(input: unknown): Readonly<AuthorizedQualityPlan> {
	const approved = AuthorizedQualityPlanSchema.parse(input);
	const qualityPolicyHashValue = qualityPolicyHash(approved.qualityPolicy);
	validateQualityPlan({ ...approved, qualityPolicyHash: qualityPolicyHashValue });
	return Object.freeze(structuredClone(approved));
}

function validatePlanOwnership(plan: Record<string, unknown>, obligations: readonly EvidenceObligation[]): void {
	const slices = plan.slices as Array<{ sliceId: string; kind: string; acceptanceCriteria: string[] }>;
	const tasks = plan.tasks as Array<{ taskId: string; sliceId: string; authoredPaths?: string[]; pathPrefixes?: string[]; acceptanceCriteria?: string[] }>;
	const sliceById = new Map(slices.map((slice) => [slice.sliceId, slice]));
	const taskById = new Map(tasks.map((task) => [task.taskId, task]));
	const criterionOwners = new Map<string, string>();
	for (const slice of slices) {
		if (slice.kind === 'enabling') continue;
		for (const criterionId of slice.acceptanceCriteria) {
			if (criterionOwners.has(criterionId)) throw new Error(`criterion '${criterionId}' has multiple slice owners`);
			criterionOwners.set(criterionId, slice.sliceId);
		}
	}
	const obligatedCriteria = new Set(obligations.map((obligation) => obligation.criterionId));
	for (const criterionId of criterionOwners.keys()) {
		if (!obligatedCriteria.has(criterionId)) throw new Error(`missing evidence obligation for criterion '${criterionId}'`);
	}
	for (const obligation of obligations) {
		const ownerSlice = obligation.owner.kind === 'slice'
			? sliceById.get(obligation.owner.id)
			: sliceById.get(taskById.get(obligation.owner.id)?.sliceId ?? '');
		if (!ownerSlice) throw new Error(`unknown obligation owner '${obligation.owner.id}'`);
		if (ownerSlice.kind === 'enabling') throw new Error(`enabling slice cannot own evidence obligation '${obligation.obligationId}'`);
		if (!ownerSlice.acceptanceCriteria.includes(obligation.criterionId)) throw new Error(`obligation criterion is not owned by slice '${ownerSlice.sliceId}'`);
		if (criterionOwners.get(obligation.criterionId) !== ownerSlice.sliceId) throw new Error(`obligation owner does not own criterion '${obligation.criterionId}'`);
		let ownerTasks = tasks.filter((task) => task.sliceId === obligation.owner.id);
		if (obligation.owner.kind === 'task') {
			const task = taskById.get(obligation.owner.id);
			if (!task || (task.acceptanceCriteria && !task.acceptanceCriteria.includes(obligation.criterionId))) {
				throw new Error(`task does not own obligation criterion '${obligation.criterionId}'`);
			}
			ownerTasks = [task];
		}
		const allowed = ownerTasks.flatMap((task) => [...(task.authoredPaths ?? []), ...(task.pathPrefixes ?? [])]);
		for (const path of [...obligation.implementationPaths, ...obligation.testCases.map((testCase) => testCase.file)]) {
			if (!allowed.some((prefix) => path === prefix || path.startsWith(`${prefix.replace(/\/+$/, '')}/`))) {
				throw new Error(`obligation path '${path}' is outside its owner scope`);
			}
		}
	}
}

export function validateEvidenceReportForRequest(reportInput: unknown, requestInput: unknown, invocation: Pick<InvocationRecord, 'exitCode' | 'operationId' | 'requestHash' | 'adapterBindingHash'>): Readonly<EvidenceReport> {
	const report = EvidenceReportSchema.parse(reportInput);
	const request = EvidenceRequestSchema.parse(requestInput);
	const requestHash = sha256(request);
	if (report.operationId !== request.operationId || invocation.operationId !== request.operationId) throw new Error('operationId mismatch');
	if (report.requestHash !== requestHash || invocation.requestHash !== requestHash) throw new Error('requestHash mismatch');
	if (report.adapterBindingHash !== request.adapterBindingHash || invocation.adapterBindingHash !== request.adapterBindingHash) throw new Error('adapter binding mismatch');
	if (report.profileId !== request.profileId) throw new Error('profileId mismatch');
	if (invocation.exitCode !== 0) throw new Error('evidence command did not exit successfully');
	const expected = new Map<string, { caseKey: string; file: string; obligations: string[]; capabilities: Set<string> }>();
	for (const obligation of request.obligations) {
		for (const testCase of obligation.testCases) {
			const key = `${testCase.file}\0${testCase.caseKey}`;
			const item = expected.get(key) ?? { caseKey: testCase.caseKey, file: testCase.file, obligations: [], capabilities: new Set<string>() };
			item.obligations.push(obligation.obligationId);
			for (const capability of obligation.requiredCapabilities) item.capabilities.add(capability);
			expected.set(key, item);
		}
	}
	if (expected.size !== report.cases.length) throw new Error('report case set does not match request');
	for (const result of report.cases) {
		const key = `${result.file}\0${result.caseKey}`;
		const match = expected.get(key);
		if (!match) throw new Error(`foreign case '${result.file}:${result.caseKey}'`);
		if ([...match.obligations].sort().join('\0') !== [...result.obligationIds].sort().join('\0')) throw new Error(`obligation mapping mismatch for '${result.caseKey}'`);
		if (result.outcome === 'passed' && [...match.capabilities].some((capability) => !result.exercisedCapabilities.includes(capability as z.infer<typeof Capability>))) {
			throw new Error(`required capability missing for '${result.caseKey}'`);
		}
	}
	const artifactPaths = new Set(report.artifacts.map((artifact) => artifact.path));
	for (const result of report.cases) {
		for (const attempt of result.attempts) {
			for (const artifactPath of attempt.artifactPaths) {
				if (!artifactPaths.has(artifactPath)) throw new Error(`attempt artifact '${artifactPath}' is absent from report manifest`);
			}
		}
	}
	return Object.freeze(structuredClone(report));
}
