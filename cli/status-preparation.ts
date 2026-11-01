// Projects VERIFICATION_PREPARED events into status.json `verification.preparation`: the bound
// policy/selection hashes and the latest verification (not exploratory) outcome per task and final.

export interface PreparationStatusEntry {
	readonly taskId: string;
	readonly status: string;
	readonly evidenceArtifact: string | null;
	readonly selectionHash: string | null;
	readonly candidateDigest: string | null;
	readonly failure: unknown;
	readonly recordedAt: string | null;
}

export interface PreparationStatus {
	readonly policyHash: string | null;
	readonly selectionHash: string | null;
	readonly latest: readonly PreparationStatusEntry[];
}

interface EventLike {
	readonly eventType: string;
	readonly timestamp?: string;
	readonly payload?: Readonly<Record<string, unknown>> | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Null for runs that neither bind nor record preparation, so their status documents are unchanged. */
export function projectVerificationPreparation(
	events: readonly EventLike[],
	auth: { readonly preparationPolicyHash?: string | null } | null | undefined,
	state: { readonly preparationSelectionHash?: string | null },
): PreparationStatus | null {
	const latest = new Map<string, PreparationStatusEntry>();
	for (const event of events) {
		if (event.eventType !== 'VERIFICATION_PREPARED' || !event.payload) continue;
		if (event.payload.purpose === 'exploratory') continue; // model-command builds are never evidence
		const taskId = text(event.payload.taskId) ?? 'unknown';
		latest.set(taskId, {
			taskId,
			status: text(event.payload.status) ?? 'unknown',
			evidenceArtifact: text(event.payload.evidenceArtifact),
			selectionHash: text(event.payload.selectionHash),
			candidateDigest: text(event.payload.candidateDigest),
			failure: event.payload.failure ?? null,
			recordedAt: text(event.timestamp),
		});
	}
	const policyHash = auth?.preparationPolicyHash ?? null;
	const selectionHash = state.preparationSelectionHash ?? null;
	if (!policyHash && !selectionHash && latest.size === 0) return null;
	return {
		policyHash,
		selectionHash,
		latest: [...latest.values()].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0)),
	};
}
