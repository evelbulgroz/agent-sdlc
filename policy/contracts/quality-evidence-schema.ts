import { z } from 'zod';
import { Capability, FileHash, Hash, Id, Layer, NonNegativeInt, Outcome, PosInt, RelPath, Time, Tree, UniqueStrings, QUALITY_RECORD_SCHEMA_VERSION } from './quality-primitives.ts';
import { RUN_ID_PATTERN } from './primitives.ts';

export const EvidenceAdapterProfileSchema = z.strictObject({
	profileId: Id,
	layers: UniqueStrings(Layer),
	capabilities: UniqueStrings(Capability),
}).superRefine((profile, ctx) => {
	const layers = new Set(profile.layers);
	const caps = new Set(profile.capabilities);
	if (caps.has('static-check') && !layers.has('static')) ctx.addIssue({ code: 'custom', path: ['layers'], message: 'static-check requires the static layer' });
	if ([...caps].some((cap) => ['native-browser', 'native-file-picker', 'focus-navigation'].includes(cap)) && !layers.has('browser')) {
		ctx.addIssue({ code: 'custom', path: ['layers'], message: 'native browser capabilities require the browser layer' });
	}
	if ((caps.has('native-file-picker') || caps.has('focus-navigation')) && !caps.has('native-browser')) {
		ctx.addIssue({ code: 'custom', path: ['capabilities'], message: 'native-file-picker and focus-navigation require native-browser' });
	}
});
export type EvidenceAdapterProfile = z.infer<typeof EvidenceAdapterProfileSchema>;

export const EvidenceDependencyManifestSchema = z.strictObject({
	schemaVersion: z.literal(QUALITY_RECORD_SCHEMA_VERSION),
	files: z.array(FileHash).min(1).max(100_000),
}).superRefine((manifest, ctx) => {
	if (new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) {
		ctx.addIssue({ code: 'custom', path: ['files'], message: 'dependency paths must be unique' });
	}
});

export const AdapterRegistrationSchema = z.strictObject({
	adapterId: Id,
	protocolVersion: z.literal(QUALITY_RECORD_SCHEMA_VERSION),
	bundleFiles: z.array(FileHash).min(1),
	dependencyFiles: z.array(FileHash),
	dependencyManifest: FileHash.optional(),
	configurationFiles: z.array(FileHash),
	argv: z.array(z.string().min(1)).min(1),
	executableSha256: Hash.optional(),
	profiles: z.array(EvidenceAdapterProfileSchema).min(1),
	qualificationArtifactHash: Hash,
	limits: z.strictObject({
		timeoutMs: PosInt, maxReportBytes: PosInt, maxArtifactBytes: PosInt, maxArtifacts: PosInt,
	}),
}).superRefine((registration, ctx) => {
	for (const [field, files] of Object.entries({
		bundleFiles: registration.bundleFiles,
		dependencyFiles: registration.dependencyFiles,
		configurationFiles: registration.configurationFiles,
	})) {
		const paths = files.map((item) => item.path);
		if (new Set(paths).size !== paths.length) ctx.addIssue({ code: 'custom', path: [field], message: 'paths must be unique' });
	}
	const profileIds = registration.profiles.map((profile) => profile.profileId);
	if (new Set(profileIds).size !== profileIds.length) ctx.addIssue({ code: 'custom', path: ['profiles'], message: 'profile ids must be unique' });
});
export type AdapterRegistration = z.infer<typeof AdapterRegistrationSchema>;

export const EvidenceObligationSchema = z.strictObject({
	obligationId: Id,
	criterionId: z.string().regex(/^AC-\d{2,}$/),
	caseId: z.string().regex(/^AC-\d{2,}\.\d+$/).nullable(),
	owner: z.strictObject({ kind: z.enum(['task', 'slice']), id: Id }),
	observableOutcome: z.string().trim().min(1),
	setupAction: z.string().trim().min(1),
	expectedResult: z.string().trim().min(1),
	layer: Layer,
	requiredCapabilities: UniqueStrings(Capability),
	implementationPaths: z.array(RelPath).min(1),
	testCases: z.array(z.strictObject({ file: RelPath, caseKey: Id })).min(1),
	adapterBindingHash: Hash,
	profileId: Id,
}).superRefine((obligation, ctx) => {
	if (new Set(obligation.implementationPaths).size !== obligation.implementationPaths.length) {
		ctx.addIssue({ code: 'custom', path: ['implementationPaths'], message: 'paths must be unique' });
	}
	const keys = obligation.testCases.map((item) => `${item.file}\0${item.caseKey}`);
	if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['testCases'], message: 'file/case identities must be unique' });
	if (obligation.layer === 'static' && !obligation.requiredCapabilities.includes('static-check')) {
		ctx.addIssue({ code: 'custom', path: ['requiredCapabilities'], message: 'static obligations require static-check' });
	}
	if (
		(obligation.layer === 'browser' || obligation.requiredCapabilities.some((cap) => cap !== 'static-check')) &&
		['native-file-picker', 'focus-navigation'].some((cap) => obligation.requiredCapabilities.includes(cap as z.infer<typeof Capability>)) &&
		!obligation.requiredCapabilities.includes('native-browser')
	) {
		ctx.addIssue({ code: 'custom', path: ['requiredCapabilities'], message: 'native-file-picker and focus-navigation require native-browser' });
	}
	if (obligation.requiredCapabilities.includes('native-browser') && obligation.layer !== 'browser') {
		ctx.addIssue({ code: 'custom', path: ['layer'], message: 'native-browser requires browser layer' });
	}
});
export type EvidenceObligation = z.infer<typeof EvidenceObligationSchema>;
export const ObligationSchema = EvidenceObligationSchema;
export type Obligation = EvidenceObligation;

export const CandidateBindingSchema = z.strictObject({
	runId: z.string().regex(RUN_ID_PATTERN),
	approvedSpecHash: Hash,
	taskPlanHash: Hash,
	qualityPolicyHash: Hash,
	checkpointId: Id,
	checkpointKind: z.enum(['task', 'enabling', 'slice', 'final']),
	ownerId: Id.nullable(),
	candidateRevision: NonNegativeInt,
	baseCommitSha: Tree,
	treeSha: Tree,
	revisionSetHash: Hash,
	preparationHash: Hash,
}).superRefine((binding, ctx) => {
	if ((binding.checkpointKind === 'final') !== (binding.ownerId === null)) {
		ctx.addIssue({ code: 'custom', path: ['ownerId'], message: 'only final checkpoints have a null owner' });
	}
});
export type CandidateBinding = z.infer<typeof CandidateBindingSchema>;

export const EvidenceRequestSchema = z.strictObject({
	schemaVersion: z.literal(QUALITY_RECORD_SCHEMA_VERSION),
	operationId: Id,
	binding: CandidateBindingSchema,
	adapterBindingHash: Hash,
	profileId: Id,
	obligations: z.array(EvidenceObligationSchema).min(1),
	artifactDirectory: z.string().min(1).refine((value) => value.startsWith('/') && !value.includes('\0'), 'artifactDirectory must be absolute'),
}).superRefine((request, ctx) => {
	const ids = request.obligations.map((obligation) => obligation.obligationId);
	if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['obligations'], message: 'obligations must be unique' });
	request.obligations.forEach((obligation, index) => {
		if (obligation.adapterBindingHash !== request.adapterBindingHash) {
			ctx.addIssue({ code: 'custom', path: ['obligations', index, 'adapterBindingHash'], message: 'obligation adapter binding mismatch' });
		}
		if (obligation.profileId !== request.profileId) {
			ctx.addIssue({ code: 'custom', path: ['obligations', index, 'profileId'], message: 'obligation profile mismatch' });
		}
	});
});
export type EvidenceRequest = z.infer<typeof EvidenceRequestSchema>;

export const EvidenceAttemptSchema = z.strictObject({
	index: NonNegativeInt,
	outcome: Outcome,
	durationMs: NonNegativeInt,
	artifactPaths: z.array(RelPath),
}).superRefine((attempt, ctx) => {
	if (new Set(attempt.artifactPaths).size !== attempt.artifactPaths.length) {
		ctx.addIssue({ code: 'custom', path: ['artifactPaths'], message: 'artifact paths must be unique' });
	}
});
export type EvidenceAttempt = z.infer<typeof EvidenceAttemptSchema>;

export const CaseResultSchema = z.strictObject({
	file: RelPath,
	caseKey: Id,
	obligationIds: UniqueStrings(Id),
	exercisedCapabilities: UniqueStrings(Capability),
	outcome: z.enum(['passed', 'failed', 'skipped', 'not-run', 'incomplete']),
	attempts: z.array(EvidenceAttemptSchema),
}).superRefine((result, ctx) => {
	if (result.obligationIds.length === 0) ctx.addIssue({ code: 'custom', path: ['obligationIds'], message: 'must not be empty' });
	if (result.outcome === 'passed' && (result.attempts.length === 0 || result.attempts.some((attempt) => attempt.outcome !== 'passed'))) {
		ctx.addIssue({ code: 'custom', path: ['attempts'], message: 'passed results require one or more all-passed attempts' });
	}
	if (result.outcome === 'failed' && !result.attempts.some((attempt) => attempt.outcome === 'failed')) {
		ctx.addIssue({ code: 'custom', path: ['attempts'], message: 'failed results require a failed attempt' });
	}
	if (result.outcome === 'not-run' && result.attempts.length > 0) {
		ctx.addIssue({ code: 'custom', path: ['attempts'], message: 'not-run results cannot contain attempts' });
	}
	if (result.outcome === 'skipped' && result.attempts.some((attempt) => attempt.outcome === 'passed')) {
		ctx.addIssue({ code: 'custom', path: ['attempts'], message: 'skipped results cannot contain a passed attempt' });
	}
	result.attempts.forEach((attempt, index) => {
		if (attempt.index !== index) ctx.addIssue({ code: 'custom', path: ['attempts', index, 'index'], message: 'attempt indexes must be contiguous from zero' });
	});
});
export type CaseResult = z.infer<typeof CaseResultSchema>;

export const EvidenceReportSchema = z.strictObject({
	schemaVersion: z.literal(QUALITY_RECORD_SCHEMA_VERSION),
	operationId: Id,
	requestHash: Hash,
	adapterBindingHash: Hash,
	profileId: Id,
	cases: z.array(CaseResultSchema),
	artifacts: z.array(z.strictObject({ path: RelPath, sha256: Hash, sizeBytes: NonNegativeInt })),
}).superRefine((report, ctx) => {
	const caseIds = report.cases.map((item) => `${item.file}\0${item.caseKey}`);
	if (new Set(caseIds).size !== caseIds.length) ctx.addIssue({ code: 'custom', path: ['cases'], message: 'file/case identities must be unique' });
	const artifactPaths = report.artifacts.map((item) => item.path);
	if (new Set(artifactPaths).size !== artifactPaths.length) ctx.addIssue({ code: 'custom', path: ['artifacts'], message: 'artifact paths must be unique' });
});
export type EvidenceReport = z.infer<typeof EvidenceReportSchema>;

export const InvocationRecordSchema = z.strictObject({
	schemaVersion: z.literal(QUALITY_RECORD_SCHEMA_VERSION),
	operationId: Id,
	requestHash: Hash,
	bindingHash: Hash,
	adapterBindingHash: Hash,
	observedArgv: z.array(z.string().min(1)).min(1),
	worktreeRegistryId: Id,
	startedAt: Time,
	finishedAt: Time.nullable(),
	exitCode: z.number().int().nullable(),
	reportHash: Hash.nullable(),
	artifactManifestHash: Hash.nullable(),
	status: z.enum(['reserved', 'running', 'completed', 'failed', 'interrupted']),
	retryOf: Id.nullable(),
	failureReason: z.string().trim().min(1).nullable(),
}).superRefine((record, ctx) => {
	if (record.status === 'completed' && (!record.finishedAt || record.exitCode !== 0 || !record.reportHash || !record.artifactManifestHash)) {
		ctx.addIssue({ code: 'custom', message: 'completed invocation requires finish time, zero exit code, and report/artifact hashes' });
	}
	if (record.finishedAt && Date.parse(record.finishedAt) < Date.parse(record.startedAt)) {
		ctx.addIssue({ code: 'custom', path: ['finishedAt'], message: 'finish time cannot precede start time' });
	}
	if (['reserved', 'running'].includes(record.status) &&
		(record.finishedAt !== null || record.exitCode !== null || record.reportHash !== null || record.artifactManifestHash !== null)) {
		ctx.addIssue({ code: 'custom', message: `${record.status} invocation cannot have completion fields` });
	}
});
export type InvocationRecord = z.infer<typeof InvocationRecordSchema>;

export const EvidenceReceiptSchema = z.strictObject({
	schemaVersion: z.literal(QUALITY_RECORD_SCHEMA_VERSION),
	operationId: Id,
	requestHash: Hash,
	bindingHash: Hash,
	adapterBindingHash: Hash,
	invocationRecordHash: Hash,
	reportHash: Hash,
	artifactManifestHash: Hash,
	dischargedObligationIds: UniqueStrings(Id),
	status: z.enum(['passed', 'failed', 'incomplete']),
}).superRefine((receipt, ctx) => {
	if (receipt.status === 'passed' && receipt.dischargedObligationIds.length === 0) {
		ctx.addIssue({ code: 'custom', path: ['dischargedObligationIds'], message: 'passed receipt must discharge at least one obligation' });
	}
});
export type EvidenceReceipt = z.infer<typeof EvidenceReceiptSchema>;
