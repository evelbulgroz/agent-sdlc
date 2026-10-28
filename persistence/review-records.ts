import {
	type CriticReviewRecord,
	type OptionalRoleRecord,
	RUNTIME_SCHEMA_VERSION,
	validateCriticReviewRecord,
	validateOptionalRoleRecord,
	validateRunId,
} from '../policy/contracts.ts';
import type { StoreContext } from './run-ledger.ts';

interface CriticReviewDbRow {
	review_id: string;
	run_id: string;
	generation: number;
	phase: string;
	artifact_hash: string;
	attempt_key: string;
	reviewer_vendor: string;
	reviewer_model: string;
	manifest_path: string;
	findings_count: number;
	has_p1: number;
	reviewed_at: string;
	findings_json: string | null;
	report_artifact: string | null;
}

interface OptionalRoleDbRow {
	run_id: string;
	task_id: string | null;
	role_id: string;
	insertion_point: string;
	generation: number;
	status: string;
	summary: string;
	executed_at: string;
	output_artifact: string | null;
	structured_findings_json: string | null;
}

export interface ReviewRecords {
	saveCriticReview(reviewInput: unknown): Readonly<CriticReviewRecord>;
	listCriticReviews(runId: string, generation?: number | null): Readonly<CriticReviewRecord>[];
	saveOptionalRoleExecution(roleInput: unknown): Readonly<OptionalRoleRecord>;
	listOptionalRoleExecutions(
		runId: string,
		generation?: number | null,
		taskId?: string | null,
	): Readonly<OptionalRoleRecord>[];
}

export function createReviewRecords(ctx: StoreContext): ReviewRecords {
	function saveCriticReview(reviewInput: unknown): Readonly<CriticReviewRecord> {
		ctx.assertOpen();
		const review = validateCriticReviewRecord(reviewInput);
		return ctx.transaction(() => {
			ctx.database
				.prepare(
					`
					INSERT INTO critic_reviews (
						review_id, run_id, generation, phase, artifact_hash, attempt_key,
						reviewer_vendor, reviewer_model, manifest_path, findings_count, has_p1, reviewed_at,
						findings_json, report_artifact
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(run_id, phase, artifact_hash) DO UPDATE SET
						review_id = excluded.review_id,
						generation = excluded.generation,
						attempt_key = excluded.attempt_key,
						reviewer_vendor = excluded.reviewer_vendor,
						reviewer_model = excluded.reviewer_model,
						manifest_path = excluded.manifest_path,
						findings_count = excluded.findings_count,
						has_p1 = excluded.has_p1,
						reviewed_at = excluded.reviewed_at,
						findings_json = excluded.findings_json,
						report_artifact = excluded.report_artifact
				`,
				)
				.run(
					review.reviewId,
					review.runId,
					review.generation,
					review.phase,
					review.artifactHash,
					review.attemptKey,
					review.reviewerVendor,
					review.reviewerModel,
					review.manifestPath,
					review.findingsCount,
					review.hasP1 ? 1 : 0,
					review.reviewedAt,
					review.findingsJson ?? null,
					review.reportArtifact ?? null,
				);
			return review;
		});
	}

	function listCriticReviews(
		runId: string,
		generation: number | null = null,
	): Readonly<CriticReviewRecord>[] {
		ctx.assertOpen();
		validateRunId(runId);
		let rawRows: unknown;
		if (generation !== null && generation !== undefined) {
			rawRows = ctx.database
				.prepare(
					'SELECT * FROM critic_reviews WHERE run_id = ? AND generation = ? ORDER BY reviewed_at ASC, rowid ASC',
				)
				.all(runId, generation);
		} else {
			rawRows = ctx.database
				.prepare(
					'SELECT * FROM critic_reviews WHERE run_id = ? ORDER BY generation ASC, reviewed_at ASC, rowid ASC',
				)
				.all(runId);
		}
		const rows = rawRows as CriticReviewDbRow[];
		return rows.map((row) =>
			validateCriticReviewRecord({
				schemaVersion: RUNTIME_SCHEMA_VERSION,
				reviewId: row.review_id,
				runId: row.run_id,
				generation: row.generation,
				phase: row.phase,
				reviewerVendor: row.reviewer_vendor,
				reviewerModel: row.reviewer_model,
				artifactHash: row.artifact_hash,
				attemptKey: row.attempt_key,
				manifestPath: row.manifest_path,
				findingsCount: row.findings_count,
				hasP1: Boolean(row.has_p1),
				reviewedAt: row.reviewed_at,
				...(row.findings_json ? { findingsJson: row.findings_json } : {}),
				...(row.report_artifact ? { reportArtifact: row.report_artifact } : {}),
			}),
		);
	}

	function saveOptionalRoleExecution(roleInput: unknown): Readonly<OptionalRoleRecord> {
		ctx.assertOpen();
		const roleRecord = validateOptionalRoleRecord(roleInput);
		return ctx.transaction(() => {
			ctx.database
				.prepare(
					`
					INSERT INTO optional_role_executions (
						run_id, task_id, role_id, insertion_point, generation, status, summary, executed_at,
						output_artifact, structured_findings_json
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(run_id, task_id, role_id, generation) DO UPDATE SET
						insertion_point = excluded.insertion_point,
						status = excluded.status,
						summary = excluded.summary,
						executed_at = excluded.executed_at,
						output_artifact = excluded.output_artifact,
						structured_findings_json = excluded.structured_findings_json
				`,
				)
				.run(
					roleRecord.runId,
					roleRecord.taskId ?? 'task-0',
					roleRecord.roleId,
					roleRecord.insertionPoint,
					roleRecord.generation,
					roleRecord.status,
					roleRecord.summary,
					roleRecord.executedAt,
					roleRecord.outputArtifact ?? null,
					roleRecord.structuredFindingsJson ?? null,
				);
			return roleRecord;
		});
	}

	function listOptionalRoleExecutions(
		runId: string,
		generation: number | null = null,
		taskId: string | null = null,
	): Readonly<OptionalRoleRecord>[] {
		ctx.assertOpen();
		validateRunId(runId);
		let rawRows: unknown;
		if (generation !== null && generation !== undefined) {
			if (taskId !== null && taskId !== undefined) {
				rawRows = ctx.database
					.prepare(
						'SELECT * FROM optional_role_executions WHERE run_id = ? AND generation = ? AND task_id = ? ORDER BY executed_at ASC, rowid ASC',
					)
					.all(runId, generation, taskId);
			} else {
				rawRows = ctx.database
					.prepare(
						'SELECT * FROM optional_role_executions WHERE run_id = ? AND generation = ? ORDER BY executed_at ASC, rowid ASC',
					)
					.all(runId, generation);
			}
		} else if (taskId !== null && taskId !== undefined) {
			rawRows = ctx.database
				.prepare(
					'SELECT * FROM optional_role_executions WHERE run_id = ? AND task_id = ? ORDER BY generation ASC, executed_at ASC, rowid ASC',
				)
				.all(runId, taskId);
		} else {
			rawRows = ctx.database
				.prepare(
					'SELECT * FROM optional_role_executions WHERE run_id = ? ORDER BY generation ASC, executed_at ASC, rowid ASC',
				)
				.all(runId);
		}
		const rows = rawRows as OptionalRoleDbRow[];
		return rows.map((row) =>
			validateOptionalRoleRecord({
				schemaVersion: RUNTIME_SCHEMA_VERSION,
				runId: row.run_id,
				taskId: row.task_id ?? 'task-0',
				roleId: row.role_id,
				insertionPoint: row.insertion_point,
				generation: row.generation,
				status: row.status,
				summary: row.summary,
				executedAt: row.executed_at,
				...(row.output_artifact ? { outputArtifact: row.output_artifact } : {}),
				...(row.structured_findings_json
					? { structuredFindingsJson: row.structured_findings_json }
					: {}),
			}),
		);
	}

	return {
		saveCriticReview,
		listCriticReviews,
		saveOptionalRoleExecution,
		listOptionalRoleExecutions,
	};
}
