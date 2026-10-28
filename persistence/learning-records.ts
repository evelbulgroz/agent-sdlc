import crypto from 'node:crypto';
import { createEvent, validateRunId } from '../policy/contracts.ts';
import type { RunLedger, StoreContext } from './run-ledger.ts';

interface CandidateLearningDbRow {
	candidate_id: string;
	run_id: string;
	task_id: string;
	generation: number;
	source_phase: string;
	learning_type: string;
	learning_key: string;
	scope: string;
	query: string;
	insight: string;
	confidence: number;
	source: string;
	graduation_target: string | null;
	created_at: string;
}

interface LearningOutboxDbRow {
	outbox_id: string;
	run_id: string;
	runtime_revision: number;
	learning_key: string;
	payload_json: string;
	published_at: string | null;
	created_at: string;
}

export interface CandidateLearningInput {
	candidateId?: string;
	runId: string;
	taskId?: string;
	generation?: number;
	stage?: string;
	sourcePhase?: string;
	sourceRole?: string;
	type: string;
	key: string;
	scope: string;
	query: string;
	insight: string;
	confidence?: number;
	source?: string;
	graduationTarget?: string | null;
	stagedAt?: string;
}

export interface CandidateLearningRecord {
	candidateId: string;
	runId: string;
	taskId: string;
	generation: number;
	stage: string;
	sourcePhase: string;
	sourceRole: string;
	type: string;
	key: string;
	scope: string;
	query: string;
	insight: string;
	confidence: number;
	source: string;
	graduationTarget: string | null;
	stagedAt: string;
	inserted?: boolean;
}

export interface LearningOutboxEntry {
	outboxId: string;
	runId: string;
	runtimeRevision?: number;
	learningKey?: string;
	learningJson: string;
	status: 'pending' | 'published';
	enqueuedAt: string;
	publishedAt?: string | null;
}

export interface LearningRecords {
	recordCandidateLearning(input: CandidateLearningInput): CandidateLearningRecord;
	listCandidateLearnings(runId: string, generation?: number | null): CandidateLearningRecord[];
	enqueueLearningOutbox(params: {
		runId: string;
		learning: string | { key: string; [key: string]: unknown };
		outboxId?: string;
		now?: string;
	}): LearningOutboxEntry;
	listPendingLearningOutbox(runId?: string | null): LearningOutboxEntry[];
	markLearningOutboxPublished(outboxIds: readonly string[], publishedAt?: string): number;
	recordPostMortem(params: {
		runId: string;
		candidateLearning: Omit<CandidateLearningInput, 'runId'>;
		now?: string;
	}): { candidateId: string; outboxId: string | null };
	upsertCandidateLearningRow(input: CandidateLearningInput): CandidateLearningRecord;
	insertLearningOutboxRow(params: {
		outboxId: string;
		runId: string;
		runtimeRevision: number;
		learningKey: string;
		payloadJson: string;
		now: string;
	}): void;
}

function resolveSourcePhase(input: {
	sourcePhase?: string;
	stage?: string;
	sourceRole?: string;
}): string {
	if (input.sourcePhase) return input.sourcePhase;
	if (input.stage?.startsWith('operator.') || input.sourceRole === 'operator') return 'post-mortem';
	if (input.stage?.startsWith('repair.') || input.sourceRole === 'repairer') return 'repair';
	if (input.sourceRole === 'architect' || input.sourceRole === 'hardener') return input.sourceRole;
	if (input.sourceRole === 'critic') return 'critic';
	return 'repair';
}

function sourceRoleForPhase(sourcePhase: string): string {
	if (sourcePhase === 'post-mortem') return 'operator';
	if (sourcePhase === 'repair') return 'repairer';
	return sourcePhase;
}

function stageForSourcePhase(sourcePhase: string): string {
	if (sourcePhase === 'post-mortem') return 'operator.post_mortem';
	if (sourcePhase === 'architect' || sourcePhase === 'hardener') {
		return 'pipeline';
	}
	return sourcePhase;
}

export function createLearningRecords(ctx: StoreContext, ledger: RunLedger): LearningRecords {
	function recordCandidateLearning({
		candidateId = crypto.randomUUID(),
		runId,
		taskId = 'task-0',
		generation = 0,
		stage,
		sourcePhase,
		sourceRole,
		type,
		key,
		scope,
		query,
		insight,
		confidence = 8,
		source,
		graduationTarget = null,
		stagedAt = new Date().toISOString(),
	}: CandidateLearningInput): CandidateLearningRecord {
		ctx.assertOpen();
		validateRunId(runId);
		return ctx.transaction(() => {
			const candidate = upsertCandidateLearningRow({
				candidateId,
				runId,
				taskId,
				generation,
				stage,
				sourcePhase,
				sourceRole,
				type,
				key,
				scope,
				query,
				insight,
				confidence,
				source,
				graduationTarget,
				stagedAt,
			});
			if (candidate.inserted) {
				ledger.insertEvent(
					createEvent({
						eventType: 'CANDIDATE_LEARNING_STAGED',
						runId,
						runtimeRevision: ledger.getRun(runId).runtimeRevision,
						output: candidate,
						causalId: `${runId}:candidate:${taskId}:${generation}:${candidate.sourcePhase}:${key}`,
						payload: {
							candidateId: candidate.candidateId,
							taskId,
							generation,
							sourcePhase: candidate.sourcePhase,
							key,
						},
						now: stagedAt,
					}),
				);
			}
			delete candidate.inserted;
			return candidate;
		});
	}

	function listCandidateLearnings(
		runId: string,
		generation: number | null = null,
	): CandidateLearningRecord[] {
		ctx.assertOpen();
		validateRunId(runId);
		let rawRows: unknown;
		if (generation !== null && generation !== undefined) {
			rawRows = ctx.database
				.prepare(
					'SELECT * FROM candidate_learnings WHERE run_id = ? AND generation = ? ORDER BY created_at ASC, rowid ASC',
				)
				.all(runId, generation);
		} else {
			rawRows = ctx.database
				.prepare(
					'SELECT * FROM candidate_learnings WHERE run_id = ? ORDER BY generation ASC, created_at ASC, rowid ASC',
				)
				.all(runId);
		}
		const rows = rawRows as CandidateLearningDbRow[];
		return rows.map((row) => ({
			candidateId: row.candidate_id,
			runId: row.run_id,
			taskId: row.task_id,
			generation: row.generation,
			stage: stageForSourcePhase(row.source_phase),
			sourcePhase: row.source_phase,
			sourceRole: sourceRoleForPhase(row.source_phase),
			type: row.learning_type,
			key: row.learning_key,
			scope: row.scope,
			query: row.query,
			insight: row.insight,
			confidence: row.confidence,
			source: row.source,
			graduationTarget: row.graduation_target,
			stagedAt: row.created_at,
		}));
	}

	function enqueueLearningOutbox({
		runId,
		learning,
		outboxId = crypto.randomUUID(),
		now = new Date().toISOString(),
	}: {
		runId: string;
		learning: string | { key: string; [key: string]: unknown };
		outboxId?: string;
		now?: string;
	}): LearningOutboxEntry {
		ctx.assertOpen();
		validateRunId(runId);
		const learningJson = typeof learning === 'string' ? learning : JSON.stringify(learning);
		return ctx.transaction(() => {
			const runtimeRevision = ledger.getRun(runId).runtimeRevision;
			const learningKey =
				typeof learning === 'string'
					? String((JSON.parse(learning) as { key?: string }).key ?? '')
					: learning.key;
			insertLearningOutboxRow({
				outboxId,
				runId,
				runtimeRevision,
				learningKey,
				payloadJson: learningJson,
				now,
			});
			return { outboxId, runId, learningJson, status: 'pending', enqueuedAt: now };
		});
	}

	function listPendingLearningOutbox(runId: string | null = null): LearningOutboxEntry[] {
		ctx.assertOpen();
		let rawRows: unknown;
		if (runId) {
			rawRows = ctx.database
				.prepare(
					'SELECT * FROM learning_outbox WHERE published_at IS NULL AND run_id = ? ORDER BY created_at ASC, rowid ASC',
				)
				.all(runId);
		} else {
			rawRows = ctx.database
				.prepare(
					'SELECT * FROM learning_outbox WHERE published_at IS NULL ORDER BY created_at ASC, rowid ASC',
				)
				.all();
		}
		const rows = rawRows as LearningOutboxDbRow[];
		return rows.map((row) => ({
			outboxId: row.outbox_id,
			runId: row.run_id,
			runtimeRevision: row.runtime_revision,
			learningKey: row.learning_key,
			learningJson: row.payload_json,
			status: row.published_at ? 'published' : 'pending',
			enqueuedAt: row.created_at,
			publishedAt: row.published_at,
		}));
	}

	function markLearningOutboxPublished(
		outboxIds: readonly string[],
		publishedAt = new Date().toISOString(),
	): number {
		ctx.assertOpen();
		if (!Array.isArray(outboxIds) || outboxIds.length === 0) return 0;
		return ctx.transaction(() => {
			const stmt = ctx.database.prepare(
				'UPDATE learning_outbox SET published_at = ? WHERE outbox_id = ? AND published_at IS NULL',
			);
			let count = 0;
			for (const id of outboxIds) {
				const res = stmt.run(publishedAt, id);
				count += Number(res.changes);
			}
			return count;
		});
	}

	function recordPostMortem({
		runId,
		candidateLearning,
		now = new Date().toISOString(),
	}: {
		runId: string;
		candidateLearning: Omit<CandidateLearningInput, 'runId'>;
		now?: string;
	}): { candidateId: string; outboxId: string | null } {
		return ctx.transaction(() => {
			const candidate = upsertCandidateLearningRow({
				...candidateLearning,
				runId,
				sourcePhase: 'post-mortem',
				source: 'user-stated',
				stagedAt: candidateLearning.stagedAt || now,
			});
			if (!candidate.inserted) {
				return { candidateId: candidate.candidateId, outboxId: null };
			}
			const outboxId = crypto.randomUUID();
			const learningJson = JSON.stringify({
				type: candidateLearning.type,
				key: candidateLearning.key,
				scope: candidateLearning.scope,
				query: candidateLearning.query,
				insight: candidateLearning.insight,
				confidence: candidateLearning.confidence ?? 9,
				source: candidateLearning.source || 'user-stated',
				ts: candidateLearning.stagedAt || now,
			});
			insertLearningOutboxRow({
				outboxId,
				runId,
				runtimeRevision: ledger.getRun(runId).runtimeRevision,
				learningKey: candidateLearning.key,
				payloadJson: learningJson,
				now,
			});
			return { candidateId: candidate.candidateId, outboxId };
		});
	}

	function upsertCandidateLearningRow(input: CandidateLearningInput): CandidateLearningRecord {
		return ctx.transaction(() => {
			const taskId = input.taskId ?? 'task-0';
			const sourcePhase = resolveSourcePhase(input);
			const source = input.source ?? (sourcePhase === 'post-mortem' ? 'user-stated' : 'observed');
			const createdAt = input.stagedAt ?? new Date().toISOString();
			const existing = ctx.database
				.prepare(
					`SELECT candidate_id FROM candidate_learnings
					 WHERE run_id = ? AND task_id = ? AND generation = ?
					   AND source_phase = ? AND learning_key = ?`,
				)
				.get(input.runId, taskId, input.generation ?? 0, sourcePhase, input.key);
			ctx.database
				.prepare(
					`INSERT INTO candidate_learnings (
						candidate_id, run_id, task_id, generation, source_phase, learning_type,
						learning_key, scope, query, insight, confidence, source,
						graduation_target, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(run_id, task_id, generation, source_phase, learning_key)
					DO UPDATE SET
						learning_type = excluded.learning_type,
						scope = excluded.scope,
						query = excluded.query,
						insight = excluded.insight,
						confidence = excluded.confidence,
						source = excluded.source,
						graduation_target = excluded.graduation_target`,
				)
				.run(
					input.candidateId ?? crypto.randomUUID(),
					input.runId,
					taskId,
					input.generation ?? 0,
					sourcePhase,
					input.type,
					input.key,
					input.scope,
					input.query,
					input.insight,
					input.confidence ?? 8,
					source,
					input.graduationTarget ?? null,
					createdAt,
				);
			const rawRow: unknown = ctx.database
				.prepare(
					`SELECT * FROM candidate_learnings
					 WHERE run_id = ? AND task_id = ? AND generation = ?
					   AND source_phase = ? AND learning_key = ?`,
				)
				.get(input.runId, taskId, input.generation ?? 0, sourcePhase, input.key);
			const row = rawRow as CandidateLearningDbRow;
			return {
				candidateId: row.candidate_id,
				runId: row.run_id,
				taskId: row.task_id,
				generation: row.generation,
				stage: input.stage ?? stageForSourcePhase(row.source_phase),
				sourcePhase: row.source_phase,
				sourceRole: input.sourceRole ?? sourceRoleForPhase(row.source_phase),
				type: row.learning_type,
				key: row.learning_key,
				scope: row.scope,
				query: row.query,
				insight: row.insight,
				confidence: row.confidence,
				source: row.source,
				graduationTarget: row.graduation_target,
				stagedAt: row.created_at,
				inserted: !existing,
			};
		});
	}

	function insertLearningOutboxRow({
		outboxId,
		runId,
		runtimeRevision,
		learningKey,
		payloadJson,
		now,
	}: {
		outboxId: string;
		runId: string;
		runtimeRevision: number;
		learningKey: string;
		payloadJson: string;
		now: string;
	}): void {
		ctx.transaction(() => {
			ctx.database
				.prepare(
					`INSERT INTO learning_outbox (
						outbox_id, run_id, runtime_revision, learning_key, payload_json, created_at
					) VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(outboxId, runId, runtimeRevision, learningKey, payloadJson, now);
		});
	}

	return {
		recordCandidateLearning,
		listCandidateLearnings,
		enqueueLearningOutbox,
		listPendingLearningOutbox,
		markLearningOutboxPublished,
		recordPostMortem,
		upsertCandidateLearningRow,
		insertLearningOutboxRow,
	};
}
