import { z } from 'zod';
import { SdlcError } from '../errors.ts';
import { TASK_MANIFEST_DELIVERY_LAYERS, TASK_MANIFEST_SLICE_KINDS } from './planning-schema.ts';
import { sha256, validateRunId } from './primitives.ts';
import {
	QualityPlanFieldsSchema,
	validateQualityPlan,
	type QualityPlanFields,
} from './quality-schema.ts';

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

const TaskPlanV1Schema = z.object({
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

const DagTaskV2Schema = DagTaskSchema.omit({
	status: true,
	worktreeSubdir: true,
	baseCommitSha: true,
	parentTreeSha: true,
	parentCommitSha: true,
	targetTreeSha: true,
	patchHash: true,
	failurePacketArtifact: true,
	repairCount: true,
	failureMetadata: true,
	humanReviewEvidence: true,
	exceededLimits: true,
}).extend({
	sliceId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
}).strict();

export const TaskPlanV2Schema = z.strictObject({
	schemaVersion: z.literal('2.0.0'),
	runId: z.string().regex(/^\d{4}-\d{2}-\d{2}-(?!_example$)[a-z0-9][a-z0-9-]{0,95}$/),
	planPolicyHash: z.string().regex(/^[a-f0-9]{64}$/),
	taskManifestHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
	baseCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
	slices: z.array(z.strictObject({
		sliceId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
		kind: z.enum(TASK_MANIFEST_SLICE_KINDS),
		goal: z.string().min(1),
		acceptanceCriteria: z.array(z.string().regex(/^AC-\d{2,}$/)),
		dependsOn: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)),
	})).min(1),
	tasks: z.array(DagTaskV2Schema).min(1),
	integrationOrder: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).min(1),
	isParallel: z.boolean(),
	createdAt: z.string().datetime(),
	...QualityPlanFieldsSchema.shape,
}).superRefine((plan, ctx) => {
	const taskIds = new Set(plan.tasks.map((task) => task.taskId));
	const sliceIds = new Set(plan.slices.map((slice) => slice.sliceId));
	if (new Set(plan.slices.map((slice) => slice.sliceId)).size !== plan.slices.length) {
		ctx.addIssue({ code: 'custom', path: ['slices'], message: 'slice ids must be unique' });
	}
	if (new Set(plan.tasks.map((task) => task.taskId)).size !== plan.tasks.length) {
		ctx.addIssue({ code: 'custom', path: ['tasks'], message: 'task ids must be unique' });
	}
	if (plan.tasks.some((task) => !sliceIds.has(task.sliceId))) {
		ctx.addIssue({ code: 'custom', path: ['tasks'], message: 'every task must reference a declared slice' });
	}
	validateTaskPlanV2Graph(plan, ctx);
	if (plan.integrationOrder.length !== taskIds.size || new Set(plan.integrationOrder).size !== taskIds.size ||
		plan.integrationOrder.some((taskId) => !taskIds.has(taskId))) {
		ctx.addIssue({ code: 'custom', path: ['integrationOrder'], message: 'must contain every task exactly once' });
	}
	try {
		validateQualityPlan(plan);
	} catch (error: unknown) {
		ctx.addIssue({ code: 'custom', path: ['evidenceObligations'], message: errorMessage(error) });
	}
});

function validateTaskPlanV2Graph(
	plan: z.infer<typeof TaskPlanV2Schema> extends never ? never : {
		tasks: readonly { taskId: string; sliceId: string; dependsOn: readonly string[]; integrationOrder: number }[];
		slices: readonly { sliceId: string; kind: string; dependsOn: readonly string[]; acceptanceCriteria: readonly string[] }[];
		integrationOrder: readonly string[];
	},
	ctx: z.RefinementCtx,
): void {
	const taskById = new Map(plan.tasks.map((task) => [task.taskId, task]));
	const sliceById = new Map(plan.slices.map((slice) => [slice.sliceId, slice]));
	const taskOrder = new Map(plan.integrationOrder.map((taskId, index) => [taskId, index]));
	for (const [index, task] of plan.tasks.entries()) {
		if (new Set(task.dependsOn).size !== task.dependsOn.length) {
			ctx.addIssue({ code: 'custom', path: ['tasks', index, 'dependsOn'], message: 'dependencies must be unique' });
		}
		for (const dependencyId of task.dependsOn) {
			const dependency = taskById.get(dependencyId);
			if (!dependency || dependencyId === task.taskId) {
				ctx.addIssue({ code: 'custom', path: ['tasks', index, 'dependsOn'], message: `invalid task dependency '${dependencyId}'` });
			} else if ((taskOrder.get(dependencyId) ?? Number.MAX_SAFE_INTEGER) >= (taskOrder.get(task.taskId) ?? -1)) {
				ctx.addIssue({ code: 'custom', path: ['integrationOrder'], message: `dependency '${dependencyId}' must precede '${task.taskId}'` });
			}
		}
		if (task.integrationOrder !== taskOrder.get(task.taskId)) {
			ctx.addIssue({ code: 'custom', path: ['tasks', index, 'integrationOrder'], message: 'must match integrationOrder position' });
		}
	}
	for (const [index, slice] of plan.slices.entries()) {
		if (!plan.tasks.some((task) => task.sliceId === slice.sliceId)) {
			ctx.addIssue({ code: 'custom', path: ['slices', index], message: 'slice must contain at least one task' });
		}
		if (new Set(slice.acceptanceCriteria).size !== slice.acceptanceCriteria.length) {
			ctx.addIssue({ code: 'custom', path: ['slices', index, 'acceptanceCriteria'], message: 'criteria must be unique' });
		}
		if (slice.kind === 'enabling' && slice.acceptanceCriteria.length !== 0) {
			ctx.addIssue({ code: 'custom', path: ['slices', index, 'acceptanceCriteria'], message: 'enabling slices cannot own criteria' });
		}
		if (slice.kind !== 'enabling' && slice.acceptanceCriteria.length === 0) {
			ctx.addIssue({ code: 'custom', path: ['slices', index, 'acceptanceCriteria'], message: 'non-enabling slices require criteria' });
		}
		if (new Set(slice.dependsOn).size !== slice.dependsOn.length) {
			ctx.addIssue({ code: 'custom', path: ['slices', index, 'dependsOn'], message: 'dependencies must be unique' });
		}
		for (const dependencyId of slice.dependsOn) {
			if (!sliceById.has(dependencyId) || dependencyId === slice.sliceId) {
				ctx.addIssue({ code: 'custom', path: ['slices', index, 'dependsOn'], message: `invalid slice dependency '${dependencyId}'` });
			}
		}
	}
}

const TaskPlanLegacyDecoderSchema = z.preprocess((input, ctx) => {
	if (
		input && typeof input === 'object' && !Array.isArray(input) &&
		(input as Record<string, unknown>).schemaVersion === '1.0.0' &&
		['qualityPolicy', 'qualityPolicyHash', 'adapterBindings', 'evidenceObligations']
			.some((key) => Object.hasOwn(input, key))
	) {
		ctx.addIssue({ code: 'custom', message: 'quality policy fields require TaskPlan schemaVersion 2.0.0' });
		return z.NEVER;
	}
	return input;
}, TaskPlanV1Schema).transform((plan) => plan as TaskPlanV1 & Partial<QualityPlanFields>);

const TaskPlanV2RuntimeSchema = TaskPlanV2Schema.transform((plan): TaskPlanV2Runtime => ({
	...plan,
	tasks: plan.tasks.map((task) => DagTaskSchema.parse({
		...task,
		status: 'pending',
		worktreeSubdir: `worktrees/${task.taskId}`,
		baseCommitSha: plan.baseCommitSha,
		parentTreeSha: null,
		parentCommitSha: null,
		targetTreeSha: null,
		patchHash: null,
		failurePacketArtifact: null,
		repairCount: 0,
	})),
}));

export const TaskPlanSchema = z.union([TaskPlanLegacyDecoderSchema, TaskPlanV2RuntimeSchema]);

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
export type TaskPlanV1 = z.infer<typeof TaskPlanV1Schema>;
export type TaskPlanV2 = z.infer<typeof TaskPlanV2Schema>;
export type TaskPlanV2Runtime = Omit<TaskPlanV2, 'tasks'> & { tasks: DagTask[] };
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
		if (parsed.schemaVersion === '2.0.0') validateQualityPlan(parsed);
		return Object.freeze(structuredClone(parsed));
	} catch (error: unknown) {
		if (error instanceof SdlcError) throw error;
		throw new SdlcError('INVALID_INPUT', `Invalid TaskPlan: ${errorMessage(error)}`, {
			cause: error,
		});
	}
}

export function hashTaskPlanProjection(input: unknown): string {
	const record = input as Record<string, unknown> | null;
	if (record?.schemaVersion === '2.0.0') return sha256(taskPlanV2WireProjection(input));
	return TaskPlanLegacyDecoderSchema.parse(input).planPolicyHash;
}

export function assertTaskPlanHash(input: unknown, expectedHash: unknown): string {
	const actualHash = hashTaskPlanProjection(input);
	if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash) || expectedHash !== actualHash) {
		throw new SdlcError('INVALID_INPUT', 'TaskPlan hash does not match its immutable projection', {
			expectedHash: typeof expectedHash === 'string' ? expectedHash : null,
			actualHash,
		});
	}
	return actualHash;
}

export function projectTaskPlan(input: unknown): Readonly<TaskPlanV2> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return TaskPlanV2Schema.parse(input);
	const record = input as Record<string, unknown>;
	if (!Array.isArray(record.tasks)) return TaskPlanV2Schema.parse(input);
	const runtimeFields = new Set([
		'status', 'worktreeSubdir', 'baseCommitSha', 'parentTreeSha', 'parentCommitSha',
		'targetTreeSha', 'patchHash', 'failurePacketArtifact', 'repairCount', 'failureMetadata',
		'humanReviewEvidence', 'exceededLimits',
	]);
	const tasks = record.tasks.map((task) => {
		if (!task || typeof task !== 'object' || Array.isArray(task)) return task;
		return Object.fromEntries(Object.entries(task).filter(([key]) => !runtimeFields.has(key)));
	});
	return Object.freeze(TaskPlanV2Schema.parse({ ...record, tasks }));
}

export const taskPlanV2WireProjection = projectTaskPlan;

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
