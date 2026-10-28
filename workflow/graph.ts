// Workflow runtime. buildGraph binds each node id to a factory and then wires the edges.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { Command, StateGraph } from '@langchain/langgraph';
import { emitRuntimeTransitionProgress } from '../cli/progress.ts';
import { RuntimeStoreCheckpointer } from '../persistence/langgraph-checkpointer.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { validateAuthorizationEnvelope } from '../policy/authorization.ts';
import {
	RUNTIME_SCHEMA_VERSION, type RuntimeState, TERMINAL_STATES,
	createEvent, sha256, validateRuntimeState,
} from '../policy/contracts.ts';
import { SdlcError, isGovernorRecoverableError } from '../policy/errors.ts';
import { RoleExecutor, type RoleExecutorGovernorPort } from '../roles/role-executor.ts';
import type { RoleRegistry } from '../roles/role-registry.ts';
import type { GitCliFn } from './git-manager.ts';
import { GraphState, type WorkflowGraphBuilder, wireWorkflowEdges } from './graph-topology.ts';
import type {
	WorkflowArtifactStorePort, WorkflowRuntimeLike, WorkflowRuntimeStorePort, WorkflowTransitionOptions,
} from './node-helpers.ts';
import {
	createApplyApprovalNode, createAskApprovalNode, createExecuteSpecCriticNode, createPrepareApprovalNode,
} from './nodes/approval.ts';
import {
	createApplyAuthorizationNode, createAskAuthorizationNode, createPrepareAuthorizationNode,
} from './nodes/authorization.ts';
import { createCreateLocalCommitNode, createVerifyCommittedTreeNode } from './nodes/commit.ts';
import { createExecuteTasksNode } from './nodes/execute-tasks.ts';
import { createFinalizeRunNode, createRepairFailureNode } from './nodes/finish-run.ts';
import {
	createApplyPlanCriticNode, createAskPlanCriticNode, createEvaluatePolicyGateNode,
	createExecutePlanCriticNode, createPlanTasksNode,
} from './nodes/planning.ts';
import {
	createApplyReconciliationConflictNode, createAskReconciliationConflictNode, createReconcileIntegrationNode,
} from './nodes/reconcile.ts';
import {
	createExecuteQaCriticNode, createExecuteReviewerNode, createExecuteVerifierNode, createSnapshotGenerationNode,
} from './nodes/review-qa.ts';
import {
	createApplyModelPatchNode, createCheckCompletenessNode, createExecuteConfiguredRoleNode, createPrepareModelRequestNode,
} from './nodes/spec-draft.ts';
import {
	createApplyAnswersNode, createAskQuestionsNode, createPrepareQuestionsNode,
} from './nodes/spec-interview.ts';
import { createHydrateWorkspaceNode, createPrepareWorkspaceNode } from './nodes/workspace.ts';
import { approvedInputHash, parseSpecification, taskManifestHash } from './specification.ts';

export type ExecCliFn = GitCliFn;

export interface SdlcWorkflowRuntimeOptions {
	runtimeStore: WorkflowRuntimeStorePort;
	artifactStore: WorkflowArtifactStorePort;
	registry: RoleRegistry;
	governor: RoleExecutorGovernorPort;
	now?: () => Date;
	onBoundary?: (boundary: string, context: Record<string, unknown>) => Promise<void>;
	execCli?: GitCliFn;
	gitCli?: GitCliFn;
	ghCli?: GitCliFn | null;
	rootDir?: string;
}

function isColdCheckpointResume(error: unknown): boolean {
	const rec =
		error && typeof error === 'object'
			? (error as { message?: unknown; cause?: { message?: unknown } })
			: null;
	const message = `${String(rec?.message ?? '')} ${String(rec?.cause?.message ?? '')}`;
	return message.includes('no input writes');
}

interface CompiledWorkflowGraph {
	invoke(input: unknown, config?: Record<string, unknown>): Promise<unknown>;
}

export class SdlcWorkflowRuntime implements WorkflowRuntimeLike {
	readonly runtimeStore: WorkflowRuntimeStorePort;
	readonly artifactStore: WorkflowArtifactStorePort;
	readonly registry: RoleRegistry;
	readonly governor: RoleExecutorGovernorPort;
	readonly now: () => Date;
	readonly onBoundary: (boundary: string, context: Record<string, unknown>) => Promise<void>;
	readonly execCli: GitCliFn;
	readonly gitCli: GitCliFn;
	readonly ghCli: GitCliFn;
	readonly rootDir: string;
	readonly checkpointer: RuntimeStoreCheckpointer;
	readonly roleExecutor: RoleExecutor;
	readonly graph: CompiledWorkflowGraph;

	constructor({
		runtimeStore, artifactStore, registry, governor,
		now = () => new Date(), onBoundary,
		execCli = execFileSync as GitCliFn, gitCli = execFileSync as GitCliFn,
		ghCli = execFileSync as GitCliFn, rootDir = REPOSITORY_ROOT,
	}: SdlcWorkflowRuntimeOptions) {
		this.runtimeStore = runtimeStore;
		this.artifactStore = artifactStore;
		this.registry = registry;
		this.governor = governor;
		this.now = now;
		this.onBoundary = onBoundary ?? (async () => {});
		this.execCli = execCli;
		this.gitCli = gitCli;
		this.ghCli = ghCli ?? (execFileSync as GitCliFn);
		this.rootDir = rootDir;
		this.checkpointer = new RuntimeStoreCheckpointer(runtimeStore);
		this.roleExecutor = new RoleExecutor({
			governor,
			runtimeStore,
			artifactStore,
			onBoundary: this.onBoundary,
		});
		this.graph = buildGraph(this);
	}

	initialize({
		runId,
		goal,
		authorVendor,
		taskManifest = null,
		expectedTaskManifestHash = null,
		executor = null,
	}: {
		runId: string;
		goal: string;
		authorVendor?: string | null;
		taskManifest?: unknown;
		expectedTaskManifestHash?: string | null;
		executor?: string | null;
	}): Readonly<RuntimeState> {
		const loaded = this.registry.load();
		const goalArtifact = this.artifactStore.writeText('goal', goal);
		const draft = parseSpecification(goal);
		const draftArtifact = this.artifactStore.writeJson('specification-draft', draft);
		const resolvedTaskManifestHash =
			taskManifest === null ? null : taskManifestHash(taskManifest);
		if (
			expectedTaskManifestHash !== null &&
			expectedTaskManifestHash !== resolvedTaskManifestHash
		) {
			throw new SdlcError(
				'INVALID_CONTRACT',
				'Task manifest bytes do not match the approved persisted manifest hash',
			);
		}
		const taskManifestArtifact =
			taskManifest === null
				? null
				: this.artifactStore.writeJson('task-manifest', taskManifest);
		const now = this.now().toISOString();
		const initial = validateRuntimeState({
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			runId,
			threadId: crypto.randomUUID(),
			runtimeRevision: 0,
			state: 'INITIALIZING',
			goalArtifact,
			draftArtifact,
			draftHash: approvedInputHash(draft, resolvedTaskManifestHash),
			taskManifestArtifact,
			taskManifestHash: resolvedTaskManifestHash,
			completeness: {
				complete: false,
				missingFields: [],
				ambiguousFields: [],
			},
			pendingInterruptId: null,
			approvedSpecHash: null,
			authorVendor: authorVendor ?? null,
			...(typeof executor === 'string' && executor.length > 0 ? { executor } : {}),
			modelOperations: [],
			blockedReason: null,
			lastError: null,
			...loaded.hashes,
			completenessHash: null,
			activeModelOperationId: null,
			activeProposalArtifact: null,
			interviewRound: 0,
			specApprovalAttempt: 0,
			specCriticRepairPending: false,
			createdAt: now,
			updatedAt: now,
		});
		const initialEvent = createEvent({
			eventType: 'RUN_INITIALIZED',
			runId,
			runtimeRevision: 0,
			state: initial,
			input: { goalArtifact },
			output: { draftArtifact },
			causalId: 'initialize-run',
			payload: { goalArtifact, draftArtifact },
			now: this.now(),
		});
		this.runtimeStore.initializeRun(initial, initialEvent);
		return this.transition(initial, {
			to: 'SPEC_DRAFTING',
			eventType: 'DRAFT_CREATED',
			causalId: 'create-initial-draft',
			updates: {},
			payload: { draftArtifact },
		});
	}

	async start(state: Readonly<RuntimeState>): Promise<Readonly<RuntimeState>> {
		if (TERMINAL_STATES.has(state.state)) return state;
		state = this.ensureConfigurationCurrent(state);
		if (state.state === 'ESCALATED') return state;
		const config = this.configFor(state);
		await this.graph.invoke({ snapshot: state, humanResponse: null }, config);
		return this.runtimeStore.getRun(state.runId);
	}

	async startExternalTransition(state: Readonly<RuntimeState>): Promise<Readonly<RuntimeState>> {
		if (TERMINAL_STATES.has(state.state)) return state;
		state = this.ensureConfigurationCurrent(state);
		const config = {
			configurable: {
				thread_id: state.threadId,
				checkpoint_ns: `external-transition-${state.runtimeRevision}`,
			},
		};
		await this.graph.invoke({ snapshot: state, humanResponse: null }, config);
		const current = this.runtimeStore.getRun(state.runId);
		const tuple = await this.checkpointer.getTuple(config);
		if (tuple) {
			await this.checkpointer.put(
				this.configFor(current),
				{
					...tuple.checkpoint,
					id: `zzzz-${String(current.runtimeRevision).padStart(12, '0')}-${crypto.randomUUID()}`,
					channel_values: {
						...tuple.checkpoint.channel_values,
						snapshot: current,
					},
				},
				tuple.metadata ?? { source: 'update', step: 0, parents: {} },
			);
		}
		return current;
	}

	async resume(state: Readonly<RuntimeState>, response: unknown): Promise<Readonly<RuntimeState>> {
		if (TERMINAL_STATES.has(state.state)) return state;
		state = this.ensureConfigurationCurrent(state);
		if (state.state === 'ESCALATED') return state;
		const config = this.configFor(state);
		await this.graph.invoke(new Command({ resume: response }), config);
		return this.runtimeStore.getRun(state.runId);
	}

	async continue(state: Readonly<RuntimeState>): Promise<Readonly<RuntimeState>> {
		if (
			TERMINAL_STATES.has(state.state) &&
			!(state.state === 'FAILED' && isGovernorRecoverableError(state.lastError))
		) {
			return state;
		}
		state = this.ensureConfigurationCurrent(state);
		if (state.state === 'ESCALATED') return state;
		const revision = state.runtimeRevision;
		try {
			await this.graph.invoke(null, this.configFor(state));
		} catch (error: unknown) {
			if (!isColdCheckpointResume(error)) throw error;
		}
		let current = this.runtimeStore.getRun(state.runId);
		if (
			current.runtimeRevision === revision &&
			![
				'WAITING_FOR_ANSWERS',
				'WAITING_FOR_APPROVAL',
				'WAITING_FOR_AUTHORIZATION',
				'WAITING_FOR_PLAN_ACCEPTANCE',
			].includes(current.state)
		) {
			await this.graph.invoke({ snapshot: current, humanResponse: null }, this.configFor(current));
			current = this.runtimeStore.getRun(state.runId);
		}
		return current;
	}

	async authorize(stateInput: unknown, envelopeInput: unknown): Promise<Readonly<RuntimeState>> {
		let state = validateRuntimeState(stateInput);
		if (state.state !== 'SPEC_APPROVED' && state.state !== 'WAITING_FOR_AUTHORIZATION') {
			throw new SdlcError(
				'INVALID_TRANSITION',
				`Cannot authorize run in state '${state.state}' (must be SPEC_APPROVED or WAITING_FOR_AUTHORIZATION)`,
			);
		}
		const envelope = validateAuthorizationEnvelope(envelopeInput, {
			currentRunId: state.runId,
			currentSpecHash: state.approvedSpecHash ?? undefined,
			currentTaskManifestHash: state.taskManifestHash,
			now: this.now(),
		});
		this.runtimeStore.saveAuthorization(envelope);
		const pending = state.pendingInterruptId
			? this.runtimeStore.getInterrupt(state.pendingInterruptId)
			: null;
		if (pending && pending.kind === 'authorization') {
			if (pending.status === 'PENDING') {
				this.runtimeStore.recordInterruptResponse(
					pending.interruptId,
					this.artifactStore.writeJson('human-response', envelope),
				);
			}
			state = this.transition(state, {
				to: 'PLANNING_TASKS',
				eventType: 'RUN_AUTHORIZED',
				causalId: pending.interruptId,
				updates: {
					pendingInterruptId: null,
					approvedPlanPolicyHash: envelope.approvedPlanPolicyHash,
					semanticRepairsCount: 0,
				},
				payload: { interruptId: pending.interruptId, authorization: envelope },
				effects: { resolveInterruptId: pending.interruptId },
			});
		} else {
			state = this.transition(state, {
				to: 'PLANNING_TASKS',
				eventType: 'RUN_AUTHORIZED',
				causalId: `authorize-${state.runtimeRevision}`,
				updates: {
					approvedPlanPolicyHash: envelope.approvedPlanPolicyHash,
					semanticRepairsCount: 0,
				},
				payload: { authorization: envelope },
			});
		}
		await this.onBoundary('authorization-transition-recorded', {
			runId: state.runId,
			runtimeRevision: state.runtimeRevision,
		});
		const config = this.configFor(state);
		await this.graph.invoke({ snapshot: state, humanResponse: null }, config);
		return this.runtimeStore.getRun(state.runId);
	}

	configFor(state: Readonly<RuntimeState>): { configurable: { thread_id: string } } {
		return {
			configurable: {
				thread_id: state.threadId,
			},
		};
	}

	transition(
		currentInput: unknown,
		{ to, eventType, causalId, updates, payload, effects }: WorkflowTransitionOptions,
	): Readonly<RuntimeState> {
		const current = validateRuntimeState(currentInput);
		const now = this.now();
		const next = validateRuntimeState({
			...current,
			...updates,
			state: to,
			runtimeRevision: current.runtimeRevision + 1,
			updatedAt: now.toISOString(),
		});
		const event = createEvent({
			eventType,
			runId: next.runId,
			runtimeRevision: next.runtimeRevision,
			state: next,
			input: current,
			output: payload,
			causalId,
			payload,
			now,
		});
		const stored = this.runtimeStore.saveTransition(current.runtimeRevision, next, event, effects);
		emitRuntimeTransitionProgress(stored);
		return stored;
	}

	currentOrAlreadyAdvanced(snapshot: Readonly<RuntimeState>): Readonly<RuntimeState> | null {
		const current = this.runtimeStore.getRun(snapshot.runId);
		return current.runtimeRevision > snapshot.runtimeRevision ? current : null;
	}

	async invokeStoredResponse(state: Readonly<RuntimeState>): Promise<Readonly<RuntimeState>> {
		state = await this.synchronizeCheckpoint(state);
		const pending = this.runtimeStore.getPendingInterrupt(state.runId);
		if (!pending || pending.status !== 'RESPONSE_RECORDED' || !pending.responseArtifact) {
			return state;
		}
		return this.resume(state, this.artifactStore.readJson(pending.responseArtifact));
	}

	async synchronizeCheckpoint(state: Readonly<RuntimeState>): Promise<Readonly<RuntimeState>> {
		const tuple = await this.checkpointer.getTuple(this.configFor(state));
		const checkpointState = tuple?.checkpoint?.channel_values?.snapshot as
			| RuntimeState
			| undefined;
		if (
			checkpointState &&
			checkpointState.runtimeRevision === state.runtimeRevision &&
			sha256(checkpointState) === sha256(state)
		) {
			return state;
		}
		const checkpointInterrupt = checkpointState?.pendingInterruptId
			? this.runtimeStore.getInterrupt(checkpointState.pendingInterruptId)
			: null;
		if (checkpointInterrupt?.responseArtifact) {
			await this.graph.invoke(
				new Command({
					resume: this.artifactStore.readJson(checkpointInterrupt.responseArtifact),
				}),
				this.configFor(state),
			);
		} else {
			try {
				await this.graph.invoke(null, this.configFor(state));
			} catch (error: unknown) {
				if (!isColdCheckpointResume(error)) throw error;
				return state;
			}
		}
		return this.runtimeStore.getRun(state.runId);
	}

	ensureConfigurationCurrent(state: Readonly<RuntimeState>): Readonly<RuntimeState> {
		const loaded = this.registry.load();
		const stateRec = state as Record<string, unknown>;
		const changed = Object.entries(loaded.hashes).some(([field, hash]) => stateRec[field] !== hash);
		if (!changed) return state;
		return this.transition(state, {
			to: 'ESCALATED',
			eventType: 'RUN_BLOCKED',
			causalId: `configuration-changed-${state.runtimeRevision}`,
			updates: {
				pendingInterruptId: null,
				approvedSpecHash: null,
				blockedReason: 'CONFIGURATION_CHANGED',
				lastError: {
					code: 'CONFIGURATION_CHANGED',
					message: 'Workflow, role, prompt, capability, or evaluator policy changed',
				},
			},
			payload: { reason: 'CONFIGURATION_CHANGED' },
			effects: state.pendingInterruptId
				? { cancelInterruptId: state.pendingInterruptId }
				: undefined,
		});
	}
}

function buildGraph(runtime: SdlcWorkflowRuntime): CompiledWorkflowGraph {
	const rawGraph: unknown = new StateGraph(GraphState)
		.addNode('check_completeness', createCheckCompletenessNode(runtime))
		.addNode('prepare_model_request', createPrepareModelRequestNode(runtime))
		.addNode('execute_configured_role', createExecuteConfiguredRoleNode(runtime))
		.addNode('apply_model_patch', createApplyModelPatchNode(runtime))
		.addNode('prepare_questions', createPrepareQuestionsNode(runtime))
		.addNode('ask_questions', createAskQuestionsNode(runtime))
		.addNode('apply_answers', createApplyAnswersNode(runtime))
		.addNode('execute_spec_critic', createExecuteSpecCriticNode(runtime))
		.addNode('prepare_approval', createPrepareApprovalNode(runtime))
		.addNode('ask_approval', createAskApprovalNode(runtime))
		.addNode('apply_approval', createApplyApprovalNode(runtime))
		.addNode('prepare_authorization', createPrepareAuthorizationNode(runtime))
		.addNode('ask_authorization', createAskAuthorizationNode(runtime))
		.addNode('apply_authorization', createApplyAuthorizationNode(runtime))
		.addNode('plan_tasks', createPlanTasksNode(runtime))
		.addNode('evaluate_policy_gate', createEvaluatePolicyGateNode(runtime))
		.addNode('execute_plan_critic', createExecutePlanCriticNode(runtime))
		.addNode('ask_plan_critic', createAskPlanCriticNode(runtime))
		.addNode('apply_plan_critic', createApplyPlanCriticNode(runtime))
		.addNode('prepare_workspace', createPrepareWorkspaceNode(runtime))
		.addNode('hydrate_workspace', createHydrateWorkspaceNode(runtime))
		.addNode('execute_tasks', createExecuteTasksNode(runtime))
		.addNode('reconcile_integration', createReconcileIntegrationNode(runtime))
		.addNode('ask_reconciliation_conflict', createAskReconciliationConflictNode(runtime))
		.addNode('apply_reconciliation_conflict', createApplyReconciliationConflictNode(runtime))
		.addNode('snapshot_generation', createSnapshotGenerationNode(runtime))
		.addNode('execute_reviewer', createExecuteReviewerNode(runtime))
		.addNode('execute_verifier', createExecuteVerifierNode(runtime))
		.addNode('execute_qa_critic', createExecuteQaCriticNode(runtime))
		.addNode('create_local_commit', createCreateLocalCommitNode(runtime))
		.addNode('verify_committed_tree', createVerifyCommittedTreeNode(runtime))
		.addNode('repair_failure', createRepairFailureNode(runtime))
		.addNode('finalize_run', createFinalizeRunNode(runtime));
	const graph = rawGraph as WorkflowGraphBuilder<CompiledWorkflowGraph>;
	return wireWorkflowEdges(graph).compile({ checkpointer: runtime.checkpointer });
}
