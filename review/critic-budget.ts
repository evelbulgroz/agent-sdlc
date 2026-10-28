// Critic attempt caps and round decisions. Leaf module: it never imports the gate.

import type { CriticReviewRecord } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';

export type CriticPhase = 'spec' | 'plan' | 'code' | 'qa';

export const SPEC_CRITIC_CAP = 2;
export const PLAN_CRITIC_CAP = 2;
export const QA_CRITIC_CAP = 1;
export const CODE_CRITIC_CAP = 1;

const CAPS: Readonly<Record<string, number>> = Object.freeze({
	spec: SPEC_CRITIC_CAP,
	plan: PLAN_CRITIC_CAP,
	qa: QA_CRITIC_CAP,
	code: CODE_CRITIC_CAP,
});

export interface CriticBudgetSnapshot {
	runId: string;
	approvedSpecHash?: string | null;
	approvedPlanPolicyHash?: string | null;
	taskPlanFrozen?: boolean;
	preflightBindingArtifact?: string | null;
}

export interface CriticReviewLike {
	phase: string;
	artifactHash?: string;
	attemptKey?: string;
	generation?: number;
	hasP1?: boolean;
	findingsJson?: string | null;
	[key: string]: unknown;
}

export interface CriticBudgetStoreLike<T extends CriticReviewLike = CriticReviewRecord> {
	listCriticReviews(runId: string): readonly T[];
}

export type NextRoundDecision<T extends CriticReviewLike = CriticReviewRecord> =
	| Readonly<{ action: 'skip'; existing: T }>
	| Readonly<{ action: 'budget_exhausted'; count: number; last: T | undefined }>
	| Readonly<{ action: 'dispatch'; count: number }>;

export function specAttemptKey(specApprovalAttempt: unknown = 0): string {
	return `spec:${Number(specApprovalAttempt) || 0}`;
}

export function planAttemptKey(approvedPlanPolicyHash: string): string {
	return `plan:${approvedPlanPolicyHash}`;
}

export function qaAttemptKey(approvedSpecHash: string): string {
	return `qa:${approvedSpecHash}`;
}

export function assertCriticAllowed({
	phase,
	snapshot,
}: {
	phase: string;
	snapshot: CriticBudgetSnapshot;
}): void {
	if (!['spec', 'plan', 'code', 'qa'].includes(phase)) {
		throw new SdlcError('INVALID_CONTRACT', `Invalid critic review phase: '${phase}'`);
	}
	if (phase === 'spec' && snapshot.approvedSpecHash) {
		throw new SdlcError(
			'POLICY_VIOLATION',
			'Spec critic is forbidden after approvedSpecHash is frozen',
		);
	}
	if (phase === 'plan') {
		if (!snapshot.approvedSpecHash) {
			throw new SdlcError('POLICY_VIOLATION', 'Plan critic requires an approved specification');
		}
		if (!snapshot.approvedPlanPolicyHash) {
			throw new SdlcError('POLICY_VIOLATION', 'Plan critic requires RUN_AUTHORIZED');
		}
		if (snapshot.taskPlanFrozen === true) {
			throw new SdlcError('POLICY_VIOLATION', 'Plan critic is forbidden after taskPlanFrozen');
		}
	}
	if (phase === 'qa') {
		if (!snapshot.approvedSpecHash) {
			throw new SdlcError('POLICY_VIOLATION', 'QA critic requires an approved specification');
		}
		if (!snapshot.preflightBindingArtifact) {
			throw new SdlcError(
				'POLICY_VIOLATION',
				'QA critic requires a bound green preflight',
			);
		}
	}
	if (phase === 'code') {
		if (!snapshot.approvedSpecHash) {
			throw new SdlcError('POLICY_VIOLATION', 'Code critic requires an approved specification');
		}
		if (snapshot.taskPlanFrozen !== true) {
			throw new SdlcError('POLICY_VIOLATION', 'Code critic requires a frozen task plan');
		}
	}
}

export function nextRound<T extends CriticReviewLike = CriticReviewRecord>({
	phase,
	snapshot,
	artifactHash,
	attemptKey,
	runtimeStore,
}: {
	phase: string;
	snapshot: { runId: string };
	artifactHash: unknown;
	attemptKey: unknown;
	runtimeStore: CriticBudgetStoreLike<T>;
}): NextRoundDecision<T> {
	if (typeof artifactHash !== 'string' || !/^[a-f0-9]{64}$/.test(artifactHash)) {
		throw new SdlcError('INVALID_CONTRACT', 'artifactHash must be a 64-character hex digest');
	}
	if (typeof attemptKey !== 'string' || attemptKey.trim().length === 0) {
		throw new SdlcError('INVALID_CONTRACT', 'attemptKey is required');
	}
	const reviews = runtimeStore.listCriticReviews(snapshot.runId);
	const sameArtifact = reviews.find(
		(review) => review.phase === phase && review.artifactHash === artifactHash,
	);
	if (sameArtifact) {
		return Object.freeze({ action: 'skip', existing: sameArtifact });
	}
	const cap = CAPS[phase] ?? 1;
	const attemptCount = reviews.filter(
		(review) => review.phase === phase && review.attemptKey === attemptKey,
	).length;
	if (attemptCount >= cap) {
		const last = [...reviews]
			.reverse()
			.find((review) => review.phase === phase && review.attemptKey === attemptKey);
		return Object.freeze({ action: 'budget_exhausted', count: attemptCount, last });
	}
	// QA is 1 per approvedSpecHash. Legacy reviews may have been stored with
	// adapter-fallback artifactHash/attemptKey, which must still consume the cap
	// so resume does not re-dispatch the same critic operation ID.
	if (phase === 'qa') {
		const existingQa = [...reviews].reverse().find((review) => review.phase === 'qa');
		if (existingQa) {
			return Object.freeze({ action: 'skip', existing: existingQa });
		}
	}
	return Object.freeze({ action: 'dispatch', count: attemptCount });
}

export function findingsFromExistingReview(
	existing: { findingsJson?: string | null } | null | undefined,
): Record<string, unknown>[] {
	if (!existing || typeof existing !== 'object') return [];
	if (typeof existing.findingsJson === 'string' && existing.findingsJson.trim().length > 0) {
		try {
			const parsed: unknown = JSON.parse(existing.findingsJson);
			if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
		} catch {
			return [];
		}
	}
	return [];
}

export function latestPhaseReview<T extends CriticReviewLike = CriticReviewRecord>(
	runtimeStore: CriticBudgetStoreLike<T>,
	runId: string,
	phase: string,
): T | null {
	const reviews = runtimeStore.listCriticReviews(runId).filter((review) => review.phase === phase);
	return reviews.length > 0 ? (reviews[reviews.length - 1] ?? null) : null;
}
