import { z } from 'zod';
import { SdlcError } from '../errors.ts';

export const VALID_PROMPT_ROLES = Object.freeze([
	'specifier',
	'implementer',
	'repairer',
	'verifier',
	'reviewer',
	'architect',
	'hardener',
	'cleaner',
	'critic-reviewer',
] as const);

export const VALID_FRICTION_SIGNALS = Object.freeze([
	'tool_failure',
	'churn_failure',
	'rubric_gap',
] as const);

export const CLOSED_FRICTION_CATEGORIES = Object.freeze({
	tool_failure: Object.freeze([
		'command-not-found',
		'permission-denied',
		'test-runner-lookup',
		'process-timeout',
		'syntax-error',
		'import-resolution',
		'script-missing',
	] as const),
	churn_failure: Object.freeze([
		'repair-loop-limit',
		'stale-file-edit',
		'typeorm-runner-leak',
		'hanging-process',
		'type-check-cycle',
	] as const),
	rubric_gap: Object.freeze([
		'ac-uncovered',
		'boundary-violation',
		'missing-regression-test',
		'inversion-omitted',
		'qa-divergence',
	] as const),
});

export const PromptRoleSchema = z.enum(VALID_PROMPT_ROLES);
export type PromptRole = z.infer<typeof PromptRoleSchema>;

export const FrictionSignalSchema = z.enum(VALID_FRICTION_SIGNALS);
export type FrictionSignal = z.infer<typeof FrictionSignalSchema>;

export const ValidatedFindingKeySchema = z.object({
	role: PromptRoleSchema,
	signal: FrictionSignalSchema,
	category: z.string(),
	key: z.string(),
});
export type ValidatedFindingKey = z.infer<typeof ValidatedFindingKeySchema>;

const FINDING_KEY_REGEX = /^\[([a-z-]+)\] ([a-z_]+):([a-z0-9-]+)$/;

export function validateFindingKey(key: unknown): Readonly<ValidatedFindingKey> {
	if (typeof key !== 'string' || key.trim() !== key) {
		throw new SdlcError('INVALID_INPUT', 'findingKey must be a non-empty trimmed string');
	}
	const match = FINDING_KEY_REGEX.exec(key);
	if (!match) {
		throw new SdlcError(
			'INVALID_INPUT',
			`findingKey '${key}' does not match pattern '^[role] signal:category$'`,
		);
	}
	const [, role, signal, category] = match;
	if (!role || !(VALID_PROMPT_ROLES as readonly string[]).includes(role)) {
		throw new SdlcError(
			'INVALID_INPUT',
			`findingKey role '${role}' is not a valid prompt role (expected one of ${VALID_PROMPT_ROLES.join(', ')})`,
		);
	}
	if (!signal || !(VALID_FRICTION_SIGNALS as readonly string[]).includes(signal)) {
		throw new SdlcError(
			'INVALID_INPUT',
			`findingKey signal '${signal}' is not a valid friction signal (expected one of ${VALID_FRICTION_SIGNALS.join(', ')})`,
		);
	}
	const validCategories = CLOSED_FRICTION_CATEGORIES[signal as FrictionSignal] as readonly string[] | undefined;
	if (!category || !validCategories || !validCategories.includes(category)) {
		throw new SdlcError(
			'INVALID_INPUT',
			`findingKey category '${category}' is not valid for signal '${signal}' (expected one of ${validCategories?.join(', ')})`,
		);
	}
	return Object.freeze({
		role: role as PromptRole,
		signal: signal as FrictionSignal,
		category,
		key,
	});
}

export function resolveAggregatedAttributionLayer(
	layers: Iterable<string> | ReadonlySet<string>,
): 'layer1' | 'layer3' | 'layer5' {
	const set = layers instanceof Set ? layers : new Set(layers);
	if (set.has('layer1')) return 'layer1';
	if (set.has('layer5')) return 'layer5';
	return 'layer3';
}

/**
 * Validates that a Layer 3 proposed diff is safe:
 * - Length is capped at 4000 characters.
 * - Path traversal (..) and null bytes are rejected.
 * - Any path referenced in git diff headers strictly matches `.agents/workflows/prompts/${roleId}.md`.
 * Returns the diff string if safe, or null if invalid.
 */
export function validateProposedDiff(diff: unknown, roleId: string): string | null {
	if (!diff || typeof diff !== 'string') return null;
	if (diff.length > 4000) return null;
	if (diff.includes('..') || diff.includes('\0')) return null;

	const expectedRelPath = `.agents/workflows/prompts/${roleId}.md`;
	const lines = diff.split('\n');
	for (const line of lines) {
		if (line.startsWith('diff --git') || line.startsWith('--- ') || line.startsWith('+++ ')) {
			const tokens = line.split(/\s+/).slice(1);
			for (const token of tokens) {
				const cleaned = token.replace(/^[ab]\//, '');
				if (cleaned.startsWith('.') || cleaned.includes('/')) {
					if (cleaned !== expectedRelPath) {
						return null;
					}
				}
			}
		}
	}
	return diff;
}

export const SkillFindingsSyncArtifactSchema = z.object({
	schemaVersion: z.literal('1.0.0'),
	runId: z.string().min(1),
	analyzedAt: z.string().datetime(),
	findings: z.array(
		z.object({
			findingId: z.string().min(1),
			roleId: PromptRoleSchema,
			signalType: FrictionSignalSchema,
			category: z.string().min(1),
			findingKey: z.string().min(1),
			status: z.enum(['PROVISIONAL', 'RECOMMENDED', 'APPLIED', 'REJECTED']),
			attributionLayer: z.enum(['layer1', 'layer3', 'layer5']),
			evidence: z.record(z.string(), z.unknown()),
			proposedDiff: z.string().max(4000).nullable().optional(),
		}),
	),
});
export type SkillFindingsSyncArtifact = z.infer<typeof SkillFindingsSyncArtifactSchema>;

export const AppliedSkillsRegistrySchema = z.object({
	schemaVersion: z.literal('1.0.0'),
	applied: z.array(
		z.object({
			findingKey: z.string().min(1),
			appliedAt: z.string().datetime(),
			promptFile: z.string().min(1),
		}),
	),
});
export type AppliedSkillsRegistry = z.infer<typeof AppliedSkillsRegistrySchema>;

/**
 * Applies a unified diff or patch text to an existing file content string.
 * Handles unified diff hunks (with @@ markers), additions-only diffs, and raw text snippets.
 */
export function applyPatchToContent(
	originalContent: string | null | undefined,
	patchText: string | null | undefined,
): string {
	if (!patchText || typeof patchText !== 'string') return originalContent ?? '';
	const base = originalContent ?? '';

	if (patchText.includes('@@')) {
		const lines = patchText.split('\n');
		const hunks: Array<{
			oldStart: number;
			oldCount: number;
			newStart: number;
			newCount: number;
			lines: string[];
		}> = [];
		let currentHunk: {
			oldStart: number;
			oldCount: number;
			newStart: number;
			newCount: number;
			lines: string[];
		} | null = null;

		for (const line of lines) {
			if (line.startsWith('@@')) {
				const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
				if (match) {
					currentHunk = {
						oldStart: parseInt(match[1], 10),
						oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
						newStart: parseInt(match[3], 10),
						newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
						lines: [],
					};
					hunks.push(currentHunk);
				}
			} else if (currentHunk) {
				if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '') {
					currentHunk.lines.push(line);
				}
			}
		}

		if (hunks.length > 0) {
			const originalLines = base ? base.split('\n') : [];
			const resultLines = [...originalLines];
			let lineOffset = 0;

			for (const hunk of hunks) {
				const targetIndex = Math.max(0, hunk.oldStart - 1 + lineOffset);
				const hunkOldLines = hunk.lines
					.filter((l) => !l.startsWith('+'))
					.map((l) => (l.startsWith(' ') || l.startsWith('-') ? l.slice(1) : l));
				const hunkNewLines = hunk.lines
					.filter((l) => !l.startsWith('-'))
					.map((l) => (l.startsWith(' ') || l.startsWith('+') ? l.slice(1) : l));

				if (hunkOldLines.length === 0 || targetIndex >= resultLines.length) {
					const addedOnly = hunk.lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1));
					resultLines.push(...addedOnly);
					lineOffset += addedOnly.length;
				} else {
					let matchIdx = -1;
					let matchesAtTarget = true;
					for (let i = 0; i < hunkOldLines.length; i++) {
						if (resultLines[targetIndex + i] !== hunkOldLines[i]) {
							matchesAtTarget = false;
							break;
						}
					}
					if (matchesAtTarget) {
						matchIdx = targetIndex;
					} else {
						for (let i = 0; i <= resultLines.length - hunkOldLines.length; i++) {
							let match = true;
							for (let j = 0; j < hunkOldLines.length; j++) {
								if (resultLines[i + j] !== hunkOldLines[j]) {
									match = false;
									break;
								}
							}
							if (match) {
								matchIdx = i;
								break;
							}
						}
					}

					if (matchIdx !== -1) {
						resultLines.splice(matchIdx, hunkOldLines.length, ...hunkNewLines);
						lineOffset += hunkNewLines.length - hunkOldLines.length;
					} else {
						const addedOnly = hunk.lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1));
						resultLines.push(...addedOnly);
						lineOffset += addedOnly.length;
					}
				}
			}

			const result = resultLines.join('\n');
			return result.endsWith('\n') ? result : `${result}\n`;
		}
	}

	const patchLines = patchText.split('\n');
	const addedLines = patchLines
		.filter((l) => l.startsWith('+') && !l.startsWith('+++'))
		.map((l) => l.slice(1));
	if (addedLines.length > 0) {
		const addition = addedLines.join('\n');
		return base ? `${base.trimEnd()}\n\n${addition}\n` : `${addition}\n`;
	}

	return base ? `${base.trimEnd()}\n\n${patchText.trim()}\n` : `${patchText.trim()}\n`;
}
