// Reads a run's sqlite evidence and the sanitized summary built from it.
// The database is opened read-only. Stored mutation-attempt diagnostics from old runs stay readable.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
	type MutationAttempt,
	RELIABILITY_SCHEMA_VERSION,
	type ReliabilityFailureCategory,
	type RouteAttribution,
	type VerificationAttempt,
	sha256,
	validateMutationAttempt,
	validateRouteAttribution,
	validateVerificationAttempt,
} from '../contracts.ts';
import { SdlcError } from '../errors.ts';
import { INFRASTRUCTURE_CODES, classifyReliabilityFailure } from './failure-classification.ts';
import {
	assertClosedObject,
	assertSanitizedValue,
	invalidContract,
	redactEvidence,
} from './sanitization.ts';

const SUMMARY_KEYS = Object.freeze([
	'schemaVersion', 'runId', 'evidenceHash', 'runStatus',
	'tasks', 'failures', 'routeOperations',
]);
const TASK_SUMMARY_KEYS = Object.freeze([
	'taskId', 'status', 'dispatched', 'inconclusive', 'targetPackage',
	'complexityBand', 'deliveryLayers', 'highRisk', 'mutationAttempts',
	'verificationAttempts', 'repairInvoked', 'routeSequence', 'modelSequence',
	'failover', 'latencyMs', 'inputTokens', 'outputTokens', 'costMicrousd',
]);

export interface SanitizedTaskSummary {
	taskId: string;
	status: string;
	dispatched: boolean;
	inconclusive: boolean;
	targetPackage: string;
	complexityBand: string;
	deliveryLayers: string[];
	highRisk: boolean;
	mutationAttempts: MutationAttempt[];
	verificationAttempts: VerificationAttempt[];
	repairInvoked: boolean;
	routeSequence: string[];
	modelSequence: string[];
	failover: boolean;
	latencyMs: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	costMicrousd: number | null;
}

export interface SanitizedFailureSummary {
	runId: string;
	taskId: string | null;
	category: ReliabilityFailureCategory;
	occurredAt: string;
	evidence: string;
}

export interface SanitizedRunSummary {
	schemaVersion: string;
	runId: string;
	evidenceHash: string | null;
	runStatus: string;
	tasks: SanitizedTaskSummary[];
	failures: SanitizedFailureSummary[];
	routeOperations: RouteAttribution[];
}

export interface RuntimeEvidence {
	state: {
		runId: string;
		state: string;
		updatedAt: string;
		workflowHash?: string;
		blockedReason?: string | null;
		semanticRepairsCount?: number;
		preflightBindingArtifact?: string | null;
		lastError?: {
			code?: string;
			message?: string;
			metadata?: { taskId?: string | null };
		} | null;
	};
	plan: { planPolicyHash: string; taskManifestHash: string | null };
	slices: Array<{ sliceId: string; kind: string; acceptanceCriteria: string[]; dependsOn?: string[] }>;
	tasks: Array<{
		taskId: string;
		status: string;
		repairCount: number;
		targetPackage: string;
		pathPrefixes: string[];
		authoredPaths?: string[];
		complexityScore?: number;
		deliveryLayers?: string[];
		highRisk?: boolean;
		dependencyMutations?: unknown[];
		generatedOutputs?: string[];
		contractProducer?: boolean;
	}>;
	diagnostics: Array<{ kind: string; payload: unknown }>;
	mutationAttempts: MutationAttempt[];
	verificationAttempts: VerificationAttempt[];
	routeAttributions: RouteAttribution[];
	operations: Array<{
		operationId: string;
		status: string;
		synthetic: boolean;
		taskId: string | null;
		roleId: string | null;
		routeId: string | null;
		provider: string | null;
		modelId: string | null;
		physicalAttempts: number | null;
		attemptedRoutes: Array<{ routeId: string; provider: string; model: string }>;
		createdAt: string;
		updatedAt: string;
	}>;
	implementerOperations: Array<{
		operationId: string;
		status: string;
		synthetic: boolean;
		taskId: string | null;
		roleId: string | null;
	}>;
	reconciliation: { status: string; reconciledTreeSha: string | null } | null;
	authorization: { baseCommitSha: string };
	preflight: { status?: string; canonical?: boolean } | null;
	qaDivergences: Array<{
		groundingVerified?: boolean;
		severity?: string;
		category?: string;
		evidence?: string;
		message?: string;
		ruleId?: string;
		impact?: string;
	}>;
}

export function validateSanitizedRunSummary(input: unknown): Readonly<SanitizedRunSummary> {
	assertClosedObject(input, SUMMARY_KEYS, 'sanitized run summary');
	if (input.schemaVersion !== RELIABILITY_SCHEMA_VERSION) {
		throw invalidContract('Unsupported sanitized summary schemaVersion');
	}
	if (typeof input.runId !== 'string' || input.runId.length === 0) {
		throw invalidContract('Sanitized summary runId is required');
	}
	if (!Array.isArray(input.tasks) || !Array.isArray(input.failures) || !Array.isArray(input.routeOperations)) {
		throw invalidContract('Sanitized summary arrays are required');
	}
	for (const task of input.tasks) {
		assertClosedObject(task, TASK_SUMMARY_KEYS, 'sanitized task summary');
		if (!Array.isArray(task.mutationAttempts) || !Array.isArray(task.verificationAttempts)) {
			throw invalidContract('Sanitized task attempt arrays are required');
		}
		task.mutationAttempts.forEach(validateMutationAttempt);
		task.verificationAttempts.forEach(validateVerificationAttempt);
	}
	assertSanitizedValue(input);
	const canonical = { ...input, evidenceHash: null };
	if (input.evidenceHash !== sha256(canonical)) {
		throw invalidContract('Sanitized summary evidenceHash is invalid');
	}
	const summary: unknown = structuredClone(input);
	return Object.freeze(summary as SanitizedRunSummary);
}

export function readRuntimeEvidence(databasePath: string): RuntimeEvidence {
	let database: DatabaseSync | undefined;
	try {
		database = new DatabaseSync(databasePath, { readOnly: true });
		const migration = database
			.prepare('SELECT max(version) AS version FROM schema_migrations')
			.get() as { version?: number | null } | undefined;
		if ((migration?.version ?? 0) > 13) {
			throw new SdlcError(
				'STORE_VERSION_UNSUPPORTED',
				`Runtime store schema ${migration?.version} is newer than supported 13`,
			);
		}
		const runRow = database
			.prepare('SELECT state_json FROM runs LIMIT 1')
			.get() as { state_json: string } | undefined;
		if (!runRow) throw invalidContract('Runtime store contains no run');
		const state = JSON.parse(runRow.state_json) as RuntimeEvidence['state'];
		const runId = state.runId;
		const planRow = database
			.prepare('SELECT * FROM task_plans WHERE run_id = ?')
			.get(runId) as { plan_policy_hash: string; task_manifest_hash: string | null; slices_json?: string | null } | undefined;
		if (!planRow) throw invalidContract(`Runtime store ${runId} has no frozen task plan`);
		const taskRows = database
			.prepare('SELECT * FROM dag_tasks WHERE run_id = ? ORDER BY integration_order, task_id')
			.all(runId) as Array<{
			task_id: string;
			status: string;
			repair_count?: number | null;
			target_package: string;
			path_prefixes_json: string;
			manifest_metadata_json?: string | null;
		}>;
		const tasks = taskRows.map((row) => ({
			taskId: row.task_id,
			status: row.status,
			repairCount: row.repair_count ?? 0,
			targetPackage: row.target_package,
			pathPrefixes: JSON.parse(row.path_prefixes_json) as string[],
			...safeJsonObject(row.manifest_metadata_json),
		}));
		const diagnostics = (
			database
				.prepare('SELECT kind, payload_json FROM diagnostics WHERE run_id = ? ORDER BY created_at, diagnostic_id')
				.all(runId) as Array<{ kind: string; payload_json: string }>
		).map((row) => ({ kind: row.kind, payload: JSON.parse(row.payload_json) as unknown }));
		const operationColumns = new Set(
			(database.prepare('PRAGMA table_info(model_operations)').all() as Array<{ name: string }>).map((row) => row.name),
		);
		const operations = (
			database
				.prepare('SELECT * FROM model_operations WHERE run_id = ? ORDER BY created_at, operation_id')
				.all(runId) as Array<Record<string, unknown>>
		).map((row) => ({
			operationId: String(row.operation_id),
			status: String(row.status),
			synthetic: row.synthetic === 1,
			taskId: operationColumns.has('task_id') && row.task_id ? String(row.task_id) : null,
			roleId: operationColumns.has('role_id') && row.role_id ? String(row.role_id) : null,
			routeId: operationColumns.has('route_id') && row.route_id ? String(row.route_id) : null,
			provider: operationColumns.has('provider') && row.provider ? String(row.provider) : null,
			modelId: operationColumns.has('model_id') && row.model_id ? String(row.model_id) : null,
			physicalAttempts:
				operationColumns.has('physical_attempts') && typeof row.physical_attempts === 'number'
					? row.physical_attempts
					: null,
			attemptedRoutes:
				operationColumns.has('attempted_routes_json') && typeof row.attempted_routes_json === 'string'
					? (JSON.parse(row.attempted_routes_json) as Array<{ routeId: string; provider: string; model: string }>)
					: [],
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
		}));
		const reconciliationRow = database
			.prepare('SELECT * FROM reconciliations WHERE run_id = ? ORDER BY reconciled_at DESC LIMIT 1')
			.get(runId) as { status: string; reconciled_tree_sha: string | null } | undefined;
		const qaDivergences = readTerminalQaDivergences(database, runId);
		const authorizationRow = database
			.prepare('SELECT * FROM run_authorizations WHERE run_id = ?')
			.get(runId) as { base_commit_sha: string } | undefined;
		if (!authorizationRow) throw invalidContract(`Runtime store ${runId} has no authorization`);
		const preflight = readArtifactJson(database, databasePath, state.preflightBindingArtifact) as RuntimeEvidence['preflight'];
		const persistedRouteAttributions = diagnostics
			.filter((entry) => entry.kind === 'reliability.route-attribution')
			.map((entry) => validateRouteAttribution(entry.payload));
		const derivedRouteAttributions: RouteAttribution[] = [];
		const routeSequenceByTask = new Map<string, number>();
		for (const operation of operations) {
			if (
				operation.status !== 'succeeded' ||
				!operation.taskId || !operation.roleId || !operation.routeId || !operation.provider || !operation.modelId
			) {
				continue;
			}
			const attemptedRoutes =
				operation.attemptedRoutes.length > 0
					? operation.attemptedRoutes
					: [{ routeId: operation.routeId, provider: operation.provider, model: operation.modelId }];
			for (const attemptedRoute of attemptedRoutes) {
				const sequence = (routeSequenceByTask.get(operation.taskId) ?? 0) + 1;
				routeSequenceByTask.set(operation.taskId, sequence);
				derivedRouteAttributions.push(
					validateRouteAttribution({
						schemaVersion: RELIABILITY_SCHEMA_VERSION,
						operationId: operation.operationId,
						runId,
						taskId: operation.taskId,
						roleId: operation.roleId,
						routeId: attemptedRoute.routeId,
						modelId: attemptedRoute.model,
						provider: attemptedRoute.provider,
						sequence,
						failover: attemptedRoutes.length > 1,
						latencyMs: null,
						inputTokens: null,
						outputTokens: null,
						costMicrousd: null,
						occurredAt: operation.updatedAt,
					}),
				);
			}
		}
		return {
			state,
			plan: { planPolicyHash: planRow.plan_policy_hash, taskManifestHash: planRow.task_manifest_hash },
			slices: planRow.slices_json ? (JSON.parse(planRow.slices_json) as RuntimeEvidence['slices']) : [],
			tasks,
			diagnostics,
			mutationAttempts: diagnostics
				.filter((entry) => entry.kind === 'reliability.mutation-attempt')
				.map((entry) => validateMutationAttempt(entry.payload)),
			verificationAttempts: diagnostics
				.filter((entry) => entry.kind === 'reliability.verification-attempt')
				.map((entry) => validateVerificationAttempt(entry.payload)),
			routeAttributions: persistedRouteAttributions.length > 0 ? persistedRouteAttributions : derivedRouteAttributions,
			operations,
			implementerOperations: operations.filter((operation) => operation.roleId === 'implementer'),
			reconciliation: reconciliationRow
				? { status: reconciliationRow.status, reconciledTreeSha: reconciliationRow.reconciled_tree_sha }
				: null,
			authorization: { baseCommitSha: authorizationRow.base_commit_sha },
			preflight,
			qaDivergences,
		};
	} catch (error) {
		if (error instanceof SdlcError) throw error;
		const msg = error instanceof Error ? error.message : '';
		if (/\b(?:locked|busy)\b/i.test(msg)) {
			throw new SdlcError('STORE_BUSY', 'Runtime evidence store is locked', {}, { cause: error });
		}
		if (/malformed|not a database|disk image/i.test(msg)) {
			throw new SdlcError('STORE_CORRUPT', 'Runtime evidence store is corrupt', {}, { cause: error });
		}
		throw invalidContract('Runtime evidence store is unreadable', error);
	} finally {
		database?.close();
	}
}

export function readTerminalQaDivergences(
	database: DatabaseSync,
	runId: string,
): RuntimeEvidence['qaDivergences'] {
	const row = database
		.prepare(
			`SELECT event_json FROM events
			 WHERE run_id = ?
			   AND event_type IN ('RUN_READY_FOR_GIT_APPROVAL', 'RUN_COMPLETED')
			 ORDER BY runtime_revision DESC
			 LIMIT 1`,
		)
		.get(runId) as { event_json: string } | undefined;
	const event = row ? safeJsonObject(row.event_json) : {};
	const payload =
		event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
			? (event.payload as Record<string, unknown>)
			: {};
	return Array.isArray(payload.qaDivergences)
		? (payload.qaDivergences as RuntimeEvidence['qaDivergences'])
		: [];
}

export function summaryFromRuntimeEvidence(evidence: RuntimeEvidence): SanitizedRunSummary {
	const tasks: SanitizedTaskSummary[] = evidence.tasks.map((task) => {
		const mutationAttempts = evidence.mutationAttempts.filter(
			(attempt) => attempt.taskId === task.taskId,
		);
		const verificationAttempts = evidence.verificationAttempts.filter(
			(attempt) => attempt.taskId === task.taskId,
		);
		const operations = evidence.operations.filter(
			(operation) =>
				operation.taskId === task.taskId && operation.roleId === 'implementer',
		);
		const attributions = evidence.routeAttributions
			.filter(
				(attribution) =>
					attribution.taskId === task.taskId &&
					attribution.roleId === 'implementer',
			)
			.sort((left, right) => left.sequence - right.sequence);
		const routes = attributions.map((attribution) => attribution.routeId);
		const models = attributions.map((attribution) => attribution.modelId);
		const lastErrorCode = evidence.state.lastError?.code ?? '';
		return {
			taskId: task.taskId,
			status: task.status,
			dispatched: operations.length > 0 || task.status !== 'pending',
			inconclusive:
				task.status === 'blocked' && INFRASTRUCTURE_CODES.has(lastErrorCode),
			targetPackage: task.targetPackage,
			complexityBand: complexityBand(task.complexityScore),
			deliveryLayers: [...(task.deliveryLayers ?? [])].sort(),
			highRisk: task.highRisk === true,
			mutationAttempts,
			verificationAttempts,
			repairInvoked: task.repairCount > 0,
			routeSequence: routes,
			modelSequence: models,
			failover:
				new Set(routes).size > 1 ||
				attributions.some((attribution) => attribution.failover) ||
				operations.some((operation) => (operation.physicalAttempts ?? 0) > 1),
			latencyMs: null,
			inputTokens: null,
			outputTokens: null,
			costMicrousd: null,
		};
	});
	const failures: SanitizedFailureSummary[] = [];
	if (evidence.state.lastError) {
		failures.push({
			runId: evidence.state.runId,
			taskId: evidence.state.lastError.metadata?.taskId ?? null,
			category: classifyReliabilityFailure(evidence.state.lastError),
			occurredAt: evidence.state.updatedAt,
			evidence: redactEvidence(
				evidence.state.lastError.message ?? evidence.state.lastError.code,
			),
		});
	}
	const summary: SanitizedRunSummary = {
		schemaVersion: RELIABILITY_SCHEMA_VERSION,
		runId: evidence.state.runId,
		evidenceHash: null,
		runStatus: evidence.state.state,
		tasks,
		failures,
		routeOperations: evidence.routeAttributions,
	};
	summary.evidenceHash = sha256(summary);
	return summary;
}

export function readArtifactJson(
	database: DatabaseSync,
	databasePath: string,
	hash: string | null | undefined,
): unknown {
	if (!hash) return null;
	const row = database
		.prepare('SELECT storage_path FROM artifacts WHERE hash = ?')
		.get(hash) as { storage_path: string } | undefined;
	if (!row) return null;
	try {
		const storagePath = path.resolve(path.dirname(databasePath), row.storage_path);
		return JSON.parse(fs.readFileSync(storagePath, 'utf8'));
	} catch {
		return null;
	}
}

function safeJsonObject(value: string | null | undefined): Record<string, unknown> {
	if (!value) return {};
	const parsed = JSON.parse(value) as unknown;
	return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: {};
}

function complexityBand(score: number | undefined): string {
	if (typeof score !== 'number' || !Number.isSafeInteger(score)) return 'unknown';
	if (score <= 5) return 'small';
	if (score <= 10) return 'medium';
	return 'large';
}
