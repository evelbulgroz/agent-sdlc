import { QualityAnswerSchema } from '../policy/contracts/quality-schema.ts';
import { SdlcError } from '../policy/errors.ts';
import { validateQualityAnswerClaims } from '../policy/quality-answer-validation.ts';

export function validateQualityResponse(
	response: unknown,
	interrupt: { interruptId: string },
	bindingHash: string | null | undefined,
	request: Record<string, unknown>,
	artifacts?: { readJson(hash: string): Record<string, unknown>; read?(hash: string): string },
) {
	const answer = QualityAnswerSchema.parse(response);
	if (answer.interruptId !== interrupt.interruptId || !bindingHash ||
		answer.bindingHash !== bindingHash || request.bindingHash !== bindingHash) {
		throw new SdlcError('STALE_RESPONSE', 'Quality answer does not match the current candidate');
	}
	if (!Array.isArray(request.allowedActions) || !request.allowedActions.includes(answer.action)) {
		throw new SdlcError('POLICY_VIOLATION', 'Quality action is not permitted for this blocker');
	}
	validateQualityAnswerClaims(answer, request, artifacts);
	return Object.freeze({ response: answer, revisedDraft: null });
}
