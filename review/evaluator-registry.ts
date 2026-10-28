import {
	ALLOWED_TOOLS,
	RUNTIME_SCHEMA_VERSION,
	sha256,
	validatePatch,
	validateQuestionBatch,
	validateReviewFindings,
	validatePreflightBinding,
	type DraftPatchOperation,
	type QuestionItem,
	type ReviewFindingItem,
} from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';

export interface EvaluatorOptions {
	maxQuestions?: number;
	allowEmptyQuestions?: boolean;
	runId?: string;
	generation?: number;
}

export interface EvaluatedResult {
	patch: readonly Readonly<DraftPatchOperation>[];
	questions: readonly Readonly<QuestionItem>[];
	action:
		| Readonly<{ kind: 'tool_call'; toolName: string; parameters: Readonly<Record<string, unknown>> }>
		| Readonly<{ kind: 'complete'; summary: string }>
		| Readonly<{ kind: 'escalate'; summary: string; evidence: string }>;
	status: string;
	findings: readonly Readonly<ReviewFindingItem>[];
	hasP1: boolean;
	findingCount: number;
	p1Count: number;
	cleanedFiles: readonly string[];
	hygieneOperations: readonly string[];
	testsAdded: readonly string[];
	shadowPathsCovered: readonly string[];
	violations: readonly Readonly<Record<string, unknown>>[];
	hasViolations: boolean;
	[key: string]: unknown;
}

export interface EvaluatorEntry<TResult = EvaluatedResult> {
	id: string;
	evaluate(value: unknown, options?: EvaluatorOptions): Readonly<TResult>;
}

const TOOL_PARAMETER_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
	read_file: Object.freeze(['path', 'start_line']),
	write_file: Object.freeze(['path', 'content', 'acknowledgedShrink']),
	replace_in_file: Object.freeze(['path', 'old_string', 'new_string', 'expected_file_hash']),
	replace_snapshot_range: Object.freeze([
		'path',
		'expected_file_hash',
		'start_line',
		'end_line',
		'new_string',
		'acknowledgedShrink',
	]),
	delete_file: Object.freeze(['path']),
	list_dir: Object.freeze(['path']),
	find_files: Object.freeze(['path', 'pattern', 'query']),
	run_allowlisted_command: Object.freeze(['command', 'args']),
});

const EVALUATOR_ID = 'specification-proposal-v1';
const IMPLEMENTER_ACTION_ID = 'implementer-action-v1';
const REVIEW_RUBRIC_ID = 'review-rubric-v1';
const PREFLIGHT_EVIDENCE_ID = 'preflight-evidence-v1';
const CLEANER_RESULT_ID = 'cleaner-result-v1';
const HARDENER_ACTION_ID = 'hardener-action-v1';
const ARCHITECT_EVALUATION_ID = 'architect-evaluation-v1';

function asRecord(value: unknown, errorMessage: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new SdlcError('MODEL_OUTPUT_INVALID', errorMessage);
	}
	return value as Record<string, unknown>;
}

function asEvaluatedResult(value: unknown): Readonly<EvaluatedResult> {
	return value as Readonly<EvaluatedResult>;
}

const REGISTRY = new Map<string, Readonly<EvaluatorEntry>>([
	[
		EVALUATOR_ID,
		Object.freeze({
			id: EVALUATOR_ID,
			evaluate(
				value: unknown,
				{ maxQuestions, allowEmptyQuestions = false }: EvaluatorOptions = {},
			) {
				const record = asRecord(value, 'Model proposal must be an object');
				const unknown = Object.keys(record).filter((key) => !['patch', 'questions'].includes(key));
				if (unknown.length > 0) {
					throw new SdlcError(
						'MODEL_OUTPUT_INVALID',
						`Model proposal contains unknown field '${unknown[0]}'`,
					);
				}
				const patch = validatePatch(record.patch);
				const batch = validateQuestionBatch(
					{
						schemaVersion: RUNTIME_SCHEMA_VERSION,
						questions: record.questions,
					},
					{ maxQuestions, allowEmpty: allowEmptyQuestions },
				);
				return asEvaluatedResult(Object.freeze({ patch, questions: batch.questions }));
			},
		}),
	],
	[
		IMPLEMENTER_ACTION_ID,
		Object.freeze({
			id: IMPLEMENTER_ACTION_ID,
			evaluate(value: unknown) {
				const record = asRecord(value, 'Implementer output must be an object');
				const action = asRecord(
					record.action,
					'Implementer output must contain an action object',
				);
				if (action.kind === 'tool_call') {
					if (!action.toolName || typeof action.toolName !== 'string') {
						throw new SdlcError(
							'MODEL_OUTPUT_INVALID',
							'Tool call action must specify a toolName',
						);
					}
					if (!(ALLOWED_TOOLS as readonly string[]).includes(action.toolName)) {
						throw new SdlcError(
							'MODEL_OUTPUT_INVALID',
							`Tool '${action.toolName}' is not an allowlisted tool`,
						);
					}
					if (!action.parameters || typeof action.parameters !== 'object' || Array.isArray(action.parameters)) {
						throw new SdlcError(
							'MODEL_OUTPUT_INVALID',
							'Tool call action must specify a parameters object',
						);
					}
					const parameters = action.parameters as Record<string, unknown>;
					const allowedParameterKeys = TOOL_PARAMETER_ALLOWLIST[action.toolName] ?? [];
					const unknownParameterKey = Object.entries(parameters).find(
						([paramKey, paramValue]) =>
							paramValue !== null &&
							paramValue !== undefined &&
							!allowedParameterKeys.includes(paramKey),
					)?.[0];
					if (unknownParameterKey) {
						throw new SdlcError(
							'MODEL_OUTPUT_INVALID',
							`Tool '${action.toolName}' does not accept parameter '${unknownParameterKey}'`,
						);
					}
					const cleanParameters: Record<string, unknown> = {};
					for (const [paramKey, paramValue] of Object.entries(parameters)) {
						if (paramValue !== null && paramValue !== undefined) {
							cleanParameters[paramKey] = paramValue;
						}
					}
					return asEvaluatedResult(
						Object.freeze({
							action: Object.freeze({
								kind: 'tool_call' as const,
								toolName: action.toolName,
								parameters: Object.freeze(cleanParameters),
							}),
						}),
					);
				}
				if (action.kind === 'complete') {
					if (typeof action.summary !== 'string' || action.summary.trim().length === 0) {
						throw new SdlcError(
							'MODEL_OUTPUT_INVALID',
							'Complete action must specify a non-empty summary string',
						);
					}
					return asEvaluatedResult(
						Object.freeze({
							action: Object.freeze({
								kind: 'complete' as const,
								summary: action.summary.trim(),
							}),
						}),
					);
				}
				if (action.kind === 'escalate') {
					if (
						typeof action.summary !== 'string' ||
						action.summary.trim().length === 0 ||
						typeof action.evidence !== 'string' ||
						action.evidence.trim().length === 0
					) {
						throw new SdlcError(
							'MODEL_OUTPUT_INVALID',
							'Escalate action must specify non-empty summary and evidence strings',
						);
					}
					return asEvaluatedResult(
						Object.freeze({
							action: Object.freeze({
								kind: 'escalate' as const,
								summary: action.summary.trim(),
								evidence: action.evidence.trim(),
							}),
						}),
					);
				}
				throw new SdlcError(
					'MODEL_OUTPUT_INVALID',
					`Unknown action kind: '${String(action.kind)}' (expected 'tool_call', 'complete', or 'escalate')`,
				);
			},
		}),
	],
	[
		REVIEW_RUBRIC_ID,
		Object.freeze({
			id: REVIEW_RUBRIC_ID,
			evaluate(value: unknown, { runId, generation }: EvaluatorOptions = {}) {
				const record = asRecord(value, 'Review output must be an object');
				const findingsPayload = {
					schemaVersion: RUNTIME_SCHEMA_VERSION,
					runId: record.runId || runId,
					generation: record.generation ?? generation ?? 0,
					status:
						Array.isArray(record.findings) &&
						record.findings.some(
							(finding: unknown) =>
								finding &&
								typeof finding === 'object' &&
								'severity' in finding &&
								finding.severity === 'P1',
						)
							? 'FAIL'
							: 'PASS',
					findings: record.findings,
				};
				const validated = validateReviewFindings(findingsPayload);
				const hasP1 = validated.findings.some((f) => f.severity === 'P1');
				return asEvaluatedResult(
					Object.freeze({
						status: validated.status,
						findings: validated.findings,
						hasP1,
						findingCount: validated.findings.length,
						p1Count: validated.findings.filter((f) => f.severity === 'P1').length,
					}),
				);
			},
		}),
	],
	[
		PREFLIGHT_EVIDENCE_ID,
		Object.freeze({
			id: PREFLIGHT_EVIDENCE_ID,
			evaluate(value: unknown) {
				return asEvaluatedResult(validatePreflightBinding(value));
			},
		}),
	],
	[
		CLEANER_RESULT_ID,
		Object.freeze({
			id: CLEANER_RESULT_ID,
			evaluate(value: unknown) {
				const record = asRecord(value, 'Cleaner output must be an object');
				if (typeof record.status !== 'string' || !['PASS', 'CLEANED', 'NOOP'].includes(record.status)) {
					throw new SdlcError(
						'MODEL_OUTPUT_INVALID',
						`Invalid cleaner status '${String(record.status)}'`,
					);
				}
				if (record.functionalDiffsDetected === true) {
					throw new SdlcError(
						'ROLE_EXECUTION_FAILED',
						'Cleaner introduced functional production logic diffs',
					);
				}
				const cleanedFiles = Array.isArray(record.cleanedFiles) ? record.cleanedFiles : [];
				const hygieneOperations = Array.isArray(record.hygieneOperations)
					? record.hygieneOperations
					: [];
				return asEvaluatedResult(
					Object.freeze({
						status: record.status,
						cleanedFiles: Object.freeze([...cleanedFiles]),
						hygieneOperations: Object.freeze([...hygieneOperations]),
					}),
				);
			},
		}),
	],
	[
		HARDENER_ACTION_ID,
		Object.freeze({
			id: HARDENER_ACTION_ID,
			evaluate(value: unknown) {
				const record = asRecord(value, 'Hardener output must be an object');
				if (typeof record.status !== 'string' || !['PASS', 'HARDENED', 'NOOP'].includes(record.status)) {
					throw new SdlcError(
						'MODEL_OUTPUT_INVALID',
						`Invalid hardener status '${String(record.status)}'`,
					);
				}
				const testsAdded = Array.isArray(record.testsAdded) ? record.testsAdded : [];
				const shadowPathsCovered = Array.isArray(record.shadowPathsCovered)
					? record.shadowPathsCovered
					: [];
				return asEvaluatedResult(
					Object.freeze({
						status: record.status,
						testsAdded: Object.freeze([...testsAdded]),
						shadowPathsCovered: Object.freeze([...shadowPathsCovered]),
					}),
				);
			},
		}),
	],
	[
		ARCHITECT_EVALUATION_ID,
		Object.freeze({
			id: ARCHITECT_EVALUATION_ID,
			evaluate(value: unknown) {
				const record = asRecord(value, 'Architect output must be an object');
				if (
					typeof record.status !== 'string' ||
					!['PASS', 'VIOLATIONS_DETECTED'].includes(record.status)
				) {
					throw new SdlcError(
						'MODEL_OUTPUT_INVALID',
						`Invalid architect status '${String(record.status)}'`,
					);
				}
				const violations = Array.isArray(record.violations)
					? (record.violations as Record<string, unknown>[])
					: [];
				const hasP1 = violations.some((v) => v?.severity === 'P1');
				return asEvaluatedResult(
					Object.freeze({
						status: record.status,
						violations: Object.freeze(violations.map((v) => Object.freeze({ ...v }))),
						hasViolations: violations.length > 0,
						hasP1,
					}),
				);
			},
		}),
	],
]);

export function hasEvaluator(id: string): boolean {
	return REGISTRY.has(id);
}

export function getEvaluator(id: string): Readonly<EvaluatorEntry> {
	const evaluator = REGISTRY.get(id);
	if (!evaluator) throw new SdlcError('INVALID_CONTRACT', `Unknown evaluator '${id}'`);
	return evaluator;
}

export function evaluatorRegistryHash(): string {
	return sha256([...REGISTRY.keys()].sort());
}
