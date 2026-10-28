import {
	type GenerationRecord,
	RUNTIME_SCHEMA_VERSION,
	type RunAuthorizationRecord,
	type ToolExecutionRecord,
	canonicalJson,
	validateGeneration,
	validateRunAuthorization,
	validateRunId,
	validateToolExecution,
} from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import type { StoreContext } from './run-ledger.ts';

interface RunAuthorizationRow {
	run_id: string;
	approved_spec_hash: string;
	task_manifest_hash: string | null;
	approved_plan_policy_hash: string;
	repository_id: string;
	base_commit_sha: string;
	allowed_packages_json: string;
	allowed_path_prefixes_json: string;
	allowed_operations_json: string;
	max_semantic_repairs: number;
	model_usage_profile: string;
	expires_at: string;
	approved_at: string;
	approval_method: string;
}

interface GenerationRow {
	run_id: string;
	generation: number;
	base_commit_sha: string;
	target_tree_sha: string;
	scope_fingerprints_json: string;
	task_owned_paths_json: string;
	materialized_at: string;
	review_report_hash: string | null;
	finding_count: number | null;
	has_p1: number | null;
	oracle_snapshot_json: string | null;
}

interface ToolExecutionRow {
	execution_id: string;
	run_id: string;
	task_id: string | null;
	role_id: string;
	generation: number;
	step_index: number;
	tool_name: string;
	input_hash: string;
	output_artifact: string | null;
	exit_code: number | null;
	created_at: string;
}

export interface GenerationRecords {
	saveAuthorization(authorizationInput: unknown): Readonly<RunAuthorizationRecord>;
	getAuthorization(runId: string): Readonly<RunAuthorizationRecord> | null;
	hasAuthorization(runId: string): boolean;
	saveGeneration(generationInput: unknown): Readonly<GenerationRecord>;
	recordReviewOutcome(
		runId: string,
		generation: number,
		outcome?: { reportHash?: string | null; findingCount?: number; hasP1?: boolean },
	): { runtimeRevision: number };
	getGeneration(runId: string, generation: number): Readonly<GenerationRecord> | null;
	getLatestGeneration(runId: string): Readonly<GenerationRecord> | null;
	getMaxRecordedGeneration(runId: string): number;
	listGenerations(runId: string): Readonly<GenerationRecord>[];
	recordToolExecution(toolExecutionInput: unknown): Readonly<ToolExecutionRecord>;
	getToolExecution(executionId: string): Readonly<ToolExecutionRecord> | null;
	listToolExecutions(
		runId: string,
		generation?: number | null,
		taskId?: string | null,
	): Readonly<ToolExecutionRecord>[];
}

function mapGenerationRow(row: GenerationRow): Readonly<GenerationRecord> {
	return validateGeneration({
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		runId: row.run_id,
		generation: row.generation,
		baseCommitSha: row.base_commit_sha,
		targetTreeSha: row.target_tree_sha,
		scopeFingerprints: JSON.parse(row.scope_fingerprints_json),
		taskOwnedPaths: JSON.parse(row.task_owned_paths_json),
		materializedAt: row.materialized_at,
		reviewReportHash: row.review_report_hash ?? null,
		findingCount: row.finding_count ?? 0,
		hasP1: Boolean(row.has_p1),
		oracleSnapshot: row.oracle_snapshot_json ? JSON.parse(row.oracle_snapshot_json) : undefined,
	});
}

function mapToolExecutionRow(row: ToolExecutionRow): Readonly<ToolExecutionRecord> {
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
}

export function createGenerationRecords(ctx: StoreContext): GenerationRecords {
	function saveAuthorization(authorizationInput: unknown): Readonly<RunAuthorizationRecord> {
		ctx.assertOpen();
		const auth = validateRunAuthorization(authorizationInput);
		return ctx.transaction(() => {
			ctx.database
				.prepare(
					`
					INSERT INTO run_authorizations (
						run_id, approved_spec_hash, task_manifest_hash, approved_plan_policy_hash, repository_id,
						base_commit_sha, allowed_packages_json, allowed_path_prefixes_json,
						allowed_operations_json, max_semantic_repairs, model_usage_profile,
						expires_at, approved_at, approval_method, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(run_id) DO UPDATE SET
						approved_spec_hash = excluded.approved_spec_hash,
						task_manifest_hash = excluded.task_manifest_hash,
						approved_plan_policy_hash = excluded.approved_plan_policy_hash,
						repository_id = excluded.repository_id,
						base_commit_sha = excluded.base_commit_sha,
						allowed_packages_json = excluded.allowed_packages_json,
						allowed_path_prefixes_json = excluded.allowed_path_prefixes_json,
						allowed_operations_json = excluded.allowed_operations_json,
						max_semantic_repairs = excluded.max_semantic_repairs,
						model_usage_profile = excluded.model_usage_profile,
						expires_at = excluded.expires_at,
						approved_at = excluded.approved_at,
						approval_method = excluded.approval_method,
						created_at = excluded.created_at
				`,
				)
				.run(
					auth.runId,
					auth.approvedSpecHash,
					auth.taskManifestHash ?? null,
					auth.approvedPlanPolicyHash,
					auth.repositoryId,
					auth.baseCommitSha,
					canonicalJson(auth.allowedPackages),
					canonicalJson(auth.allowedPathPrefixes),
					canonicalJson(auth.allowedOperations),
					auth.maxSemanticRepairs,
					auth.modelUsageProfile,
					auth.expiresAt,
					auth.approvedAt,
					auth.approvalMethod,
					new Date().toISOString(),
				);
			return auth;
		});
	}

	function getAuthorization(runId: string): Readonly<RunAuthorizationRecord> | null {
		ctx.assertOpen();
		const raw: unknown = ctx.database
			.prepare('SELECT * FROM run_authorizations WHERE run_id = ?')
			.get(runId);
		const row = raw as RunAuthorizationRow | undefined;
		if (!row) return null;
		return validateRunAuthorization({
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			runId: row.run_id,
			approvedSpecHash: row.approved_spec_hash,
			taskManifestHash: row.task_manifest_hash ?? null,
			approvedPlanPolicyHash: row.approved_plan_policy_hash,
			repositoryId: row.repository_id,
			baseCommitSha: row.base_commit_sha,
			allowedPackages: JSON.parse(row.allowed_packages_json),
			allowedPathPrefixes: JSON.parse(row.allowed_path_prefixes_json),
			allowedOperations: JSON.parse(row.allowed_operations_json),
			maxSemanticRepairs: row.max_semantic_repairs,
			modelUsageProfile: row.model_usage_profile,
			expiresAt: row.expires_at,
			approvedAt: row.approved_at,
			approvalMethod: row.approval_method,
		});
	}

	function hasAuthorization(runId: string): boolean {
		ctx.assertOpen();
		return Boolean(
			ctx.database.prepare('SELECT 1 FROM run_authorizations WHERE run_id = ?').get(runId),
		);
	}

	function saveGeneration(generationInput: unknown): Readonly<GenerationRecord> {
		ctx.assertOpen();
		const gen = validateGeneration(generationInput);
		return ctx.transaction(() => {
			ctx.database
				.prepare(
					`
					INSERT INTO generations (
						run_id, generation, base_commit_sha, target_tree_sha,
						scope_fingerprints_json, task_owned_paths_json, materialized_at,
						review_report_hash, finding_count, has_p1, oracle_snapshot_json
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(run_id, generation) DO UPDATE SET
						base_commit_sha = excluded.base_commit_sha,
						target_tree_sha = excluded.target_tree_sha,
						scope_fingerprints_json = excluded.scope_fingerprints_json,
						task_owned_paths_json = excluded.task_owned_paths_json,
						materialized_at = excluded.materialized_at,
						review_report_hash = excluded.review_report_hash,
						finding_count = excluded.finding_count,
						has_p1 = excluded.has_p1,
						oracle_snapshot_json = excluded.oracle_snapshot_json
				`,
				)
				.run(
					gen.runId,
					gen.generation,
					gen.baseCommitSha,
					gen.targetTreeSha,
					canonicalJson(gen.scopeFingerprints),
					canonicalJson(gen.taskOwnedPaths),
					gen.materializedAt,
					gen.reviewReportHash ?? null,
					gen.findingCount ?? null,
					gen.hasP1 ? 1 : 0,
					gen.oracleSnapshot ? canonicalJson(gen.oracleSnapshot) : null,
				);
			return gen;
		});
	}

	function recordReviewOutcome(
		runId: string,
		generation: number,
		{
			reportHash = null,
			findingCount = 0,
			hasP1 = false,
		}: { reportHash?: string | null; findingCount?: number; hasP1?: boolean } = {},
	): { runtimeRevision: number } {
		ctx.assertOpen();
		validateRunId(runId);
		return ctx.transaction(() => {
			ctx.database
				.prepare(
					`
					UPDATE generations
					SET review_report_hash = ?, finding_count = ?, has_p1 = ?
					WHERE run_id = ? AND generation = ?
				`,
				)
				.run(reportHash ?? null, findingCount, hasP1 ? 1 : 0, runId, generation);

			const rawRow: unknown = ctx.database
				.prepare('SELECT runtime_revision FROM runs WHERE run_id = ?')
				.get(runId);
			const row = rawRow as { runtime_revision: number } | undefined;
			if (!row) throw new SdlcError('RUN_NOT_FOUND', `Run '${runId}' was not found`);

			return { runtimeRevision: row.runtime_revision };
		});
	}

	function getGeneration(runId: string, generation: number): Readonly<GenerationRecord> | null {
		ctx.assertOpen();
		const raw: unknown = ctx.database
			.prepare('SELECT * FROM generations WHERE run_id = ? AND generation = ?')
			.get(runId, generation);
		const row = raw as GenerationRow | undefined;
		if (!row) return null;
		return mapGenerationRow(row);
	}

	function getLatestGeneration(runId: string): Readonly<GenerationRecord> | null {
		ctx.assertOpen();
		const raw: unknown = ctx.database
			.prepare('SELECT * FROM generations WHERE run_id = ? ORDER BY generation DESC LIMIT 1')
			.get(runId);
		const row = raw as GenerationRow | undefined;
		if (!row) return null;
		return mapGenerationRow(row);
	}

	function getMaxRecordedGeneration(runId: string): number {
		ctx.assertOpen();
		const queries = [
			'SELECT MAX(generation) AS max_gen FROM generations WHERE run_id = ?',
			'SELECT MAX(generation) AS max_gen FROM tool_executions WHERE run_id = ?',
			'SELECT MAX(generation) AS max_gen FROM optional_role_executions WHERE run_id = ?',
			'SELECT MAX(generation) AS max_gen FROM critic_reviews WHERE run_id = ?',
			'SELECT MAX(generation) AS max_gen FROM candidate_learnings WHERE run_id = ?',
		];
		let maxGen = -1;
		for (const q of queries) {
			try {
				const rawRow: unknown = ctx.database.prepare(q).get(runId);
				const row = rawRow as { max_gen: number | null } | undefined;
				if (row && typeof row.max_gen === 'number' && Number.isFinite(row.max_gen)) {
					if (row.max_gen > maxGen) {
						maxGen = row.max_gen;
					}
				}
			} catch {
				// Ignore missing optional tables.
			}
		}
		return maxGen;
	}

	function listGenerations(runId: string): Readonly<GenerationRecord>[] {
		ctx.assertOpen();
		const raw: unknown = ctx.database
			.prepare('SELECT * FROM generations WHERE run_id = ? ORDER BY generation ASC')
			.all(runId);
		const rows = raw as GenerationRow[];
		return rows.map(mapGenerationRow);
	}

	function recordToolExecution(toolExecutionInput: unknown): Readonly<ToolExecutionRecord> {
		ctx.assertOpen();
		const exec = validateToolExecution(toolExecutionInput);
		return ctx.transaction(() => {
			ctx.database
				.prepare(
					`
					INSERT INTO tool_executions (
						execution_id, run_id, task_id, role_id, generation, step_index,
						tool_name, input_hash, output_artifact, exit_code, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(execution_id) DO UPDATE SET
						output_artifact = excluded.output_artifact,
						exit_code = excluded.exit_code
				`,
				)
				.run(
					exec.executionId,
					exec.runId,
					exec.taskId ?? 'task-0',
					exec.roleId,
					exec.generation,
					exec.stepIndex,
					exec.toolName,
					exec.inputHash,
					exec.outputArtifact,
					exec.exitCode,
					exec.createdAt,
				);
			return exec;
		});
	}

	function getToolExecution(executionId: string): Readonly<ToolExecutionRecord> | null {
		ctx.assertOpen();
		const raw: unknown = ctx.database
			.prepare('SELECT * FROM tool_executions WHERE execution_id = ?')
			.get(executionId);
		const row = raw as ToolExecutionRow | undefined;
		if (!row) return null;
		return mapToolExecutionRow(row);
	}

	function listToolExecutions(
		runId: string,
		generation: number | null = null,
		taskId: string | null = null,
	): Readonly<ToolExecutionRecord>[] {
		ctx.assertOpen();
		let rawRows: unknown;
		if (generation === null || generation === undefined) {
			if (taskId === null || taskId === undefined) {
				rawRows = ctx.database
					.prepare(
						'SELECT * FROM tool_executions WHERE run_id = ? ORDER BY generation ASC, step_index ASC',
					)
					.all(runId);
			} else {
				rawRows = ctx.database
					.prepare(
						'SELECT * FROM tool_executions WHERE run_id = ? AND task_id = ? ORDER BY generation ASC, step_index ASC',
					)
					.all(runId, taskId);
			}
		} else if (taskId === null || taskId === undefined) {
			rawRows = ctx.database
				.prepare(
					'SELECT * FROM tool_executions WHERE run_id = ? AND generation = ? ORDER BY step_index ASC',
				)
				.all(runId, generation);
		} else {
			rawRows = ctx.database
				.prepare(
					'SELECT * FROM tool_executions WHERE run_id = ? AND generation = ? AND task_id = ? ORDER BY step_index ASC',
				)
				.all(runId, generation, taskId);
		}
		const rows = rawRows as ToolExecutionRow[];
		return rows.map(mapToolExecutionRow);
	}

	return {
		saveAuthorization,
		getAuthorization,
		hasAuthorization,
		saveGeneration,
		recordReviewOutcome,
		getGeneration,
		getLatestGeneration,
		getMaxRecordedGeneration,
		listGenerations,
		recordToolExecution,
		getToolExecution,
		listToolExecutions,
	};
}
