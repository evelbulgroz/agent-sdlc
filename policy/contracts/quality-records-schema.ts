import { z } from 'zod';
import { Hash, Id, NonNegativeInt, PosInt, QualityPolicySchema, QUALITY_RECORD_SCHEMA_VERSION, RelPath, Tree, UniqueStrings } from './quality-primitives.ts';
import { RUN_ID_PATTERN, sha256 } from './primitives.ts';
import { AdapterRegistrationSchema, CandidateBindingSchema, EvidenceObligationSchema } from './quality-evidence-schema.ts';
import type { AdapterRegistration } from './quality-evidence-schema.ts';

export const BudgetReservationSchema = z.strictObject({
	operationId: Id,
	kind: z.enum(['execution', 'review', 'follow-up']),
	checkpointId: Id,
	candidateRevision: NonNegativeInt,
	status: z.enum(['reserved', 'consumed', 'interrupted']),
});
export const BudgetLedgerSchema = z.strictObject({
	schemaVersion: z.literal(QUALITY_RECORD_SCHEMA_VERSION),
	runId: z.string().regex(RUN_ID_PATTERN),
	qualityPolicyHash: Hash,
	revision: NonNegativeInt,
	counters: z.strictObject({
		executionInvocations: NonNegativeInt, executionDurationMs: NonNegativeInt,
		logicalDispatches: NonNegativeInt, physicalCalls: NonNegativeInt,
		inputTokens: NonNegativeInt, outputTokens: NonNegativeInt,
	}),
	reservations: z.array(BudgetReservationSchema),
}).superRefine((ledger, ctx) => {
	const ids = ledger.reservations.map((reservation) => reservation.operationId);
	if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['reservations'], message: 'operation ids must be unique' });
});
export type BudgetLedger = z.infer<typeof BudgetLedgerSchema>;

export const TaskRevisionSchema = z.strictObject({
	schemaVersion: z.literal(QUALITY_RECORD_SCHEMA_VERSION),
	runId: z.string().regex(RUN_ID_PATTERN),
	taskPlanHash: Hash,
	taskId: Id,
	executionRevision: NonNegativeInt,
	correctionId: Id.nullable(),
	parentTreeSha: Tree,
	targetTreeSha: Tree.nullable(),
	patchHash: Hash.nullable(),
	parentRevisionSetHash: Hash,
	status: z.enum(['materializing', 'executing', 'verifying', 'completed', 'invalidated', 'failed']),
	receiptHashes: UniqueStrings(Hash),
}).superRefine((revision, ctx) => {
	if (revision.status === 'completed' && (!revision.targetTreeSha || !revision.patchHash || revision.receiptHashes.length === 0)) {
		ctx.addIssue({ code: 'custom', message: 'completed task revision requires target, patch, and verification receipts' });
	}
});
export type TaskRevision = z.infer<typeof TaskRevisionSchema>;

const SelectedRevisionSchema = z.strictObject({ taskId: Id, executionRevision: NonNegativeInt, patchHash: Hash });
export const ClosureRecordSchema = z.strictObject({
	schemaVersion: z.literal(QUALITY_RECORD_SCHEMA_VERSION),
	binding: CandidateBindingSchema,
	selectedRevisions: z.array(SelectedRevisionSchema),
	registryId: Id,
	status: z.enum(['building', 'verifying', 'reviewing', 'verified', 'accepted', 'invalidated', 'failed']),
	receiptHashes: UniqueStrings(Hash),
	reviewOperationIds: UniqueStrings(Id),
}).superRefine((closure, ctx) => {
	const tasks = closure.selectedRevisions.map((revision) => revision.taskId);
	if (new Set(tasks).size !== tasks.length) ctx.addIssue({ code: 'custom', path: ['selectedRevisions'], message: 'task ids must be unique' });
	if (closure.status === 'accepted' && !['slice', 'final'].includes(closure.binding.checkpointKind)) ctx.addIssue({ code: 'custom', path: ['status'], message: 'only slice/final closures can be accepted' });
	if (closure.status === 'verified' && !['enabling', 'task'].includes(closure.binding.checkpointKind)) ctx.addIssue({ code: 'custom', path: ['status'], message: 'verified is reserved for enabling/task closures' });
});
export type ClosureRecord = z.infer<typeof ClosureRecordSchema>;

const CorrectionOwnerSchema = z.strictObject({ taskId: Id, expectedRevision: NonNegativeInt, editPaths: z.array(RelPath).min(1) });
const QualityCorrectionSchema = z.strictObject({
	owners: z.array(CorrectionOwnerSchema).min(1),
	rerunObligationIds: UniqueStrings(Id),
	maxSourceEditIterations: z.number().int().min(1).max(2),
	expectedBudgetLedgerHash: Hash,
}).superRefine((correction, ctx) => {
	if (new Set(correction.owners.map((owner) => owner.taskId)).size !== correction.owners.length) {
		ctx.addIssue({ code: 'custom', path: ['owners'], message: 'owner task ids must be unique' });
	}
});
export const QualityAnswerSchema = z.strictObject({
	schemaVersion: z.literal(QUALITY_RECORD_SCHEMA_VERSION),
	answerId: Id,
	interruptId: Id,
	bindingHash: Hash,
	findingIds: UniqueStrings(Id),
	action: z.enum(['refute', 'confirm', 'approve-correction']),
	rationale: z.string().trim().min(1),
	evidenceHashes: UniqueStrings(Hash),
	correction: QualityCorrectionSchema.nullable(),
}).superRefine((answer, ctx) => {
	if ((answer.action === 'approve-correction') !== (answer.correction !== null)) {
		ctx.addIssue({ code: 'custom', path: ['correction'], message: 'only approve-correction has a correction payload' });
	}
	if (answer.action !== 'approve-correction' && answer.findingIds.length === 0) {
		ctx.addIssue({ code: 'custom', path: ['findingIds'], message: 'adjudication requires at least one finding' });
	}
	if (answer.action === 'refute' && answer.evidenceHashes.length === 0) {
		ctx.addIssue({ code: 'custom', path: ['evidenceHashes'], message: 'refutation requires evidence' });
	}
});
export type QualityAnswer = z.infer<typeof QualityAnswerSchema>;

export const RetrievalRequestSchema = z.strictObject({
	schemaVersion: z.literal(QUALITY_RECORD_SCHEMA_VERSION),
	operationId: Id,
	reviewOperationId: Id,
	bindingHash: Hash,
	obligationId: Id,
	file: RelPath,
	selector: z.discriminatedUnion('kind', [
		z.strictObject({ kind: z.literal('lines'), start: PosInt, end: PosInt }),
		z.strictObject({ kind: z.literal('helper'), symbol: z.string().trim().min(1) }),
	]),
}).superRefine((request, ctx) => {
	if (request.selector.kind === 'lines' && request.selector.end < request.selector.start) {
		ctx.addIssue({ code: 'custom', path: ['selector', 'end'], message: 'end must be >= start' });
	}
});
export type RetrievalRequest = z.infer<typeof RetrievalRequestSchema>;

export const RetrievalResponseSchema = z.strictObject({
	schemaVersion: z.literal(QUALITY_RECORD_SCHEMA_VERSION),
	requestHash: Hash,
	fileHash: Hash,
	ranges: z.array(z.strictObject({ start: PosInt, end: PosInt, text: z.string() })),
	omittedRanges: z.array(z.strictObject({ start: PosInt, end: PosInt })),
	unresolvedHelpers: z.array(z.string().min(1)),
	outcome: z.enum(['complete', 'partial', 'unavailable']),
}).superRefine((response, ctx) => {
	for (const [index, range] of [...response.ranges, ...response.omittedRanges].entries()) {
		if (range.end < range.start) ctx.addIssue({ code: 'custom', path: ['ranges', index], message: 'range end must be >= start' });
	}
	if (response.outcome === 'complete' && response.unresolvedHelpers.length > 0) {
		ctx.addIssue({ code: 'custom', path: ['unresolvedHelpers'], message: 'complete response cannot have unresolved helpers' });
	}
});
export type RetrievalResponse = z.infer<typeof RetrievalResponseSchema>;

export const QualityPlanFieldsSchema = z.strictObject({
	qualityPolicy: QualityPolicySchema,
	qualityPolicyHash: Hash,
	adapterBindings: z.array(AdapterRegistrationSchema).min(1),
	evidenceObligations: z.array(EvidenceObligationSchema).min(1),
});
export type QualityPlanFields = z.infer<typeof QualityPlanFieldsSchema>;

export const AuthorizedQualityPlanSchema = z.strictObject({
	qualityPolicy: QualityPolicySchema,
	adapterBindings: z.array(AdapterRegistrationSchema).min(1),
	evidenceObligations: z.array(EvidenceObligationSchema).min(1),
});
export type AuthorizedQualityPlan = z.infer<typeof AuthorizedQualityPlanSchema>;
