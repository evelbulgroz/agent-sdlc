// Reliability facade. Submodules own the behavior; this module re-exports it and records verification attempts.

import { sha256, validateVerificationAttempt } from './contracts.ts';

export {
	RELIABILITY_CORPUS_VERSION,
	replayReliabilityCorpus,
	validateReliabilityCorpusCase,
} from './reliability/corpus.ts';
export { classifyReliabilityFailure } from './reliability/failure-classification.ts';
export {
	CANARY_LIMITS,
	currentCanaryBindings,
	evaluateCanaryEligibility,
	evaluateCanaryFreshness,
	evaluateCanaryQualificationEvidence,
	evaluateCurrentCanaryGate,
	isDocumentationOnlyGitRange,
	qualifyCanaryRun,
	readCanaryQualification,
	resolveGitHead,
} from './reliability/canary.ts';
export { buildReliabilityReport, compareReliabilityRoutes } from './reliability/report.ts';
export {
	readArtifactJson,
	readTerminalQaDivergences,
	validateSanitizedRunSummary,
} from './reliability/run-evidence.ts';

export interface VerificationDiagnosticStore {
	listDiagnostics(
		runId: string,
		kind: string,
	): ReadonlyArray<{ diagnosticId: string; [key: string]: unknown }>;
	recordDiagnostic(input: {
		diagnosticId: string;
		runId: string;
		taskId: string;
		kind: string;
		payload: unknown;
		now: Date;
	}): unknown;
}

export function recordVerificationAttempt(
	runtimeStore: VerificationDiagnosticStore,
	input: unknown,
): unknown {
	const attempt = validateVerificationAttempt(input);
	const diagnosticId = `verification-${sha256(attempt.attemptId).slice(0, 32)}`;
	const existing = runtimeStore
		.listDiagnostics(attempt.runId, 'reliability.verification-attempt')
		.find((diagnostic) => diagnostic.diagnosticId === diagnosticId);
	if (existing) return existing;
	return runtimeStore.recordDiagnostic({
		diagnosticId,
		runId: attempt.runId,
		taskId: attempt.taskId,
		kind: 'reliability.verification-attempt',
		payload: attempt,
		now: new Date(attempt.occurredAt),
	});
}
