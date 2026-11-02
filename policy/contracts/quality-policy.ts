import {
	TaskPlanV2Schema,
	taskPlanV2WireProjection,
	type TaskPlan,
	type TaskPlanV2Runtime,
} from './dag-schema.ts';
import type { QualityPolicy } from './quality-schema.ts';

export function isCheckpointQualityPlan(plan: unknown): plan is TaskPlanV2Runtime {
	if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return false;
	if ((plan as Record<string, unknown>).schemaVersion !== '2.0.0') return false;
	TaskPlanV2Schema.parse(taskPlanV2WireProjection(plan));
	return true;
}

export function getCheckpointQualityPolicy(plan: TaskPlan | unknown): Readonly<QualityPolicy> | null {
	if (!isCheckpointQualityPlan(plan)) return null;
	const parsed = TaskPlanV2Schema.parse(taskPlanV2WireProjection(plan));
	return Object.freeze(structuredClone(parsed.qualityPolicy));
}
