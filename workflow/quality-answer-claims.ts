import { z } from 'zod';
import { ClaimEvidence } from '../policy/quality-answer-validation.ts';
import { SdlcError } from '../policy/errors.ts';
import type { WorkflowArtifactStorePort } from './node-helpers.ts';

const InlineClaim = z.strictObject({
	findingId: ClaimEvidence.shape.findingId,
	rationale: ClaimEvidence.shape.rationale,
	evidenceHashes: ClaimEvidence.shape.evidenceHashes,
});

// The only guarded writer for claim-evidence artifacts: claims arrive inline in a refute answer, are
// bound to that answer's bindingHash, and the evidence they cite is verified later by answer preflight.
export function materializeInlineClaims(
	response: Record<string, unknown>,
	artifacts: Pick<WorkflowArtifactStorePort, 'writeJson'>,
): Record<string, unknown> {
	const { claims, ...answer } = response;
	if (claims === undefined) return answer;
	if (answer.action !== 'refute' || typeof answer.bindingHash !== 'string') {
		throw new SdlcError('INVALID_INPUT', 'Inline claims are only valid on a refute answer with a bindingHash');
	}
	const parsed = z.array(InlineClaim).min(1).safeParse(claims);
	if (!parsed.success) throw new SdlcError('INVALID_INPUT', 'Inline claims are malformed');
	const hashes = parsed.data.map((claim) => artifacts.writeJson('quality-claim-evidence', ClaimEvidence.parse({
		schemaVersion: '1.0.0', bindingHash: answer.bindingHash, ...claim,
	})));
	const existing = Array.isArray(answer.evidenceHashes) ? answer.evidenceHashes : [];
	return { ...answer, evidenceHashes: [...existing, ...hashes] };
}
