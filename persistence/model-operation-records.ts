import crypto from 'node:crypto';
import {
	canonicalJson,
	createEvent,
	validateFalseEconomyDiagnostic,
	validateRunId,
} from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import type { RunLedger, SqlParam, StoreContext } from './run-ledger.ts';

interface ModelOperationDbRow {
	operation_id: string;
	run_id: string;
	synthetic: number;
	status: string;
	output_artifact: string | null;
	usage_record_ids_json: string;
	error_code: string | null;
	created_at: string;
	updated_at: string;
	effective_strategy: string | null;
	selected_quality_tier: number | null;
	counterfactual_tier2_cost_microusd: number | null;
	task_id: string | null;
	role_id: string | null;
	route_id: string | null;
	provider: string | null;
	model_id: string | null;
	physical_attempts: number | null;
	attempted_routes_json: string | null;
}

interface DiagnosticDbRow {
	diagnostic_id: string;
	run_id: string;
	task_id: string;
	kind: string;
	payload_json: string;
	created_at: string;
}

export interface ModelOperationInput {
	operationId: string;
	runId: string;
	synthetic: boolean;
	status: string;
	outputArtifact?: string | null;
	usageRecordIds?: readonly string[];
	errorCode?: string | null;
	effectiveStrategy?: string | null;
	selectedQualityTier?: number | null;
	counterfactualTier2CostMicrousd?: number | null;
	taskId?: string | null;
	roleId?: string | null;
	routeId?: string | null;
	provider?: string | null;
	modelId?: string | null;
	physicalAttempts?: number | null;
	attemptedRoutes?: readonly unknown[];
	now?: Date;
}

export interface ModelOperationRecord {
	operationId: string;
	runId: string;
	synthetic: boolean;
	status: string;
	outputArtifact: string | null;
	usageRecordIds: string[];
	errorCode: string | null;
	createdAt: string;
	updatedAt: string;
	effectiveStrategy: string | undefined;
	selectedQualityTier: number | undefined;
	counterfactualTier2CostMicrousd: number | undefined;
	taskId: string | undefined;
	roleId: string | undefined;
	routeId: string | undefined;
	provider: string | undefined;
	modelId: string | undefined;
	physicalAttempts: number | undefined;
	attemptedRoutes: readonly unknown[];
}

export interface DiagnosticInput {
	diagnosticId?: string;
	runId: string;
	taskId: string;
	kind: string;
	payload: unknown;
	causalId?: string | null;
	now?: Date | string | number;
}

export interface DiagnosticRecord {
	diagnosticId: string;
	runId: string;
	taskId: string;
	kind: string;
	payload: unknown;
	createdAt: string;
}

export interface ModelOperationRecords {
	recordModelOperation(input: ModelOperationInput): ModelOperationRecord | null;
	getModelOperation(operationId: string): ModelOperationRecord | null;
	countModelOperations(runId: string, options?: { onlySuccessful?: boolean }): number;
	recordDiagnostic(input: DiagnosticInput): DiagnosticRecord;
	listDiagnostics(runId: string, kind?: string | null): DiagnosticRecord[];
}

export function createModelOperationRecords(
	ctx: StoreContext,
	ledger: RunLedger,
): ModelOperationRecords {
	function recordModelOperation({
		operationId,
		runId,
		synthetic,
		status,
		outputArtifact = null,
		usageRecordIds = [],
		errorCode = null,
		effectiveStrategy = null,
		selectedQualityTier = null,
		counterfactualTier2CostMicrousd = null,
		taskId = null,
		roleId = null,
		routeId = null,
		provider = null,
		modelId = null,
		physicalAttempts = null,
		attemptedRoutes = [],
		now = new Date(),
	}: ModelOperationInput): ModelOperationRecord | null {
		return ctx.transaction(() => {
			const existing = getModelOperation(operationId);
			const resolvedEffectiveStrategy = effectiveStrategy ?? existing?.effectiveStrategy ?? null;
			const resolvedSelectedQualityTier =
				selectedQualityTier ?? existing?.selectedQualityTier ?? null;
			const resolvedCounterfactual =
				counterfactualTier2CostMicrousd ?? existing?.counterfactualTier2CostMicrousd ?? null;
			const resolvedTaskId = taskId ?? existing?.taskId ?? null;
			const resolvedRoleId = roleId ?? existing?.roleId ?? null;
			const resolvedRouteId = routeId ?? existing?.routeId ?? null;
			const resolvedProvider = provider ?? existing?.provider ?? null;
			const resolvedModelId = modelId ?? existing?.modelId ?? null;
			const resolvedPhysicalAttempts = physicalAttempts ?? existing?.physicalAttempts ?? null;
			const resolvedAttemptedRoutes =
				attemptedRoutes.length > 0 ? attemptedRoutes : (existing?.attemptedRoutes ?? []);

			const values: SqlParam[] = [
				operationId,
				runId,
				synthetic ? 1 : 0,
				status,
				outputArtifact,
				canonicalJson(usageRecordIds),
				errorCode,
				now.toISOString(),
				now.toISOString(),
				resolvedEffectiveStrategy,
				resolvedSelectedQualityTier,
				resolvedCounterfactual,
				resolvedTaskId,
				resolvedRoleId,
				resolvedRouteId,
				resolvedProvider,
				resolvedModelId,
				resolvedPhysicalAttempts,
				canonicalJson(resolvedAttemptedRoutes),
			];
			if (!existing) {
				ctx.database
					.prepare(
						`
						INSERT INTO model_operations (
							operation_id, run_id, synthetic, status, output_artifact,
							usage_record_ids_json, error_code, created_at, updated_at,
							effective_strategy, selected_quality_tier, counterfactual_tier2_cost_microusd,
							task_id, role_id, route_id, provider, model_id, physical_attempts,
							attempted_routes_json
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					`,
					)
					.run(...values);
			} else {
				if (existing.runId !== runId || existing.synthetic !== synthetic) {
					throw new SdlcError('STORE_RECONCILIATION_FAILED', 'Model operation ID collision');
				}
				ctx.database
					.prepare(
						`
						UPDATE model_operations SET status = ?, output_artifact = ?,
							usage_record_ids_json = ?, error_code = ?, updated_at = ?,
							effective_strategy = ?, selected_quality_tier = ?,
							counterfactual_tier2_cost_microusd = ?, task_id = ?, role_id = ?,
							route_id = ?, provider = ?, model_id = ?, physical_attempts = ?,
							attempted_routes_json = ?
						WHERE operation_id = ?
					`,
					)
					.run(
						status,
						outputArtifact,
						canonicalJson(usageRecordIds),
						errorCode,
						now.toISOString(),
						resolvedEffectiveStrategy,
						resolvedSelectedQualityTier,
						resolvedCounterfactual,
						resolvedTaskId,
						resolvedRoleId,
						resolvedRouteId,
						resolvedProvider,
						resolvedModelId,
						resolvedPhysicalAttempts,
						canonicalJson(resolvedAttemptedRoutes),
						operationId,
					);
			}
			return getModelOperation(operationId);
		});
	}

	function getModelOperation(operationId: string): ModelOperationRecord | null {
		const raw: unknown = ctx.database
			.prepare('SELECT * FROM model_operations WHERE operation_id = ?')
			.get(operationId);
		const row = raw as ModelOperationDbRow | undefined;
		if (!row) return null;
		return {
			operationId: row.operation_id,
			runId: row.run_id,
			synthetic: row.synthetic === 1,
			status: row.status,
			outputArtifact: row.output_artifact,
			usageRecordIds: JSON.parse(row.usage_record_ids_json) as string[],
			errorCode: row.error_code,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			effectiveStrategy: row.effective_strategy ?? undefined,
			selectedQualityTier: row.selected_quality_tier ?? undefined,
			counterfactualTier2CostMicrousd: row.counterfactual_tier2_cost_microusd ?? undefined,
			taskId: row.task_id ?? undefined,
			roleId: row.role_id ?? undefined,
			routeId: row.route_id ?? undefined,
			provider: row.provider ?? undefined,
			modelId: row.model_id ?? undefined,
			physicalAttempts: row.physical_attempts ?? undefined,
			attemptedRoutes: row.attempted_routes_json
				? (JSON.parse(row.attempted_routes_json) as unknown[])
				: [],
		};
	}

	function countModelOperations(
		runId: string,
		{ onlySuccessful = false }: { onlySuccessful?: boolean } = {},
	): number {
		validateRunId(runId);
		const sql = onlySuccessful
			? "SELECT COUNT(*) as count FROM model_operations WHERE run_id = ? AND status = 'succeeded'"
			: "SELECT COUNT(*) as count FROM model_operations WHERE run_id = ? AND status != 'failed'";
		const raw: unknown = ctx.database.prepare(sql).get(runId);
		const row = raw as { count: number } | undefined;
		return row?.count ?? 0;
	}

	function recordDiagnostic({
		diagnosticId = crypto.randomUUID(),
		runId,
		taskId,
		kind,
		payload,
		causalId = null,
		now = new Date(),
	}: DiagnosticInput): DiagnosticRecord {
		ctx.assertOpen();
		validateRunId(runId);
		if (typeof taskId !== 'string' || taskId.length === 0) {
			throw new SdlcError('INVALID_CONTRACT', 'taskId must be non-empty string');
		}
		if (typeof kind !== 'string' || kind.length === 0) {
			throw new SdlcError('INVALID_CONTRACT', 'kind must be non-empty string');
		}
		if (!payload || typeof payload !== 'object') {
			throw new SdlcError('INVALID_CONTRACT', 'payload must be an object');
		}
		const validatedPayload: unknown =
			kind === 'FALSE_ECONOMY_DETECTED' ? validateFalseEconomyDiagnostic(payload) : payload;

		return ctx.transaction(() => {
			const run = ledger.getRun(runId);
			if (!run) {
				throw new SdlcError('RUN_NOT_FOUND', `Run '${runId}' not found`);
			}
			const rawExisting: unknown = ctx.database
				.prepare('SELECT * FROM diagnostics WHERE diagnostic_id = ?')
				.get(diagnosticId);
			const existing = rawExisting as DiagnosticDbRow | undefined;
			if (existing) {
				if (existing.run_id !== runId) {
					throw new SdlcError(
						'STORE_RECONCILIATION_FAILED',
						'Diagnostic ID collision with different run ID',
					);
				}
				if (existing.task_id !== taskId) {
					throw new SdlcError(
						'STORE_RECONCILIATION_FAILED',
						'Diagnostic ID collision with different task ID',
					);
				}
				if (existing.kind !== kind) {
					throw new SdlcError(
						'STORE_RECONCILIATION_FAILED',
						'Diagnostic ID collision with different kind',
					);
				}
				if (existing.payload_json !== canonicalJson(validatedPayload)) {
					throw new SdlcError(
						'STORE_RECONCILIATION_FAILED',
						'Diagnostic ID collision with different payload',
					);
				}

				const targetCausalId = causalId ?? diagnosticId;
				const targetEventType = 'FALSE_ECONOMY_DETECTED';
				const events = ledger.listEvents(runId);
				const matchingEvent = events.find(
					(e) => e.causalId === targetCausalId && e.eventType === targetEventType,
				);
				if (!matchingEvent) {
					throw new SdlcError(
						'STORE_RECONCILIATION_FAILED',
						'Diagnostic exists but associated event is missing',
					);
				}
				if (canonicalJson(matchingEvent.payload) !== canonicalJson(validatedPayload)) {
					throw new SdlcError(
						'STORE_RECONCILIATION_FAILED',
						'Diagnostic event payload diverged from diagnostic record',
					);
				}

				return {
					diagnosticId: existing.diagnostic_id,
					runId: existing.run_id,
					taskId: existing.task_id,
					kind: existing.kind,
					payload: JSON.parse(existing.payload_json),
					createdAt: existing.created_at,
				};
			}

			const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
			ctx.database
				.prepare(
					`
					INSERT INTO diagnostics (
						diagnostic_id, run_id, task_id, kind, payload_json, created_at
					) VALUES (?, ?, ?, ?, ?, ?)
				`,
				)
				.run(diagnosticId, runId, taskId, kind, canonicalJson(validatedPayload), timestamp);

			const event = createEvent({
				eventType: 'FALSE_ECONOMY_DETECTED',
				runId,
				runtimeRevision: run.runtimeRevision,
				state: null,
				causalId: causalId ?? diagnosticId,
				payload: validatedPayload as Record<string, unknown>,
				now,
			});
			ledger.insertEvent(event);

			return {
				diagnosticId,
				runId,
				taskId,
				kind,
				payload: validatedPayload,
				createdAt: timestamp,
			};
		});
	}

	function listDiagnostics(runId: string, kind: string | null = null): DiagnosticRecord[] {
		ctx.assertOpen();
		validateRunId(runId);
		const rawRows: unknown = kind
			? ctx.database
					.prepare(
						'SELECT * FROM diagnostics WHERE run_id = ? AND kind = ? ORDER BY created_at ASC',
					)
					.all(runId, kind)
			: ctx.database
					.prepare('SELECT * FROM diagnostics WHERE run_id = ? ORDER BY created_at ASC')
					.all(runId);
		const rows = rawRows as DiagnosticDbRow[];
		return rows.map((row) => ({
			diagnosticId: row.diagnostic_id,
			runId: row.run_id,
			taskId: row.task_id,
			kind: row.kind,
			payload: JSON.parse(row.payload_json),
			createdAt: row.created_at,
		}));
	}

	return {
		recordModelOperation,
		getModelOperation,
		countModelOperations,
		recordDiagnostic,
		listDiagnostics,
	};
}
