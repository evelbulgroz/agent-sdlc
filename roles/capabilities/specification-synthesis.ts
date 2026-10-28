import { type CompletenessEvaluation, canonicalJson } from '../../policy/contracts.ts';

const CAPABILITY_ID = 'governed-structured-synthesis-v1';

const proposalSchema = Object.freeze({
	type: 'object',
	required: ['patch', 'questions'],
	additionalProperties: false,
	properties: {
		patch: {
			type: 'array',
			items: {
				type: 'object',
				required: ['field', 'operation', 'value'],
				additionalProperties: false,
				properties: {
					field: {
						type: 'string',
						enum: [
							'goal',
							'nonGoals',
							'owningContext',
							'touchedSurfaces',
							'invariantsAndConstraints',
							'publicContractImpact',
							'acceptanceCriteria',
							'failureDefenses',
							'verificationPlan',
							'unresolvedQuestions',
							'assumptions',
						],
					},
					operation: { type: 'string', enum: ['set', 'append', 'remove'] },
					value: {
						anyOf: [
							{ type: 'string' },
							{ type: 'array', items: { type: 'string' } },
						],
					},
				},
			},
		},
		questions: {
			type: 'array',
			items: {
				type: 'object',
				required: [
					'questionId',
					'targets',
					'prompt',
					'responseKind',
					'options',
					'required',
					'rationale',
				],
				additionalProperties: false,
				properties: {
					questionId: { type: 'string' },
					targets: { type: 'array', items: { type: 'string' } },
					prompt: { type: 'string' },
					responseKind: {
						type: 'string',
						enum: ['text', 'boolean', 'single_select', 'multi_select'],
					},
					options: { type: 'array', items: { type: 'string' } },
					required: { type: 'boolean' },
					rationale: { type: 'string' },
				},
			},
		},
	},
});

export interface SpecificationSynthesisPromptOptions {
	promptPolicy?: string;
	draft?: unknown;
	completeness?: Partial<CompletenessEvaluation> | null;
	maxQuestions?: number;
	criticFindings?: readonly unknown[];
	scopeLearnings?: string;
}

export const specificationSynthesisCapability = Object.freeze({
	id: CAPABILITY_ID,
	structuredOutputSchema: proposalSchema,
	buildPrompt({
		promptPolicy = '',
		draft,
		completeness,
		maxQuestions = 0,
		criticFindings = [],
		scopeLearnings = '',
	}: SpecificationSynthesisPromptOptions): string {
		const missingFields = completeness?.missingFields ?? [];
		const unresolvedFields = [
			...new Set([
				...missingFields,
				...(completeness?.ambiguousFields ?? []),
			]),
		];
		const maxAllowedQuestions = Math.min(
			maxQuestions,
			unresolvedFields.length,
		);
		const sections = [
			promptPolicy.trim(),
			'',
			'Current draft and deterministic completeness report:',
			canonicalJson({ draft, completeness }),
			'',
			'### Proposal & Clarification Instructions:',
		];
		if (unresolvedFields.length === 0) {
			sections.push(
				'- All required specification fields are populated in the draft.',
				"- You MUST NOT return any questions (set 'questions: []').",
				"- Propose all needed remediations, refinements, or critic fixes in 'patch'.",
			);
		} else if (unresolvedFields.length === 1) {
			const field = unresolvedFields[0];
			sections.push(
				`- There is only 1 unresolved field remaining: '${field}'.`,
				`- You can propose an initial starter draft for '${field}' in 'patch', and/or return 1 question targeting '${field}'.`,
				"- Do NOT target already-resolved fields like 'goal'.",
			);
		} else {
			sections.push(
				`- You can propose sensible draft values in 'patch' for unresolved fields (${unresolvedFields.join(', ')}), or resolve them completely.`,
				`- If operator input or clarification is still beneficial, return 1 to ${maxAllowedQuestions} questions targeting unresolved fields (${unresolvedFields.join(', ')}).`,
				"- Do NOT target already-resolved fields like 'goal' or fields already agreed upon.",
				"- If your patch resolves all remaining fields with confident defaults, you may return 'questions: []'.",
			);
		}
		if (Array.isArray(criticFindings) && criticFindings.length > 0) {
			sections.push(
				'',
				'### Critic P1 findings to remediate before human approval',
				canonicalJson(criticFindings),
				'- IMPORTANT: All critic remediations must be made via the `patch` array directly in the draft fields. Do not attempt to ask user questions to fix critic findings.',
			);
		}
		if (scopeLearnings && scopeLearnings.trim()) {
			sections.push('', scopeLearnings.trim());
		}
		return sections.join('\n');
	},
});
