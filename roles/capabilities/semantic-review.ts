import { truncateBody } from '@evelbulgroz/model-usage-govenor/sanitize-failure-text';
import { estimatePromptTokens } from '@evelbulgroz/model-usage-govenor/tokenizer';
import { SEVERITIES } from '../../policy/contracts.ts';
import { SdlcError } from '../../policy/errors.ts';

const SEMANTIC_REVIEW_ID = 'semantic-review-v1';
const REVIEW_PROMPT_RESERVE_TOKENS = 200;
const REVIEW_DIFF_MAX_CHARS = 8000;

function compactReviewSummary(summary: unknown): string {
	const firstSentence = String(summary ?? '')
		.trim()
		.split(/\n\s*\n/)[0]
		.match(/^.*?[.!?](?:\s|$)/s)?.[0]
		.trim();
	if (!firstSentence) return '(none)';
	return firstSentence
		.replace(/^As [^,]+,\s*I want\s*/i, '')
		.replace(/\s+so that\s+/i, ': ')
		.replace(/,\s*completing\b.*$/i, '');
}

function compactReviewCriteria(criteria: readonly unknown[]): string[] {
	return criteria.map((criterion) => {
		const text = String(criterion).trim();
		const given = text.indexOf('. Given ');
		if (given < 0) return text;
		const title = text.slice(0, given);
		const then = text.lastIndexOf('. Then ');
		if (then < 0) return title;
		const outcome = text.slice(then + '. Then '.length).replace(/\.$/, '');
		if (/without throwing/i.test(outcome)) return `${title}; must not throw`;
		if (/\bISO 8601\b/i.test(outcome)) return `${title}; ${outcome}`;
		const firstThen = text.indexOf('. Then ');
		const outcomeText = firstThen >= 0 ? text.slice(firstThen + '. Then '.length) : '';
		const mainOutcome = outcomeText.split(/\s+Cases:/)[0].replace(/\.$/, '');
		if (/\b(?:footer|text)\b/i.test(mainOutcome)) {
			return `${title}; ${mainOutcome.slice(0, 700)}`;
		}
		return title;
	});
}

function compactTouchedScopes(touchedFiles: readonly unknown[]): string[] {
	return [
		...new Set(
			touchedFiles.map((file) => {
				const normalized = String(file).replace(/\/+$/, '');
				const segments = normalized.split('/');
				if (segments[0] === 'apps' && segments.length > 2) return segments.slice(0, 3).join('/');
				if (segments[0] === 'packages' && segments.length > 1) return segments.slice(0, 2).join('/');
				return normalized;
			}),
		),
	];
}

function estimateSemanticReviewPrompt(prompt: string, structuredOutputSchema: unknown): number {
	return estimatePromptTokens({
		prompt,
		structuredOutputSchema,
		routeFraming: '',
	}).promptTokens;
}

const reviewFindingsSchema = Object.freeze({
	type: 'object',
	required: ['status', 'findings'],
	additionalProperties: false,
	properties: {
		status: { type: 'string', enum: ['PASS', 'FAIL'] },
		findings: {
			type: 'array',
			items: {
				type: 'object',
				required: [
					'findingId',
					'severity',
					'category',
					'path',
					'lineRange',
					'evidence',
					'failureMechanism',
					'remediation',
				],
				additionalProperties: false,
				properties: {
					findingId: { type: 'string' },
					severity: { type: 'string', enum: [...SEVERITIES] },
					category: { type: 'string' },
					path: { type: 'string' },
					lineRange: {
						type: 'array',
						items: { type: 'number' },
					},
					evidence: { type: 'string' },
					failureMechanism: { type: 'string' },
					remediation: { type: 'string' },
				},
			},
		},
	},
});

export interface SemanticReviewPromptOptions {
	promptPolicy?: string;
	specSummary?: string;
	acceptanceCriteria?: readonly string[];
	touchedFiles?: readonly string[];
	diff?: string;
	testOutput?: string;
	scopeLearnings?: string;
	maxPromptTokens?: number;
}

export const semanticReviewCapability = Object.freeze({
	id: SEMANTIC_REVIEW_ID,
	structuredOutputSchema: reviewFindingsSchema,
	buildPrompt({
		promptPolicy = '',
		specSummary = '',
		acceptanceCriteria = [],
		touchedFiles = [],
		diff = '',
		testOutput = '',
		scopeLearnings = '',
		maxPromptTokens = 0,
	}: SemanticReviewPromptOptions): string {
		const build = ({
			summary = specSummary,
			criteria = acceptanceCriteria,
			scopes = touchedFiles,
			diffChars = REVIEW_DIFF_MAX_CHARS,
		}: {
			summary?: string;
			criteria?: readonly string[];
			scopes?: readonly string[];
			diffChars?: number;
		} = {}): string => {
			const sections = [
				promptPolicy.trim(),
				'',
				'### Approved Specification',
				summary ? summary.trim() : '(none)',
				'',
				'### Acceptance Criteria',
				criteria.length > 0
					? criteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n')
					: '(none)',
				'',
				'### Touched Scopes',
				scopes.length > 0 ? scopes.join('\n') : '(none)',
				'',
				'### Uncommitted Tree Diff',
				diff ? truncateBody(diff.trim(), diffChars) : '(no diff)',
			];
			if (testOutput && testOutput.trim()) {
				sections.push('', '### Test Execution Output', testOutput.trim());
			}
			if (scopeLearnings && scopeLearnings.trim()) {
				sections.push('', scopeLearnings.trim());
			}
			return sections.join('\n');
		};

		let prompt = build();
		if (!Number.isSafeInteger(maxPromptTokens) || maxPromptTokens <= 0) return prompt;
		const targetTokens = maxPromptTokens - REVIEW_PROMPT_RESERVE_TOKENS;
		if (estimateSemanticReviewPrompt(prompt, reviewFindingsSchema) <= targetTokens) {
			return prompt;
		}

		const packed = {
			summary: compactReviewSummary(specSummary),
			criteria: compactReviewCriteria(acceptanceCriteria),
			scopes: compactTouchedScopes(touchedFiles),
		};
		prompt = build(packed);
		if (estimateSemanticReviewPrompt(prompt, reviewFindingsSchema) <= targetTokens) {
			return prompt;
		}

		let low = 0;
		let high = REVIEW_DIFF_MAX_CHARS;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			const candidate = build({ ...packed, diffChars: middle });
			if (estimateSemanticReviewPrompt(candidate, reviewFindingsSchema) <= targetTokens) {
				low = middle;
			} else {
				high = middle - 1;
			}
		}
		prompt = build({ ...packed, diffChars: low });
		if (estimateSemanticReviewPrompt(prompt, reviewFindingsSchema) > targetTokens) {
			throw new SdlcError(
				'INPUT_OVERSIZED',
				'Semantic review context exceeds the reviewer prompt budget after packing',
			);
		}
		return prompt;
	},
});
