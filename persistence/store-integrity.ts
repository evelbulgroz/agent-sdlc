import {
	type DagTask,
	type GenerationRecord,
	RUNTIME_SCHEMA_VERSION,
	type RunAuthorizationRecord,
	type RuntimeEvent,
	type RuntimeState,
	type ToolExecutionRecord,
	canonicalJson,
	deriveEventId,
	sha256,
	validateEvent,
	validateGeneration,
	validateRunAuthorization,
	validateToolExecution,
} from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import type { GenerationRecords } from './generation-records.ts';
import type { PendingProjectionItem, ProjectionRecord, ProjectionRecords } from './projection-records.ts';
import type { RunLedger, StoreContext } from './run-ledger.ts';
import type { TaskPlanRecords } from './task-plan-records.ts';

interface EventRow {
	event_id: string; runtime_revision: number; event_type: string; event_json: string; created_at: string;
}

interface OperationSummaryRow {
	operation_id: string; run_id: string; status: string; output_artifact: string | null; usage_record_ids_json: string;
}

interface OutboxSummaryRow {
	runtime_revision: number; projection_revision: number | null; reservation_json: string | null;
	projection_event_json: string | null; status_json: string | null; intent_text: string | null; published_at: string | null;
}

interface AuthSummaryRow {
	run_id: string; approved_spec_hash: string; approved_plan_policy_hash: string; repository_id: string;
	base_commit_sha: string; allowed_packages_json: string; allowed_path_prefixes_json: string;
	allowed_operations_json: string; max_semantic_repairs: number; model_usage_profile: string;
	expires_at: string; approved_at: string; approval_method: string;
}

interface GenerationSummaryRow {
	run_id: string; generation: number; base_commit_sha: string; target_tree_sha: string;
	scope_fingerprints_json: string; task_owned_paths_json: string; materialized_at: string;
}

interface ToolExecutionSummaryRow {
	execution_id: string; run_id: string; task_id: string | null; role_id: string; generation: number;
	step_index: number; tool_name: string; input_hash: string; output_artifact: string | null;
	exit_code: number | null; created_at: string;
}

export interface ReconcileResult {
	state: Readonly<RuntimeState>; latestTransition: Readonly<RuntimeEvent>; transitions: Readonly<RuntimeEvent>[];
	authorization: Readonly<RunAuthorizationRecord> | null; generations: Readonly<GenerationRecord>[];
	toolExecutions: Readonly<ToolExecutionRecord>[]; tasks: Readonly<DagTask>[]; artifactHashes: string[];
	pendingProjections: PendingProjectionItem[]; currentProjection: ProjectionRecord | null;
}

function failReconcile(message: string): never {
	throw new SdlcError('STORE_RECONCILIATION_FAILED', message);
}

export function createStoreIntegrity(
	ctx: StoreContext,
	{
		ledger,
		projections,
		taskPlans,
		generations: generationRecords,
	}: {
		ledger: RunLedger;
		projections: ProjectionRecords;
		taskPlans: TaskPlanRecords;
		generations: GenerationRecords;
	},
) {
	function reconcile(runId: string): ReconcileResult {
		if (typeof generationRecords.listGenerations !== 'function') {
			throw new SdlcError('INTERNAL_ERROR', 'Generation records are required');
		}
		const state = ledger.getRun(runId);
		const rawEventRows: unknown = ctx.database
			.prepare(
				'SELECT event_id, runtime_revision, event_type, event_json, created_at FROM events WHERE run_id = ? ORDER BY runtime_revision, rowid',
			)
			.all(runId);
		const events = (rawEventRows as EventRow[]).map((row) => {
			const event = validateEvent(JSON.parse(row.event_json));
			if (
				row.event_id !== event.eventId ||
				row.runtime_revision !== event.runtimeRevision ||
				row.event_type !== event.eventType ||
				row.created_at !== event.timestamp ||
				event.runId !== runId ||
				event.eventId !== deriveEventId(event)
			) {
				failReconcile('Event columns or deterministic identity diverged');
			}
			return event;
		});
		const nonTransitionEventTypes = new Set<string>([
			'PROJECTION_WRITTEN',
			'GIT_BRANCH_CREATED',
			'OPTIONAL_ROLE_COMPLETED',
			'CRITIC_REVIEW_COMPLETED',
			'TASK_STARTED',
			'TASK_COMPLETED',
			'TASK_FAILED',
			'RECONCILIATION_STARTED',
			'CANDIDATE_LEARNING_STAGED',
		]);
		const transitions = events.filter(
			(event) => event.stateHash !== null && !nonTransitionEventTypes.has(event.eventType),
		);
		if (transitions.length !== state.runtimeRevision + 1) {
			failReconcile('Runtime state and transition event count diverged');
		}
		for (const [index, event] of transitions.entries()) {
			const expectedInputHash =
				index === 0
					? sha256({ goalArtifact: event.payload.goalArtifact })
					: transitions[index - 1].stateHash;
			const expectedOutputHash =
				index === 0
					? sha256({ draftArtifact: event.payload.draftArtifact })
					: sha256(event.payload);
			if (
				event.runtimeRevision !== index ||
				event.stateHash === null ||
				event.inputHash !== expectedInputHash ||
				event.outputHash !== expectedOutputHash ||
				(index === 0 &&
					canonicalJson(event.payload) !==
						canonicalJson({
							goalArtifact: event.payload.goalArtifact,
							draftArtifact: event.payload.draftArtifact,
						}))
			) {
				failReconcile('Transition event hash chain or payload integrity diverged');
			}
		}
		const latestTransition = transitions.at(-1);
		if (
			!latestTransition ||
			latestTransition.runtimeRevision !== state.runtimeRevision ||
			latestTransition.stateHash !== sha256(state)
		) {
			failReconcile('Latest transition event does not match canonical runtime state');
		}
		const rawUnresolved: unknown = ctx.database
			.prepare(
				"SELECT interrupt_id FROM interrupts WHERE run_id = ? AND status IN ('PENDING', 'RESPONSE_RECORDED') ORDER BY created_at",
			)
			.all(runId);
		const unresolved = rawUnresolved as { interrupt_id: string }[];
		if (
			(state.pendingInterruptId === null && unresolved.length !== 0) ||
			(state.pendingInterruptId !== null &&
				(unresolved.length !== 1 || unresolved[0].interrupt_id !== state.pendingInterruptId))
		) {
			failReconcile('Runtime state and interrupt records diverged');
		}
		const interruptStates = [
			'WAITING_FOR_ANSWERS',
			'WAITING_FOR_APPROVAL',
			'WAITING_FOR_AUTHORIZATION',
			'WAITING_FOR_PLAN_ACCEPTANCE',
		];
		const pendingInterruptAllowed =
			interruptStates.includes(state.state) ||
			(state.state === 'RECONCILING_INTEGRATION' && state.pendingInterruptId !== null);
		if (
			(interruptStates.includes(state.state) && state.pendingInterruptId === null) ||
			(!pendingInterruptAllowed && state.pendingInterruptId !== null)
		) {
			failReconcile('Runtime state and pending interrupt lifecycle diverged');
		}
		const rawOperationRows: unknown = ctx.database
			.prepare(
				'SELECT operation_id, run_id, status, output_artifact, usage_record_ids_json FROM model_operations WHERE run_id = ? ORDER BY operation_id',
			)
			.all(runId);
		const operationRows = rawOperationRows as OperationSummaryRow[];
		const operationIds = operationRows.map((row) => row.operation_id);
		const inExecutionState = [
			'EXECUTING_IMPLEMENTATION',
			'REVIEWING_GENERATION',
			'REPAIRING_FAILURE',
		].includes(state.state);
		const committedOpsMatch = inExecutionState
			? state.modelOperations.every((id) => operationIds.includes(id))
			: canonicalJson(operationIds) === canonicalJson([...state.modelOperations].sort());
		if (
			!committedOpsMatch ||
			(state.activeModelOperationId !== null &&
				!state.modelOperations.includes(state.activeModelOperationId))
		) {
			failReconcile('Runtime state and model operations diverged');
		}
		for (const row of operationRows) {
			if (
				row.run_id !== runId ||
				!['requested', 'succeeded', 'failed'].includes(row.status) ||
				!Array.isArray(JSON.parse(row.usage_record_ids_json)) ||
				(row.status === 'succeeded' && !row.output_artifact) ||
				(row.status !== 'succeeded' && row.output_artifact)
			) {
				failReconcile('Model operation record is invalid');
			}
		}
		if (state.activeProposalArtifact) {
			const activeOperation = operationRows.find(
				(row) => row.operation_id === state.activeModelOperationId,
			);
			if (
				!activeOperation ||
				activeOperation.status !== 'succeeded' ||
				activeOperation.output_artifact !== state.activeProposalArtifact
			) {
				failReconcile('Active model proposal diverged from its operation record');
			}
		}
		const rawOutboxRows: unknown = ctx.database
			.prepare(
				'SELECT runtime_revision, projection_revision, reservation_json, projection_event_json, status_json, intent_text, published_at FROM projection_outbox WHERE run_id = ? ORDER BY runtime_revision',
			)
			.all(runId);
		const outboxRows = rawOutboxRows as OutboxSummaryRow[];
		if (
			outboxRows.length !== state.runtimeRevision + 1 ||
			outboxRows.some((row, index) => row.runtime_revision !== index)
		) {
			failReconcile('Projection outbox does not cover every runtime revision');
		}
		const rawContinuationRows: unknown = ctx.database
			.prepare(
				'SELECT runtime_revision, projection_revision, status_json FROM continuation_projections WHERE run_id = ? ORDER BY projection_revision',
			)
			.all(runId);
		const continuationRows = rawContinuationRows as {
			runtime_revision: number;
			projection_revision: number;
			status_json: string;
		}[];
		const assignedProjectionRevisions: number[] = [
			...outboxRows
				.map((row) => row.projection_revision)
				.filter((value): value is number => value !== null),
			...continuationRows.map((row) => row.projection_revision),
		];
		if (
			new Set(assignedProjectionRevisions).size !== assignedProjectionRevisions.length ||
			Math.max(0, ...assignedProjectionRevisions) !== projections.getProjectionRevision(runId)
		) {
			failReconcile('Projection revision reservations diverged');
		}
		for (const row of outboxRows) {
			const materialized = row.status_json !== null || row.intent_text !== null;
			const coveredByLaterProjection =
				!materialized &&
				row.published_at !== null &&
				outboxRows.some(
					(candidate) =>
						candidate.runtime_revision > row.runtime_revision &&
						candidate.published_at !== null &&
						candidate.status_json !== null &&
						candidate.intent_text !== null,
				);
			if (
				(row.reservation_json === null) !== (row.projection_revision === null) ||
				(row.status_json !== null && row.projection_event_json === null) ||
				materialized !== (row.status_json !== null && row.intent_text !== null) ||
				(row.published_at !== null && !materialized && !coveredByLaterProjection)
			) {
				failReconcile('Projection outbox record is incomplete or divergent');
			}
			if (row.projection_event_json !== null) {
				const projectionEvent = validateEvent(JSON.parse(row.projection_event_json));
				const storedEvent = events.find((event) => event.eventId === projectionEvent.eventId);
				const reservation = JSON.parse(row.reservation_json ?? 'null') as {
					intent?: unknown;
					stateHash?: string;
				};
				const intentHash = sha256(reservation.intent);
				const projectionPayloadHash = sha256({
					runId,
					runtimeRevision: row.runtime_revision,
					projectionRevision: row.projection_revision,
					stateHash: reservation.stateHash,
					intentHash,
				});
				if (
					projectionEvent.eventType !== 'PROJECTION_WRITTEN' ||
					projectionEvent.runId !== runId ||
					projectionEvent.runtimeRevision !== row.runtime_revision ||
					projectionEvent.stateHash !== transitions[row.runtime_revision].stateHash ||
					projectionEvent.inputHash !== sha256({ runtimeRevision: row.runtime_revision }) ||
					projectionEvent.outputHash !== sha256({ projectionPayloadHash }) ||
					reservation.stateHash !== transitions[row.runtime_revision].stateHash ||
					canonicalJson(projectionEvent.payload) !==
						canonicalJson({
							intentHash,
							projectionPayloadHash,
							projectionRevision: row.projection_revision,
						}) ||
					!storedEvent ||
					canonicalJson(storedEvent) !== canonicalJson(projectionEvent)
				) {
					failReconcile('Projection event record diverged from the event log');
				}
			}
			if (row.status_json !== null) {
				const status = JSON.parse(row.status_json) as {
					runId?: string;
					revision?: number;
					orchestration?: {
						runtimeRevision?: number;
						eventLogHash?: string;
						projectionHash?: string | null;
						[key: string]: unknown;
					};
					[key: string]: unknown;
				};
				const reservation = JSON.parse(row.reservation_json ?? 'null') as {
					projectionRevision?: number;
					runtimeRevision?: number;
				};
				const parsedEvent = JSON.parse(row.projection_event_json ?? 'null') as {
					eventId?: string;
				} | null;
				const projectionEventIndex = events.findIndex((event) => event.eventId === parsedEvent?.eventId);
				if (
					status.runId !== runId ||
					status.revision !== row.projection_revision ||
					status.orchestration?.runtimeRevision !== row.runtime_revision ||
					projectionEventIndex < 0 ||
					status.orchestration?.eventLogHash !== sha256(events.slice(0, projectionEventIndex + 1)) ||
					status.orchestration?.projectionHash !==
						sha256({
							...status,
							orchestration: { ...status.orchestration, projectionHash: null },
						}) ||
					reservation.projectionRevision !== row.projection_revision ||
					reservation.runtimeRevision !== row.runtime_revision
				) {
					failReconcile('Projection payload diverged from its outbox reservation');
				}
			}
		}
		const outboxRuntimeRevisions = new Set(outboxRows.map((row) => row.runtime_revision));
		for (const row of continuationRows) {
			const status = JSON.parse(row.status_json) as {
				revision?: number;
				orchestration?: {
					runtimeRevision?: number;
					projectionHash?: string | null;
					[key: string]: unknown;
				};
				[key: string]: unknown;
			};
			if (
				!outboxRuntimeRevisions.has(row.runtime_revision) ||
				status.revision !== row.projection_revision ||
				status.orchestration?.runtimeRevision !== row.runtime_revision ||
				status.orchestration?.projectionHash !==
					sha256({
						...status,
						orchestration: { ...status.orchestration, projectionHash: null },
					})
			) {
				failReconcile('Continuation projection diverged from its published status');
			}
		}
		const artifactHashes = new Set<string>(
			[
				state.goalArtifact,
				state.draftArtifact,
				state.taskManifestArtifact,
				state.activeProposalArtifact,
			].filter((val): val is string => Boolean(val)),
		);
		const rawInterruptArtifacts: unknown = ctx.database
			.prepare('SELECT request_artifact, response_artifact FROM interrupts WHERE run_id = ?')
			.all(runId);
		for (const row of rawInterruptArtifacts as { request_artifact: string; response_artifact: string | null }[]) {
			artifactHashes.add(row.request_artifact);
			if (row.response_artifact) artifactHashes.add(row.response_artifact);
		}
		for (const row of operationRows) {
			if (row.output_artifact) artifactHashes.add(row.output_artifact);
		}
		const rawAuthRow: unknown = ctx.database
			.prepare('SELECT * FROM run_authorizations WHERE run_id = ?')
			.get(runId);
		const authRow = rawAuthRow as AuthSummaryRow | undefined;
		let authorization: Readonly<RunAuthorizationRecord> | null = null;
		if (authRow) {
			authorization = validateRunAuthorization({
				schemaVersion: RUNTIME_SCHEMA_VERSION,
				runId: authRow.run_id,
				approvedSpecHash: authRow.approved_spec_hash,
				approvedPlanPolicyHash: authRow.approved_plan_policy_hash,
				repositoryId: authRow.repository_id,
				baseCommitSha: authRow.base_commit_sha,
				allowedPackages: JSON.parse(authRow.allowed_packages_json),
				allowedPathPrefixes: JSON.parse(authRow.allowed_path_prefixes_json),
				allowedOperations: JSON.parse(authRow.allowed_operations_json),
				maxSemanticRepairs: authRow.max_semantic_repairs,
				modelUsageProfile: authRow.model_usage_profile,
				expiresAt: authRow.expires_at,
				approvedAt: authRow.approved_at,
				approvalMethod: authRow.approval_method,
			});
			if (state.approvedSpecHash && authorization.approvedSpecHash !== state.approvedSpecHash) {
				failReconcile('Run authorization approvedSpecHash diverged from runtime state');
			}
		}
		const rawGenRows: unknown = ctx.database
			.prepare('SELECT * FROM generations WHERE run_id = ? ORDER BY generation ASC')
			.all(runId);
		const genRows = rawGenRows as GenerationSummaryRow[];
		const generations = genRows.map((row, index) => {
			const firstGeneration = genRows[0]?.generation ?? 0;
			if (row.generation !== firstGeneration + index) {
				failReconcile('Generations must be sequentially indexed without gaps');
			}
			return validateGeneration({
				schemaVersion: RUNTIME_SCHEMA_VERSION,
				runId: row.run_id,
				generation: row.generation,
				baseCommitSha: row.base_commit_sha,
				targetTreeSha: row.target_tree_sha,
				scopeFingerprints: JSON.parse(row.scope_fingerprints_json),
				taskOwnedPaths: JSON.parse(row.task_owned_paths_json),
				materializedAt: row.materialized_at,
			});
		});
		const rawToolExecRows: unknown = ctx.database
			.prepare('SELECT * FROM tool_executions WHERE run_id = ? ORDER BY generation ASC, step_index ASC')
			.all(runId);
		const toolExecutions = (rawToolExecRows as ToolExecutionSummaryRow[]).map((row) => {
			if (row.output_artifact) artifactHashes.add(row.output_artifact);
			return validateToolExecution({
				schemaVersion: RUNTIME_SCHEMA_VERSION,
				executionId: row.execution_id,
				runId: row.run_id,
				taskId: row.task_id ?? 'task-0',
				roleId: row.role_id,
				generation: row.generation,
				stepIndex: row.step_index,
				toolName: row.tool_name,
				inputHash: row.input_hash,
				outputArtifact: row.output_artifact,
				exitCode: row.exit_code,
				createdAt: row.created_at,
			});
		});
		const rawDagTaskRows: unknown = ctx.database
			.prepare('SELECT failure_packet_artifact FROM dag_tasks WHERE run_id = ?')
			.all(runId);
		for (const row of rawDagTaskRows as { failure_packet_artifact: string | null }[]) {
			if (row.failure_packet_artifact) artifactHashes.add(row.failure_packet_artifact);
		}
		for (const hash of artifactHashes) {
			if (!ledger.getArtifact(hash)) failReconcile(`Referenced artifact ${hash} is missing`);
		}
		return {
			state,
			latestTransition,
			transitions,
			authorization,
			generations,
			toolExecutions,
			tasks: taskPlans.listTasks(runId),
			artifactHashes: [...artifactHashes],
			pendingProjections: projections.listPendingProjections(runId),
			currentProjection: projections.getProjectionRecord(runId, state.runtimeRevision),
		};
	}

	return { reconcile };
}

export type StoreIntegrity = ReturnType<typeof createStoreIntegrity>;
