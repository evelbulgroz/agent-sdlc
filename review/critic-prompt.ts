// Critic prompt assembly: findings schema, rubric loading, phase prompts, and
// token-ceiling truncation. Leaf module; it never imports the adapter or gate.

import fs from 'node:fs';
import path from 'node:path';
import { SdlcError } from '../policy/errors.ts';
import {
	loadAndValidatePathScopedRules,
	matchesPathPrefix,
	rejectExecutablePrompt,
	resolveHostPromptsConfig,
} from '../roles/role-registry.ts';
import { extractTestExcerpts, type TouchedTestFileObject } from './excerpt-extractor.ts';
import { estimatePromptTokens } from '@evelbulgroz/model-usage-govenor/tokenizer';

const PACKAGE_REVIEW_DEFAULTS_ROOT = path.resolve(import.meta.dirname, 'defaults');

export const PROMPT_TRUNCATION_SUFFIX = '\n... [prompt truncated for token budget]';

export type TouchedFileEntry = string | TouchedTestFileObject;

export interface LoadRubricOptions {
	touchedFiles?: readonly TouchedFileEntry[];
	authoredPaths?: readonly string[];
}

export interface BuildPhasePromptOptions {
	rootDir: string;
	phase: string;
	promptPolicy?: string;
	specSummary?: string;
	acceptanceCriteria?: readonly string[];
	diff?: string;
	touchedFiles?: readonly TouchedFileEntry[];
	authoredPaths?: readonly string[];
	testOutput?: string;
	documentText?: string;
	rubric?: string;
	testExcerpts?: string;
	/** Criterion ids owned by this goal's tasks. When set, other criterion lines stay out of the prompt. */
	ownedCriterionIds?: readonly string[];
	/** Present only when the run bound an obligations document. The prompt receives the hash and no other bytes of that document. */
	obligations?: CriticObligationsBinding;
}

export interface CriticObligationsBinding {
	hash?: string;
	criterionIds: readonly string[];
	documentText: string;
}

function criterionIdsInText(text: string): string[] {
	const ids: string[] = [];
	for (const match of text.matchAll(new RegExp('AC-(\\d{2,})', 'g'))) {
		const digits = match[1];
		if (digits) ids.push(`AC-${digits}`);
	}
	return ids;
}

function limitOwnedText(text: string, owned: ReadonlySet<string> | null, obligationsText: string): string {
	const stripped = obligationsText.length > 0 ? text.split(obligationsText).join('') : text;
	if (!owned) return stripped;
	return stripped
		.split('\n')
		.filter((line) => criterionIdsInText(line).every((id) => owned.has(id)))
		.join('\n');
}

function resolveObligationsHash(
	obligations: CriticObligationsBinding | undefined,
	ownedCriterionIds: readonly string[] | undefined,
): string | null {
	if (obligations === undefined) return null;
	const hash = typeof obligations.hash === 'string' ? obligations.hash.trim() : '';
	if (!/^[a-f0-9]{64}$/.test(hash)) {
		throw new SdlcError(
			'INVALID_CONTRACT',
			'A bound obligations document requires its SHA-256 before prompt assembly',
		);
	}
	const present = new Set(obligations.criterionIds);
	for (const id of ownedCriterionIds ?? []) {
		if (!present.has(id)) {
			throw new SdlcError(
				'INVALID_CONTRACT',
				`Task criterion '${id}' is absent from the bound obligations document`,
			);
		}
	}
	return hash;
}

export function sliceSafe(str: string, length: number): string {
	if (length <= 0) return '';
	if (length >= str.length) return str;
	const code = str.charCodeAt(length - 1);
	if (code >= 0xd800 && code <= 0xdbff) {
		return str.slice(0, length - 1);
	}
	return str.slice(0, length);
}

export function truncatePromptToTokenCeiling(
	prompt: string,
	getTokens: (text: string) => number,
	targetCeiling: number,
): string {
	if (getTokens(prompt) <= targetCeiling) return prompt;
	if (getTokens(PROMPT_TRUNCATION_SUFFIX) > targetCeiling) return '';

	let low = 0;
	let high = prompt.length;
	let best = PROMPT_TRUNCATION_SUFFIX;
	while (low <= high) {
		const midpoint = Math.floor((low + high) / 2);
		const candidate = sliceSafe(prompt, midpoint) + PROMPT_TRUNCATION_SUFFIX;
		if (getTokens(candidate) <= targetCeiling) {
			best = candidate;
			low = midpoint + 1;
		} else {
			high = midpoint - 1;
		}
	}
	return best;
}

export const CRITIC_FINDINGS_SCHEMA = Object.freeze({
	type: 'object',
	required: ['status', 'findings'],
	additionalProperties: false,
	properties: {
		status: { type: 'string', enum: ['PASS', 'FAIL'] },
		findings: {
			type: 'array',
			items: {
				type: 'object',
				required: ['severity', 'category', 'file', 'lineRange', 'evidence', 'impact', 'remediation'],
				additionalProperties: false,
				properties: {
					severity: { type: 'string', enum: ['P1', 'P2', 'P3'] },
					category: {
						type: 'string',
						enum: ['correctness', 'security', 'boundary', 'testing', 'performance'],
					},
					file: { type: 'string' },
					lineRange: { type: 'string' },
					evidence: { type: 'string' },
					impact: { type: 'string' },
					remediation: { type: 'string' },
				},
			},
		},
	},
});

export function loadRubric(
	rootDir: string,
	phase: string,
	options: LoadRubricOptions = {},
): string {
	const defaultRubricPath = path.join(rootDir, '.agents', 'review-rubrics', `${phase}.md`);
	if (!fs.existsSync(rootDir)) {
		throw new SdlcError(
			'INVALID_CONTRACT',
			`Review rubric file missing for phase '${phase}': ${defaultRubricPath}`,
		);
	}
	const promptsConfig = resolveHostPromptsConfig(rootDir);
	const scopedRules = loadAndValidatePathScopedRules(rootDir, promptsConfig.pathScopedRules);
	const rubricPath = path.join(rootDir, promptsConfig.rubricAddendaDir, `${phase}.md`);
	const protocolPath = path.join(PACKAGE_REVIEW_DEFAULTS_ROOT, 'protocol', `${phase}.md`);
	const philosophyPath = path.join(PACKAGE_REVIEW_DEFAULTS_ROOT, 'philosophy', `${phase}.md`);

	const fragments: string[] = [];
	try {
		if (fs.existsSync(protocolPath)) {
			const layer1 = fs.readFileSync(protocolPath, 'utf8').trim();
			rejectExecutablePrompt(layer1);
			if (layer1) fragments.push(layer1);
		}
		if (promptsConfig.preset === 'default' && fs.existsSync(philosophyPath)) {
			const layer2 = fs.readFileSync(philosophyPath, 'utf8').trim();
			rejectExecutablePrompt(layer2);
			if (layer2) fragments.push(layer2);
		}
		if (fs.existsSync(rubricPath)) {
			const layer3 = fs.readFileSync(rubricPath, 'utf8').trim();
			if (!layer3) {
				throw new SdlcError(
					'INVALID_CONTRACT',
					`Review rubric file is empty for phase '${phase}': ${rubricPath}`,
				);
			}
			rejectExecutablePrompt(layer3);
			fragments.push(layer3);
		}
	} catch (error: unknown) {
		if (error instanceof SdlcError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new SdlcError(
			'INVALID_CONTRACT',
			`Failed to read review rubric file for phase '${phase}': ${message}`,
			{},
			{ cause: error },
		);
	}

	if (fragments.length === 0) {
		throw new SdlcError(
			'INVALID_CONTRACT',
			`Review rubric file missing for phase '${phase}': ${rubricPath}`,
		);
	}

	const candidatePaths: string[] = [];
	for (const entry of options.authoredPaths ?? []) {
		if (typeof entry === 'string' && entry.length > 0) candidatePaths.push(entry);
	}
	for (const entry of options.touchedFiles ?? []) {
		const filePath = typeof entry === 'string' ? entry : (entry?.path ?? '');
		if (filePath.length > 0) candidatePaths.push(filePath);
	}
	for (const rule of scopedRules) {
		const phaseMatches = rule.phases
			? (rule.phases as readonly string[]).includes(phase)
			: !rule.roles;
		const pathMatches = candidatePaths.some((candidate) =>
			rule.pathPrefixes.some((prefix) => matchesPathPrefix(candidate, prefix)),
		);
		if (phaseMatches && pathMatches) {
			fragments.push(rule.content);
		}
	}

	return fragments.join('\n\n');
}

const CRITIC_ROUTE_FRAMING = 'Return only JSON matching the supplied schema.\n';

/** Prompt token estimate used by the adapter for the structured-output critic request. */
export function estimateCriticPromptTokens(prompt: string): number {
	return estimatePromptTokens({
		prompt,
		structuredOutputSchema: CRITIC_FINDINGS_SCHEMA,
		routeFraming: CRITIC_ROUTE_FRAMING,
	}).promptTokens;
}

export function buildPhasePrompt({
	rootDir,
	phase,
	promptPolicy = '',
	specSummary = '',
	acceptanceCriteria = [],
	diff = '',
	touchedFiles = [],
	authoredPaths = [],
	testOutput = '',
	documentText = '',
	rubric = '',
	testExcerpts = '',
	ownedCriterionIds,
	obligations,
}: BuildPhasePromptOptions): string {
	const obligationsHash = resolveObligationsHash(obligations, ownedCriterionIds);
	const ownedIds = ownedCriterionIds === undefined ? null : new Set(ownedCriterionIds);
	const obligationsText = obligations?.documentText ?? '';
	const limitedDocumentText = limitOwnedText(documentText, ownedIds, obligationsText);
	const limitedSummary = limitOwnedText(specSummary, ownedIds, obligationsText);
	const limitedCriteria = ownedIds
		? acceptanceCriteria
			.map((entry) => limitOwnedText(entry, ownedIds, obligationsText).trim())
			.filter((entry) => criterionIdsInText(entry).some((id) => ownedIds.has(id)))
		: acceptanceCriteria;
	const phaseRubric = rubric
		? rubric.trim()
		: loadRubric(rootDir, phase, { touchedFiles, authoredPaths });
	const sections: string[] = [
		promptPolicy.trim() || 'Perform independent critic review adhering to repository standards.',
		'',
		phaseRubric,
	];
	if (obligationsHash) {
		sections.push('', '### Obligations SHA-256', obligationsHash);
	}

	if (phase === 'spec' || phase === 'plan') {
		sections.push(
			'',
			`### Target ${phase === 'spec' ? 'Specification' : 'Implementation Plan'}`,
			limitedDocumentText ? limitedDocumentText.trim() : '(none)',
		);
	} else if (phase === 'qa') {
		let excerptsText = '(none)';
		if (typeof testExcerpts === 'string' && testExcerpts.trim().length > 0) {
			excerptsText = testExcerpts.trim();
		} else if (Array.isArray(touchedFiles) && touchedFiles.length > 0) {
			const firstFile = touchedFiles[0];
			if (typeof firstFile === 'object' && firstFile !== null && 'content' in firstFile) {
				const prefix = [
					promptPolicy.trim() || 'Perform independent critic review adhering to repository standards.',
					'',
					phaseRubric,
					'',
					'### Approved Specification & Acceptance Criteria',
					limitedSummary ? limitedSummary.trim() : '(none)',
					'',
					'### Acceptance Criteria',
					limitedCriteria.length > 0
						? limitedCriteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n')
						: '(none)',
					'',
					'### Touched Test Excerpts',
				].join('\n');
				const suffix = [
					'',
					'### Preflight / Test Log Excerpts',
					testOutput ? testOutput.trim() : '(none)',
				].join('\n');
				const baseBytes = Buffer.byteLength(prefix, 'utf8') + Buffer.byteLength(suffix, 'utf8') + 2;
				const baseLines = prefix.split('\n').length + suffix.split('\n').length;
				const objectFiles = touchedFiles.filter(
					(entry): entry is TouchedTestFileObject => typeof entry === 'object' && entry !== null,
				);
				const extracted = extractTestExcerpts({
					touchedFiles: objectFiles,
					acceptanceCriteria: limitedCriteria,
					baseBytes,
					baseLines,
				});
				excerptsText = extracted.text;
			} else {
				excerptsText = touchedFiles.map((entry) => (typeof entry === 'string' ? entry : (entry.path ?? ''))).join('\n');
			}
		}
		sections.push(
			'',
			'### Approved Specification & Acceptance Criteria',
			limitedSummary ? limitedSummary.trim() : '(none)',
			'',
			'### Acceptance Criteria',
			limitedCriteria.length > 0
				? limitedCriteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n')
				: '(none)',
			'',
			'### Touched Test Excerpts',
			excerptsText ? excerptsText.trim() : '(none)',
			'',
			'### Preflight / Test Log Excerpts',
			testOutput ? testOutput.trim() : '(none)',
		);
	} else {
		// 'code'
		sections.push(
			'',
			'### Approved Specification',
			limitedSummary ? limitedSummary.trim() : '(none)',
			'',
			'### Acceptance Criteria',
			limitedCriteria.length > 0
				? limitedCriteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n')
				: '(none)',
			'',
			'### Touched Files',
			touchedFiles.length > 0
				? touchedFiles.map((entry) => (typeof entry === 'string' ? entry : (entry.path ?? ''))).join('\n')
				: '(none)',
		);

		if (diff && diff.trim()) {
			sections.push('', '### Uncommitted Changes Diff', diff.trim());
		}
		if (testOutput && testOutput.trim()) {
			sections.push('', '### Test Execution Output', testOutput.trim());
		}
	}

	const prompt = sections.join('\n');
	const maxBytes = 24576; // 24 KB
	const maxLines = 1000;
	if (Buffer.byteLength(prompt, 'utf8') > maxBytes || prompt.split('\n').length > maxLines) {
		const byteCount = Buffer.byteLength(prompt, 'utf8');
		const lineCount = prompt.split('\n').length;
		const fileCount = Array.isArray(touchedFiles) ? touchedFiles.length : 0;
		throw new SdlcError(
			'INPUT_OVERSIZED',
			`Assembled prompt exceeds packing ceiling (max 24KB / 1,000 lines; got ${byteCount} bytes, ${lineCount} lines across ${fileCount} files and 0 tests). Hint: split the run or reduce touched tests.`,
			{ byteCount, lineCount, fileCount, testCount: 0 },
		);
	}
	return prompt;
}
