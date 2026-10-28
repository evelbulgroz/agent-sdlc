import { sha256 } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { semanticReviewCapability } from './capabilities/semantic-review.ts';
import { specificationSynthesisCapability } from './capabilities/specification-synthesis.ts';

export const LEAN_TOOL_LOOP_ID = 'lean-tool-loop-v1';
const DETERMINISTIC_PREFLIGHT_ID = 'deterministic-preflight-v1';
const CLEANER_TOOL_LOOP_ID = 'cleaner-tool-loop-v1';
const HARDENER_TOOL_LOOP_ID = 'hardener-tool-loop-v1';
const ARCHITECT_ANALYSIS_ID = 'architect-analysis-v1';

export interface RoleCapability {
	readonly id: string;
	readonly structuredOutputSchema?: unknown;
	readonly buildPrompt?: (options: Record<string, unknown>) => string;
}

const cleanerResultSchema = Object.freeze({
	type: 'object',
	required: ['status', 'cleanedFiles', 'functionalDiffsDetected', 'hygieneOperations'],
	additionalProperties: false,
	properties: {
		status: { type: 'string', enum: ['PASS', 'CLEANED', 'NOOP'] },
		cleanedFiles: { type: 'array', items: { type: 'string' } },
		functionalDiffsDetected: { type: 'boolean' },
		hygieneOperations: { type: 'array', items: { type: 'string' } },
	},
});

const hardenerResultSchema = Object.freeze({
	type: 'object',
	required: ['status', 'testsAdded', 'shadowPathsCovered'],
	additionalProperties: false,
	properties: {
		status: { type: 'string', enum: ['PASS', 'HARDENED', 'NOOP'] },
		testsAdded: { type: 'array', items: { type: 'string' } },
		shadowPathsCovered: { type: 'array', items: { type: 'string' } },
	},
});

const architectAnalysisSchema = Object.freeze({
	type: 'object',
	required: ['status', 'violations'],
	additionalProperties: false,
	properties: {
		status: { type: 'string', enum: ['PASS', 'VIOLATIONS_DETECTED'] },
		violations: {
			type: 'array',
			items: {
				type: 'object',
				required: ['boundary', 'file', 'description', 'severity'],
				additionalProperties: false,
				properties: {
					boundary: { type: 'string' },
					file: { type: 'string' },
					description: { type: 'string' },
					severity: { type: 'string', enum: ['P1', 'P2', 'P3'] },
				},
			},
		},
	},
});

export const LEAN_TOOL_LOOP_CAPABILITY: RoleCapability = Object.freeze({
	id: LEAN_TOOL_LOOP_ID,
});

const REGISTRY = new Map<string, RoleCapability>([
	[
		specificationSynthesisCapability.id,
		specificationSynthesisCapability,
	],
	[
		semanticReviewCapability.id,
		semanticReviewCapability,
	],
	[
		DETERMINISTIC_PREFLIGHT_ID,
		Object.freeze({
			id: DETERMINISTIC_PREFLIGHT_ID,
			structuredOutputSchema: Object.freeze({
				type: 'object',
				additionalProperties: false,
			}),
			buildPrompt({ promptPolicy }: Record<string, unknown>) {
				return String(promptPolicy ?? '').trim();
			},
		}),
	],
	[
		CLEANER_TOOL_LOOP_ID,
		Object.freeze({
			id: CLEANER_TOOL_LOOP_ID,
			structuredOutputSchema: cleanerResultSchema,
			buildPrompt({ promptPolicy, touchedFiles = [], diff = '' }: Record<string, unknown>) {
				const files = Array.isArray(touchedFiles) ? (touchedFiles as string[]) : [];
				const diffStr = typeof diff === 'string' ? diff : '';
				const sections = [
					String(promptPolicy ?? '').trim(),
					'',
					'### Touched Files',
					files.length > 0 ? files.join('\n') : '(none)',
				];
				if (diffStr && diffStr.trim()) {
					sections.push('', '### Uncommitted Diff', diffStr.trim());
				}
				return sections.join('\n');
			},
		}),
	],
	[
		HARDENER_TOOL_LOOP_ID,
		Object.freeze({
			id: HARDENER_TOOL_LOOP_ID,
			structuredOutputSchema: hardenerResultSchema,
			buildPrompt({
				promptPolicy,
				specSummary = '',
				touchedFiles = [],
				diff = '',
				scopeLearnings = '',
			}: Record<string, unknown>) {
				const files = Array.isArray(touchedFiles) ? (touchedFiles as string[]) : [];
				const summaryStr = typeof specSummary === 'string' ? specSummary : '';
				const diffStr = typeof diff === 'string' ? diff : '';
				const learningsStr = typeof scopeLearnings === 'string' ? scopeLearnings : '';
				const sections = [
					String(promptPolicy ?? '').trim(),
					'',
					'### Specification Summary',
					summaryStr ? summaryStr.trim() : '(none)',
					'',
					'### Touched Files',
					files.length > 0 ? files.join('\n') : '(none)',
				];
				if (diffStr && diffStr.trim()) {
					sections.push('', '### Uncommitted Diff', diffStr.trim());
				}
				if (learningsStr && learningsStr.trim()) {
					sections.push('', learningsStr.trim());
				}
				return sections.join('\n');
			},
		}),
	],
	[
		ARCHITECT_ANALYSIS_ID,
		Object.freeze({
			id: ARCHITECT_ANALYSIS_ID,
			structuredOutputSchema: architectAnalysisSchema,
			buildPrompt({
				promptPolicy,
				specSummary = '',
				touchedFiles = [],
				diff = '',
				scopeLearnings = '',
			}: Record<string, unknown>) {
				const files = Array.isArray(touchedFiles) ? (touchedFiles as string[]) : [];
				const summaryStr = typeof specSummary === 'string' ? specSummary : '';
				const diffStr = typeof diff === 'string' ? diff : '';
				const learningsStr = typeof scopeLearnings === 'string' ? scopeLearnings : '';
				const sections = [
					String(promptPolicy ?? '').trim(),
					'',
					'### Specification Summary',
					summaryStr ? summaryStr.trim() : '(none)',
					'',
					'### Touched Files',
					files.length > 0 ? files.join('\n') : '(none)',
				];
				if (diffStr && diffStr.trim()) {
					sections.push('', '### Uncommitted Diff', diffStr.trim());
				}
				if (learningsStr && learningsStr.trim()) {
					sections.push('', learningsStr.trim());
				}
				return sections.join('\n');
			},
		}),
	],
	[
		LEAN_TOOL_LOOP_ID,
		LEAN_TOOL_LOOP_CAPABILITY,
	],
]);

export function hasCapability(id: string): boolean {
	return REGISTRY.has(id);
}

/**
 * Returns all registered capability IDs, so a repo-wide regression test can
 * walk every structuredOutputSchema (and structuredOutputSchemaForRole
 * variant) without needing to duplicate the CAPABILITY_ID constants.
 */
export function listCapabilityIds(): string[] {
	return [...REGISTRY.keys()];
}

export function getCapability(id: string): RoleCapability {
	const capability = REGISTRY.get(id);
	if (!capability) throw new SdlcError('INVALID_CONTRACT', `Unknown capability '${id}'`);
	return capability;
}

export function capabilityRegistryHash(): string {
	return sha256(
		[...REGISTRY.values()].map((capability) => ({
			id: capability.id,
			structuredOutputSchema: capability.structuredOutputSchema,
		})),
	);
}
