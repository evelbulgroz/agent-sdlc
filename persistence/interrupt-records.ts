import { validateRunId } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import type { StoreContext } from './run-ledger.ts';

interface InterruptRow {
	interrupt_id: string;
	run_id: string;
	kind: string;
	state_hash: string;
	request_artifact: string;
	status: string;
	response_artifact: string | null;
	created_at: string;
	response_recorded_at: string | null;
	resolved_at: string | null;
}

export interface InterruptInput {
	interruptId: string;
	runId: string;
	kind: string;
	stateHash: string;
	requestArtifact: string;
	createdAt: string;
}

export interface InterruptRecord extends InterruptInput {
	status: string;
	responseArtifact: string | null;
	responseRecordedAt: string | null;
	resolvedAt: string | null;
}

export interface ContinuationAttemptRecord {
	attempts: number;
	policyFingerprint: string | null;
	updatedAt: string | null;
}

export interface InterruptRecords {
	createInterrupt(input: InterruptInput): InterruptRecord;
	insertInterrupt(input: InterruptInput): InterruptRecord;
	getInterrupt(interruptId: string): InterruptRecord | null;
	getPendingInterrupt(runId: string): InterruptRecord | null;
	recordInterruptResponse(
		interruptId: string,
		responseArtifact: string,
		now?: Date,
	): InterruptRecord | null;
	resolveInterrupt(interruptId: string, now?: Date): InterruptRecord | null;
	cancelInterrupt(interruptId: string, now?: Date): InterruptRecord | null;
	recordContinuationAttempt(
		runId: string,
		blockedReason: string,
		options?: { policyFingerprint?: string | null; reset?: boolean },
	): void;
	getContinuationAttempt(runId: string, blockedReason: string): ContinuationAttemptRecord;
	getContinuationAttempts(runId: string, blockedReason: string): number;
	deleteContinuationAttempt(runId: string, blockedReason: string): void;
	clearContinuationAttempts(runId: string): void;
	resolveRecordedForTransition(interruptId: string, resolvedAt: string): void;
	cancelOpenForTransition(interruptId: string, resolvedAt: string): void;
}

export function createInterruptRecords(ctx: StoreContext): InterruptRecords {
	function createInterrupt({
		interruptId,
		runId,
		kind,
		stateHash,
		requestArtifact,
		createdAt,
	}: InterruptInput): InterruptRecord {
		return ctx.transaction(() =>
			insertInterrupt({
				interruptId,
				runId,
				kind,
				stateHash,
				requestArtifact,
				createdAt,
			}),
		);
	}

	function insertInterrupt({
		interruptId,
		runId,
		kind,
		stateHash,
		requestArtifact,
		createdAt,
	}: InterruptInput): InterruptRecord {
		return ctx.transaction(() => {
			const existing = getInterrupt(interruptId);
			const candidate: InterruptRecord = {
				interruptId,
				runId,
				kind,
				stateHash,
				requestArtifact,
				status: 'PENDING',
				responseArtifact: null,
				createdAt,
				responseRecordedAt: null,
				resolvedAt: null,
			};
			if (existing) {
				if (
					existing.runId !== runId ||
					existing.stateHash !== stateHash ||
					existing.requestArtifact !== requestArtifact
				) {
					throw new SdlcError('STORE_RECONCILIATION_FAILED', 'Interrupt ID collision detected');
				}
				return existing;
			}
			ctx.database
				.prepare(
					`
					INSERT INTO interrupts (
						interrupt_id, run_id, kind, state_hash, request_artifact, status, created_at
					) VALUES (?, ?, ?, ?, ?, 'PENDING', ?)
				`,
				)
				.run(interruptId, runId, kind, stateHash, requestArtifact, createdAt);
			return candidate;
		});
	}

	function getInterrupt(interruptId: string): InterruptRecord | null {
		const raw: unknown = ctx.database
			.prepare('SELECT * FROM interrupts WHERE interrupt_id = ?')
			.get(interruptId);
		const row = raw as InterruptRow | undefined;
		if (!row) return null;
		return {
			interruptId: row.interrupt_id,
			runId: row.run_id,
			kind: row.kind,
			stateHash: row.state_hash,
			requestArtifact: row.request_artifact,
			status: row.status,
			responseArtifact: row.response_artifact,
			createdAt: row.created_at,
			responseRecordedAt: row.response_recorded_at,
			resolvedAt: row.resolved_at,
		};
	}

	function getPendingInterrupt(runId: string): InterruptRecord | null {
		const raw: unknown = ctx.database
			.prepare(
				`
				SELECT interrupt_id FROM interrupts
				WHERE run_id = ? AND status IN ('PENDING', 'RESPONSE_RECORDED')
				ORDER BY created_at DESC LIMIT 1
			`,
			)
			.get(runId);
		const row = raw as { interrupt_id: string } | undefined;
		return row ? getInterrupt(row.interrupt_id) : null;
	}

	function recordInterruptResponse(
		interruptId: string,
		responseArtifact: string,
		now = new Date(),
	): InterruptRecord | null {
		return ctx.transaction(() => {
			const interrupt = getInterrupt(interruptId);
			if (!interrupt) throw new SdlcError('STALE_RESPONSE', 'Interrupt was not found');
			if (interrupt.status === 'RESOLVED') {
				throw new SdlcError('INTERRUPT_RESOLVED', 'Interrupt has already been resolved');
			}
			if (interrupt.status === 'RESPONSE_RECORDED') {
				if (interrupt.responseArtifact !== responseArtifact) {
					throw new SdlcError('STALE_RESPONSE', 'A different response is already recorded');
				}
				return interrupt;
			}
			ctx.database
				.prepare(
					`
					UPDATE interrupts SET
						status = 'RESPONSE_RECORDED', response_artifact = ?, response_recorded_at = ?
					WHERE interrupt_id = ? AND status = 'PENDING'
				`,
				)
				.run(responseArtifact, now.toISOString(), interruptId);
			return getInterrupt(interruptId);
		});
	}

	function resolveInterrupt(interruptId: string, now = new Date()): InterruptRecord | null {
		return ctx.transaction(() => {
			const result = ctx.database
				.prepare(
					`
					UPDATE interrupts SET status = 'RESOLVED', resolved_at = ?
					WHERE interrupt_id = ? AND status = 'RESPONSE_RECORDED'
				`,
				)
				.run(now.toISOString(), interruptId);
			if (result.changes !== 1) {
				const current = getInterrupt(interruptId);
				if (current?.status === 'RESOLVED') return current;
				throw new SdlcError('STALE_RESPONSE', 'Interrupt response was not durably recorded');
			}
			return getInterrupt(interruptId);
		});
	}

	function cancelInterrupt(interruptId: string, now = new Date()): InterruptRecord | null {
		return ctx.transaction(() => {
			const result = ctx.database
				.prepare(
					`
					UPDATE interrupts SET status = 'RESOLVED', resolved_at = ?
					WHERE interrupt_id = ? AND status IN ('PENDING', 'RESPONSE_RECORDED')
				`,
				)
				.run(now.toISOString(), interruptId);
			if (result.changes === 0) {
				const current = getInterrupt(interruptId);
				if (current?.status !== 'RESOLVED') {
					throw new SdlcError('STALE_RESPONSE', 'Pending interrupt was not found');
				}
			}
			return getInterrupt(interruptId);
		});
	}

	function recordContinuationAttempt(
		runId: string,
		blockedReason: string,
		{
			policyFingerprint = null,
			reset = false,
		}: { policyFingerprint?: string | null; reset?: boolean } = {},
	): void {
		ctx.transaction(() => {
			validateRunId(runId);
			ctx.assertOpen();
			const now = new Date().toISOString();
			ctx.database
				.prepare(
					reset
						? `
					INSERT INTO continuation_attempts (
						run_id, blocked_reason, attempts, policy_fingerprint, updated_at
					)
					VALUES (?, ?, 1, ?, ?)
					ON CONFLICT(run_id, blocked_reason) DO UPDATE SET
						attempts = 1,
						policy_fingerprint = excluded.policy_fingerprint,
						updated_at = excluded.updated_at
				`
						: `
					INSERT INTO continuation_attempts (
						run_id, blocked_reason, attempts, policy_fingerprint, updated_at
					)
					VALUES (?, ?, 1, ?, ?)
					ON CONFLICT(run_id, blocked_reason) DO UPDATE SET
						attempts = attempts + 1,
						policy_fingerprint = COALESCE(excluded.policy_fingerprint, continuation_attempts.policy_fingerprint),
						updated_at = excluded.updated_at
				`,
				)
				.run(runId, blockedReason, policyFingerprint, now);
		});
	}

	function getContinuationAttempt(runId: string, blockedReason: string): ContinuationAttemptRecord {
		validateRunId(runId);
		ctx.assertOpen();
		const raw: unknown = ctx.database
			.prepare(
				`SELECT attempts, policy_fingerprint, updated_at
				 FROM continuation_attempts
				 WHERE run_id = ? AND blocked_reason = ?`,
			)
			.get(runId, blockedReason);
		const row = raw as
			| { attempts: number; policy_fingerprint: string | null; updated_at: string | null }
			| undefined;
		if (!row) return { attempts: 0, policyFingerprint: null, updatedAt: null };
		return {
			attempts: row.attempts,
			policyFingerprint: row.policy_fingerprint ?? null,
			updatedAt: row.updated_at ?? null,
		};
	}

	function getContinuationAttempts(runId: string, blockedReason: string): number {
		return getContinuationAttempt(runId, blockedReason).attempts;
	}

	function deleteContinuationAttempt(runId: string, blockedReason: string): void {
		ctx.transaction(() => {
			validateRunId(runId);
			ctx.assertOpen();
			ctx.database
				.prepare('DELETE FROM continuation_attempts WHERE run_id = ? AND blocked_reason = ?')
				.run(runId, blockedReason);
		});
	}

	function clearContinuationAttempts(runId: string): void {
		ctx.transaction(() => {
			validateRunId(runId);
			ctx.assertOpen();
			ctx.database.prepare('DELETE FROM continuation_attempts WHERE run_id = ?').run(runId);
		});
	}

	function resolveRecordedForTransition(interruptId: string, resolvedAt: string): void {
		ctx.transaction(() => {
			const result = ctx.database
				.prepare(
					`
						UPDATE interrupts SET status = 'RESOLVED', resolved_at = ?
						WHERE interrupt_id = ? AND status = 'RESPONSE_RECORDED'
					`,
				)
				.run(resolvedAt, interruptId);
			if (result.changes !== 1) {
				const interrupt = getInterrupt(interruptId);
				if (interrupt?.status !== 'RESOLVED') {
					throw new SdlcError('STALE_RESPONSE', 'Interrupt response was not durably recorded');
				}
			}
		});
	}

	function cancelOpenForTransition(interruptId: string, resolvedAt: string): void {
		ctx.transaction(() => {
			const result = ctx.database
				.prepare(
					`
						UPDATE interrupts SET status = 'RESOLVED', resolved_at = ?
						WHERE interrupt_id = ? AND status IN ('PENDING', 'RESPONSE_RECORDED')
					`,
				)
				.run(resolvedAt, interruptId);
			if (result.changes !== 1) {
				const interrupt = getInterrupt(interruptId);
				if (interrupt?.status !== 'RESOLVED') {
					throw new SdlcError('STALE_RESPONSE', 'Pending interrupt was not found');
				}
			}
		});
	}

	return {
		createInterrupt,
		insertInterrupt,
		getInterrupt,
		getPendingInterrupt,
		recordInterruptResponse,
		resolveInterrupt,
		cancelInterrupt,
		recordContinuationAttempt,
		getContinuationAttempt,
		getContinuationAttempts,
		deleteContinuationAttempt,
		clearContinuationAttempts,
		resolveRecordedForTransition,
		cancelOpenForTransition,
	};
}
