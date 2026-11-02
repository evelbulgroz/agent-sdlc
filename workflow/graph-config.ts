import type { RuntimeState } from '../policy/contracts.ts';
import type { WorkflowRuntimeStorePort } from './node-helpers.ts';

export type WorkflowGraphConfig = {
	configurable: { thread_id: string };
	recursionLimit?: number;
};

export function workflowGraphConfig(
	state: Readonly<RuntimeState>,
	store: Pick<WorkflowRuntimeStorePort, 'getTaskPlan' | 'getAuthorization'>,
): WorkflowGraphConfig {
	const config: WorkflowGraphConfig = { configurable: { thread_id: state.threadId } };
	const plan = store.getTaskPlan(state.runId);
	if (plan?.schemaVersion === '2.0.0') {
		config.recursionLimit = 25 + 2 * plan.slices.filter(slice => slice.kind !== 'enabling').length;
	} else {
		const approved = store.getAuthorization(state.runId)?.qualityPlan;
		if (approved) config.recursionLimit = 25 + 2 * approved.evidenceObligations.length;
	}
	return config;
}
