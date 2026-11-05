import { z } from 'zod';
import type { QualityAnswer } from './contracts/quality-schema.ts';
import { SdlcError } from './errors.ts';

export const ClaimEvidence = z.strictObject({
	schemaVersion: z.literal('1.0.0'), bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
	findingId: z.string().min(1), rationale: z.string().trim().min(1),
	evidenceHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1)
		.refine(hashes => new Set(hashes).size === hashes.length, 'evidence hashes must be unique'),
});

export function validateQualityAnswerClaims(
	answer: QualityAnswer, request: Record<string, unknown>,
	artifacts?: { readJson(hash: string): Record<string, unknown>; read?(hash: string): string },
): void {
	const findings = Array.isArray(request.findings) ? request.findings as { findingId: string }[] : [];
	const ids = typeof request.failureId === 'string' ? [request.failureId] : findings.map(f => f.findingId);
	if (answer.findingIds.length !== ids.length || answer.findingIds.some(id => !ids.includes(id))) {
		throw new SdlcError('INVALID_INPUT', 'Answer must address the exact pending findings or failure');
	}
	if (answer.action !== 'refute') return;
	if (request.failureId || request.status !== 'FAIL' || !findings.length) {
		throw new SdlcError('POLICY_VIOLATION', 'Refutation cannot clear deterministic or missing execution evidence');
	}
	if (!artifacts) throw new SdlcError('INVALID_INPUT', 'Refutation requires preserved claim evidence');
	const covered = new Set<string>();
	for (const hash of answer.evidenceHashes) {
		const claim = ClaimEvidence.parse(artifacts.readJson(hash));
		if (claim.bindingHash !== answer.bindingHash || !ids.includes(claim.findingId)) {
			throw new SdlcError('INVALID_INPUT', 'Refutation evidence has a foreign claim or candidate');
		}
		for (const evidenceHash of claim.evidenceHashes) {
			if (artifacts.read) artifacts.read(evidenceHash);
			else artifacts.readJson(evidenceHash);
		}
		covered.add(claim.findingId);
	}
	if (covered.size !== ids.length) {
		throw new SdlcError('INVALID_INPUT', 'Refutation requires evidence addressing every claim');
	}
}
