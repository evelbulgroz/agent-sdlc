// Copies quality-answer fields onto the shell reply. Slot filling keeps only
// the action, so the operator payload is applied here.

const QUALITY_REPLY_FIELDS = [
	'answerId',
	'interruptId',
	'bindingHash',
	'findingIds',
	'rationale',
	'evidenceHashes',
	'correction',
] as const;

export function mergeQualityReply(
	card: { responseDocument?: unknown } | null | undefined,
	payload: Record<string, unknown>,
	filled: Record<string, unknown>,
): Record<string, unknown> | null {
	const document = card?.responseDocument;
	if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
	const record = document as Record<string, unknown>;
	if (!Object.hasOwn(record, 'bindingHash') || Object.hasOwn(record, 'stateHash')) return null;
	const next: Record<string, unknown> = { ...filled };
	delete next.taskPlanHash;
	for (const field of QUALITY_REPLY_FIELDS) {
		if (Object.hasOwn(payload, field)) next[field] = payload[field];
	}
	return next;
}
