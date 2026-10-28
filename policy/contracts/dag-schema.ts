import { z } from 'zod';
import { SdlcError } from '../errors.ts';
import { TASK_MANIFEST_DELIVERY_LAYERS, TASK_MANIFEST_SLICE_KINDS } from './planning-schema.ts';
import { validateRunId } from './primitives.ts';

export const TaskStatusSchema = z.enum([
	'pending',
	'ready',
	'in_progress',
	'completed',
	'failed',
	'cancelled',
	'blocked',
]);

export const DagTaskSchema = z.object({
	taskId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
	title: z.string().min(1).max(256),
	targetPackage: z.string().min(1),
	pathPrefixes: z.array(z.string().min(1)).min(1),
	dependsOn: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).default([]),
	status: TaskStatusSchema.default('pending'),
	integrationOrder: z.number().int().min(0),
	worktreeSubdir: z.string().min(1),
	baseCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
	parentTreeSha: z.string().regex(/^[a-f0-9]{40}$/).nullable().default(null),
	parentCommitSha: z.string().regex(/^[a-f0-9]{40}$/).nullable().default(null),
	targetTreeSha: z.string().regex(/^[a-f0-9]{40}$/).nullable().default(null),
	patchHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
	failurePacketArtifact: z.string().nullable().default(null),
	repairCount: z.number().int().min(0).default(0),
	failureMetadata: z.record(z.string(), z.unknown()).nullable().optional(),
	sliceId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
	authoredPaths: z.array(z.string().min(1)).optional(),
	generatedOutputs: z.array(z.string().min(1)).optional(),
	deliveryLayers: z.array(z.enum(TASK_MANIFEST_DELIVERY_LAYERS)).optional(),
	dependencyMutations: z.array(z.object({
		manifestPath: z.string().min(1),
		dependencyName: z.string().min(1),
		fromRange: z.string().min(1),
		toRange: z.string().min(1),
	}).strict()).optional(),
	shadowPaths: z.object({
		unhappy: z.string().min(1),
		timeout: z.string().min(1),
		empty: z.string().min(1),
		boundary: z.string().min(1),
	}).strict().optional(),
	verificationCommand: z.array(z.string().min(1)).min(1).optional(),
	generatorCommand: z.array(z.string().min(1)).min(1).nullable().optional(),
	acceptanceCriteria: z.array(z.string().regex(/^AC-\d{2,}$/)).optional(),
	complexityInputs: z.object({
		acceptanceCriteria: z.number().int().min(0),
		authoredPaths: z.number().int().min(0),
		deliveryLayers: z.number().int().min(0),
		dependencyMutations: z.number().int().min(0),
		contractProducer: z.boolean(),
		highRisk: z.boolean(),
	}).strict().optional(),
	complexityScore: z.number().int().min(0).optional(),
	contractProducer: z.boolean().optional(),
	highRisk: z.boolean().optional(),
	changeClass: z.enum(['A', 'B', 'C', 'D', 'E']).optional(),
	maxAutonomousRepairs: z.number().int().min(0).max(2).optional(),
	humanReviewEvidence: z.enum(['not_required', 'required_pending', 'satisfied']).optional(),
	exceededLimits: z.array(z.object({
		dimension: z.string().min(1),
		actual: z.number().int().min(0),
		maximum: z.number().int().min(0),
	}).strict()).optional(),
});

export const TaskPlanSchema = z.object({
	schemaVersion: z.literal('1.0.0'),
	runId: z.string(),
	planPolicyHash: z.string().regex(/^[a-f0-9]{64}$/),
	taskManifestHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
	baseCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
	slices: z.array(z.object({
		sliceId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
		kind: z.enum(TASK_MANIFEST_SLICE_KINDS),
		goal: z.string().min(1),
		acceptanceCriteria: z.array(z.string().regex(/^AC-\d{2,}$/)),
		dependsOn: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)),
	}).strict()).optional(),
	tasks: z.array(DagTaskSchema).min(1),
	integrationOrder: z.array(z.string()).min(1),
	isParallel: z.boolean(),
	createdAt: z.string(),
});

export const ReconciliationRecordSchema = z.object({
	reconciliationId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
	runId: z.string(),
	integrationOrder: z.array(z.string()).min(1),
	reconciledTreeSha: z.string().regex(/^[a-f0-9]{40}$/),
	status: z.enum(['RECONCILIATION_COMPLETED', 'RECONCILIATION_CONFLICT', 'FAILED']),
	conflictDetails: z.record(z.string(), z.unknown()).nullable().default(null),
	reconciledAt: z.string(),
});

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type DagTask = z.infer<typeof DagTaskSchema>;
export type TaskPlan = z.infer<typeof TaskPlanSchema>;
export type ReconciliationRecord = z.infer<typeof ReconciliationRecordSchema>;

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
		return error.message;
	}
	return String(error);
}

export function validateDagTask(input: unknown): Readonly<DagTask> {
	try {
		const parsed = DagTaskSchema.parse(input);
		return Object.freeze(structuredClone(parsed));
	} catch (error: unknown) {
		throw new SdlcError('INVALID_INPUT', `Invalid DagTask: ${errorMessage(error)}`, {
			cause: error,
		});
	}
}

export function validateTaskPlan(input: unknown): Readonly<TaskPlan> {
	try {
		const parsed = TaskPlanSchema.parse(input);
		validateRunId(parsed.runId);
		return Object.freeze(structuredClone(parsed));
	} catch (error: unknown) {
		if (error instanceof SdlcError) throw error;
		throw new SdlcError('INVALID_INPUT', `Invalid TaskPlan: ${errorMessage(error)}`, {
			cause: error,
		});
	}
}

export function validateReconciliationRecord(input: unknown): Readonly<ReconciliationRecord> {
	try {
		const parsed = ReconciliationRecordSchema.parse(input);
		validateRunId(parsed.runId);
		return Object.freeze(structuredClone(parsed));
	} catch (error: unknown) {
		if (error instanceof SdlcError) throw error;
		throw new SdlcError('INVALID_INPUT', `Invalid ReconciliationRecord: ${errorMessage(error)}`, {
			cause: error,
		});
	}
}
