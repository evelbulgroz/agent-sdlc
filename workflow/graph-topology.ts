// Workflow state channels, route functions, and edge wiring.

import { Annotation, END, START } from '@langchain/langgraph';
import type { RuntimeState } from '../policy/contracts.ts';
import type { GraphStateValues } from './node-helpers.ts';

export type { GraphStateValues };

export const GraphState = Annotation.Root({
	snapshot: Annotation<Readonly<RuntimeState>>({
		reducer: (_left, right) => right,
	}),
	humanResponse: Annotation<unknown>({
		reducer: (_left, right) => right,
		default: () => null,
	}),
});


export interface WorkflowGraphBuilder<TCompiled = unknown> {
	addConditionalEdges(
		source: string,
		path: (state: GraphStateValues) => string,
		pathMap: Record<string, string>,
	): this;
	addEdge(startKey: string, endKey: string): this;
	compile(options?: { checkpointer?: unknown }): TCompiled;
}

export function routeFromStart({ snapshot }: GraphStateValues): string {
	switch (snapshot.state) {
		case 'INITIALIZING':
		case 'SPEC_DRAFTING':
			return 'check_completeness';
		case 'REVIEWING_SPEC':
			return 'execute_spec_critic';
		case 'WAITING_FOR_ANSWERS':
			return 'ask_questions';
		case 'WAITING_FOR_APPROVAL':
			return 'ask_approval';
		case 'SPEC_APPROVED':
			return 'prepare_authorization';
		case 'WAITING_FOR_AUTHORIZATION':
			return 'ask_authorization';
		case 'PLANNING_TASKS':
			return 'plan_tasks';
		case 'EVALUATING_POLICY':
			return 'evaluate_policy_gate';
		case 'REVIEWING_PLAN':
			return 'execute_plan_critic';
		case 'WAITING_FOR_PLAN_ACCEPTANCE':
			return 'ask_plan_critic';
		case 'PREPARING_WORKSPACE':
			return 'prepare_workspace';
		case 'HYDRATING_WORKSPACE':
			return 'hydrate_workspace';
		case 'EXECUTING_IMPLEMENTATION':
			return 'execute_tasks';
		case 'RECONCILING_INTEGRATION':
			if (snapshot.pendingInterruptId) {
				return 'ask_reconciliation_conflict';
			}
			return 'reconcile_integration';
		case 'SNAPSHOT_GENERATION':
			return 'snapshot_generation';
		case 'REVIEWING_GENERATION':
			return 'execute_reviewer';
		case 'VERIFYING_PREFLIGHT':
			return 'execute_verifier';
		case 'REVIEWING_QA':
			return 'execute_qa_critic';
		case 'COMMITTING_CHANGES':
			return 'create_local_commit';
		case 'VERIFYING_COMMITTED_TREE':
			return 'verify_committed_tree';
		case 'DONE':
		case 'READY_FOR_GIT_APPROVAL':
			return 'finalize_run';
		case 'REPAIRING_FAILURE':
			return 'repair_failure';
		case 'FAILED':
			return 'end';
		case 'BLOCKED':
		case 'BUDGET_EXHAUSTED':
		case 'ESCALATED':
			if (snapshot.blockedReason === 'HYDRATION_FAILED') return 'hydrate_workspace';
			if (!snapshot.approvedSpecHash) return 'check_completeness';
			if (!snapshot.taskPlanHash) return 'plan_tasks';
			if (snapshot.taskPlanFrozen !== true) return 'execute_plan_critic';
			if (snapshot.preflightBindingArtifact) return 'execute_qa_critic';
			if (snapshot.targetTreeSha) return 'execute_reviewer';
			if (snapshot.activeGeneration !== undefined && snapshot.activeGeneration !== null) {
				return 'execute_tasks';
			}
			return 'plan_tasks';
		default:
			return 'end';
	}
}

export function routeAfterCompleteness({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'WAITING_FOR_ANSWERS') return 'ask_questions';
	if (snapshot.state === 'ESCALATED' || snapshot.state === 'BLOCKED') return 'end';
	if (snapshot.state !== 'SPEC_DRAFTING') return 'end';
	if (snapshot.specCriticRepairPending) return 'prepare_model_request';
	if (snapshot.completeness.complete) return 'execute_spec_critic';
	if (snapshot.activeProposalArtifact) return 'prepare_questions';
	return 'prepare_model_request';
}

export function routeAfterSpecCritic({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'ESCALATED' || snapshot.state === 'BLOCKED') return 'end';
	if (snapshot.state === 'SPEC_DRAFTING' && snapshot.specCriticRepairPending) {
		return 'prepare_model_request';
	}
	if (snapshot.state === 'REVIEWING_SPEC') {
		return 'prepare_approval';
	}
	return 'end';
}

export function routeAfterModelRequest({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'REVIEWING_SPEC') return 'prepare_approval';
	return snapshot.state === 'SPEC_DRAFTING' && snapshot.activeModelOperationId
		? 'execute_configured_role'
		: 'end';
}

export function routeAfterRole({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'SPEC_DRAFTING') return 'apply_model_patch';
	if (snapshot.state === 'REVIEWING_SPEC') return 'prepare_approval';
	return 'end';
}

export function routeAfterQuestions({ snapshot }: GraphStateValues): string {
	return snapshot.state === 'WAITING_FOR_ANSWERS' ? 'ask_questions' : 'end';
}

export function routeAfterApproval({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'SPEC_DRAFTING') return 'check_completeness';
	return 'end';
}

export function routeAfterPrepareAuth({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'WAITING_FOR_AUTHORIZATION') return 'ask_authorization';
	if (snapshot.state === 'PLANNING_TASKS') return 'plan_tasks';
	return 'end';
}

export function routeAfterApplyAuth({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'PLANNING_TASKS') return 'plan_tasks';
	return 'end';
}

export function routeAfterPlanTasks({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'EVALUATING_POLICY') return 'evaluate_policy_gate';
	return 'end';
}

export function routeAfterPolicyGate({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'REVIEWING_PLAN') return 'execute_plan_critic';
	return 'end';
}

export function routeAfterPlanCritic({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'PREPARING_WORKSPACE') return 'prepare_workspace';
	if (snapshot.state === 'WAITING_FOR_PLAN_ACCEPTANCE') return 'ask_plan_critic';
	return 'end';
}

export function routeAfterApplyPlanCritic({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'PREPARING_WORKSPACE') return 'prepare_workspace';
	return 'end';
}

export function routeAfterPrepareWorkspace({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'HYDRATING_WORKSPACE') return 'hydrate_workspace';
	return 'end';
}

export function routeAfterHydrate({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'EXECUTING_IMPLEMENTATION') return 'execute_tasks';
	return 'end';
}

export function routeAfterTasks({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'RECONCILING_INTEGRATION' && snapshot.pendingInterruptId) {
		return 'ask_reconciliation_conflict';
	}
	if (snapshot.state === 'RECONCILING_INTEGRATION') return 'reconcile_integration';
	if (snapshot.state === 'SNAPSHOT_GENERATION') return 'snapshot_generation';
	return 'end';
}

export function routeAfterReconcile({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'SNAPSHOT_GENERATION') return 'snapshot_generation';
	if (snapshot.state === 'RECONCILING_INTEGRATION' && snapshot.pendingInterruptId) {
		return 'ask_reconciliation_conflict';
	}
	return 'end';
}

export function routeAfterApplyConflict({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'RECONCILING_INTEGRATION') return 'reconcile_integration';
	if (snapshot.state === 'CANCELLED' || snapshot.state === 'ESCALATED') return 'finalize_run';
	return 'end';
}

export function routeAfterSnapshot({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'REVIEWING_GENERATION') return 'execute_reviewer';
	return 'end';
}

export function routeAfterReviewer({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'VERIFYING_PREFLIGHT') return 'execute_verifier';
	if (snapshot.state === 'REPAIRING_FAILURE') return 'repair_failure';
	return 'end';
}

export function routeAfterVerifier({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'REVIEWING_QA') return 'execute_qa_critic';
	if (snapshot.state === 'REPAIRING_FAILURE') return 'repair_failure';
	return 'end';
}

export function routeAfterQaCritic({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'COMMITTING_CHANGES') return 'create_local_commit';
	if (snapshot.state === 'READY_FOR_GIT_APPROVAL') return 'finalize_run';
	if (snapshot.state === 'REPAIRING_FAILURE') return 'repair_failure';
	if (
		snapshot.state === 'ESCALATED' ||
		snapshot.state === 'BLOCKED' ||
		snapshot.state === 'BUDGET_EXHAUSTED'
	) {
		return 'finalize_run';
	}
	return 'end';
}

export function routeAfterCommit({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'VERIFYING_COMMITTED_TREE') return 'verify_committed_tree';
	if (snapshot.state === 'READY_FOR_GIT_APPROVAL') return 'finalize_run';
	if (snapshot.state === 'REPAIRING_FAILURE') return 'repair_failure';
	return 'end';
}

export function routeAfterCommittedVerifier({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'DONE') return 'finalize_run';
	if (snapshot.state === 'REPAIRING_FAILURE') return 'repair_failure';
	return 'end';
}

export function routeAfterRepair({ snapshot }: GraphStateValues): string {
	if (snapshot.state === 'RECONCILING_INTEGRATION') return 'reconcile_integration';
	if (snapshot.state === 'SNAPSHOT_GENERATION') return 'snapshot_generation';
	return 'end';
}

export function wireWorkflowEdges<T extends WorkflowGraphBuilder>(graph: T): T {
	return graph
		.addConditionalEdges(START, routeFromStart, {
			check_completeness: 'check_completeness',
			execute_spec_critic: 'execute_spec_critic',
			ask_questions: 'ask_questions',
			ask_approval: 'ask_approval',
			prepare_authorization: 'prepare_authorization',
			ask_authorization: 'ask_authorization',
			plan_tasks: 'plan_tasks',
			evaluate_policy_gate: 'evaluate_policy_gate',
			execute_plan_critic: 'execute_plan_critic',
			ask_plan_critic: 'ask_plan_critic',
			prepare_workspace: 'prepare_workspace',
			hydrate_workspace: 'hydrate_workspace',
			execute_tasks: 'execute_tasks',
			reconcile_integration: 'reconcile_integration',
			ask_reconciliation_conflict: 'ask_reconciliation_conflict',
			snapshot_generation: 'snapshot_generation',
			execute_reviewer: 'execute_reviewer',
			execute_verifier: 'execute_verifier',
			execute_qa_critic: 'execute_qa_critic',
			create_local_commit: 'create_local_commit',
			verify_committed_tree: 'verify_committed_tree',
			repair_failure: 'repair_failure',
			finalize_run: 'finalize_run',
			end: END,
		})
		.addConditionalEdges('check_completeness', routeAfterCompleteness, {
			prepare_model_request: 'prepare_model_request',
			prepare_questions: 'prepare_questions',
			ask_questions: 'ask_questions',
			execute_spec_critic: 'execute_spec_critic',
			prepare_approval: 'prepare_approval',
			end: END,
		})
		.addConditionalEdges('execute_spec_critic', routeAfterSpecCritic, {
			prepare_model_request: 'prepare_model_request',
			prepare_approval: 'prepare_approval',
			end: END,
		})
		.addConditionalEdges('prepare_model_request', routeAfterModelRequest, {
			execute_configured_role: 'execute_configured_role',
			prepare_approval: 'prepare_approval',
			end: END,
		})
		.addConditionalEdges('execute_configured_role', routeAfterRole, {
			apply_model_patch: 'apply_model_patch',
			prepare_approval: 'prepare_approval',
			end: END,
		})
		.addEdge('apply_model_patch', 'check_completeness')
		.addConditionalEdges('prepare_questions', routeAfterQuestions, {
			ask_questions: 'ask_questions',
			end: END,
		})
		.addEdge('ask_questions', 'apply_answers')
		.addEdge('apply_answers', 'check_completeness')
		.addEdge('prepare_approval', 'ask_approval')
		.addEdge('ask_approval', 'apply_approval')
		.addConditionalEdges('apply_approval', routeAfterApproval, {
			check_completeness: 'check_completeness',
			end: END,
		})
		.addConditionalEdges('prepare_authorization', routeAfterPrepareAuth, {
			ask_authorization: 'ask_authorization',
			plan_tasks: 'plan_tasks',
			end: END,
		})
		.addEdge('ask_authorization', 'apply_authorization')
		.addConditionalEdges('apply_authorization', routeAfterApplyAuth, {
			plan_tasks: 'plan_tasks',
			end: END,
		})
		.addConditionalEdges('plan_tasks', routeAfterPlanTasks, {
			evaluate_policy_gate: 'evaluate_policy_gate',
			end: END,
		})
		.addConditionalEdges('evaluate_policy_gate', routeAfterPolicyGate, {
			execute_plan_critic: 'execute_plan_critic',
			end: END,
		})
		.addConditionalEdges('execute_plan_critic', routeAfterPlanCritic, {
			prepare_workspace: 'prepare_workspace',
			ask_plan_critic: 'ask_plan_critic',
			end: END,
		})
		.addEdge('ask_plan_critic', 'apply_plan_critic')
		.addConditionalEdges('apply_plan_critic', routeAfterApplyPlanCritic, {
			prepare_workspace: 'prepare_workspace',
			end: END,
		})
		.addConditionalEdges('prepare_workspace', routeAfterPrepareWorkspace, {
			hydrate_workspace: 'hydrate_workspace',
			end: END,
		})
		.addConditionalEdges('hydrate_workspace', routeAfterHydrate, {
			execute_tasks: 'execute_tasks',
			end: END,
		})
		.addConditionalEdges('execute_tasks', routeAfterTasks, {
			ask_reconciliation_conflict: 'ask_reconciliation_conflict',
			reconcile_integration: 'reconcile_integration',
			snapshot_generation: 'snapshot_generation',
			end: END,
		})
		.addConditionalEdges('reconcile_integration', routeAfterReconcile, {
			snapshot_generation: 'snapshot_generation',
			ask_reconciliation_conflict: 'ask_reconciliation_conflict',
			end: END,
		})
		.addEdge('ask_reconciliation_conflict', 'apply_reconciliation_conflict')
		.addConditionalEdges('apply_reconciliation_conflict', routeAfterApplyConflict, {
			reconcile_integration: 'reconcile_integration',
			finalize_run: 'finalize_run',
			end: END,
		})
		.addConditionalEdges('snapshot_generation', routeAfterSnapshot, {
			execute_reviewer: 'execute_reviewer',
			end: END,
		})
		.addConditionalEdges('execute_reviewer', routeAfterReviewer, {
			execute_verifier: 'execute_verifier',
			repair_failure: 'repair_failure',
			end: END,
		})
		.addConditionalEdges('execute_verifier', routeAfterVerifier, {
			execute_qa_critic: 'execute_qa_critic',
			repair_failure: 'repair_failure',
			end: END,
		})
		.addConditionalEdges('execute_qa_critic', routeAfterQaCritic, {
			create_local_commit: 'create_local_commit',
			finalize_run: 'finalize_run',
			repair_failure: 'repair_failure',
			end: END,
		})
		.addConditionalEdges('create_local_commit', routeAfterCommit, {
			verify_committed_tree: 'verify_committed_tree',
			finalize_run: 'finalize_run',
			repair_failure: 'repair_failure',
			end: END,
		})
		.addConditionalEdges('verify_committed_tree', routeAfterCommittedVerifier, {
			finalize_run: 'finalize_run',
			repair_failure: 'repair_failure',
			end: END,
		})
		.addConditionalEdges('repair_failure', routeAfterRepair, {
			reconcile_integration: 'reconcile_integration',
			snapshot_generation: 'snapshot_generation',
			end: END,
		})
		.addEdge('finalize_run', END);
}
