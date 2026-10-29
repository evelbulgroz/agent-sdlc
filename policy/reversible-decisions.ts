import fs from 'node:fs';
import path from 'node:path';
import {
	type HostProfile,
	loadHostProfileOrFallback,
} from '../host/host-profile.ts';
import { type SpecificationDraft, validateDraft } from './contracts.ts';
import { SdlcError } from './errors.ts';

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildIrreversiblePatterns(
	options: { rootDir?: string; profile?: Readonly<HostProfile> } = {},
): readonly RegExp[] {
	const resolvedProfile = options.profile ?? loadHostProfileOrFallback(options.rootDir);
	const highRiskPaths = resolvedProfile.policy?.highRiskPaths ?? [];
	const customPatterns = resolvedProfile.policy?.irreversiblePatterns ?? [];

	const tokens = new Set<string>(['authentication', 'registry']);
	for (const highRiskPath of highRiskPaths) {
		const clean = highRiskPath.replace(/\/+$/, '');
		if (clean) {
			tokens.add(escapeRegex(clean));
			const base = path.posix.basename(clean);
			if (base && base.length >= 3) {
				tokens.add(escapeRegex(base));
			}
		}
	}
	for (const pattern of customPatterns) {
		if (pattern.trim().length > 0) {
			tokens.add(escapeRegex(pattern.trim()));
			const base = path.posix.basename(pattern.trim());
			if (base && base.length >= 3) {
				tokens.add(escapeRegex(base));
			}
		}
	}

	const secretTokens = ['secret', 'credential', 'api[-_]?key', 'token'];
	for (const secretPath of resolvedProfile.policy?.secretPaths ?? []) {
		const clean = secretPath.replace(/^\*+/, '').replace(/\/+$/, '');
		if (clean.length >= 3) secretTokens.push(escapeRegex(clean));
	}
	const secretRegex = new RegExp(`(?:\\b(?:${secretTokens.join('|')})\\b)`, 'i');
	const highRiskRegex = new RegExp(`\\b(?:${[...tokens].join('|')})\\b`, 'i');
	return Object.freeze([
		/\b(?:breaking\s*change|break\s*contract|contract\s*break|remove\s*endpoint|drop\s*column|delete\s*api)\b/i,
		highRiskRegex,
		secretRegex,
		/\b(?:rm\s+-rf|drop\s+table|truncate|git\s+reset|git\s+push\s+--force)\b/i,
	]);
}

export const IRREVERSIBLE_PATTERNS: readonly RegExp[] = buildIrreversiblePatterns();

export interface CandidateQuestion {
	questionId?: string | null;
	prompt?: string;
	rationale?: string;
	targets?: readonly string[];
	[key: string]: unknown;
}

export interface DecisionRule {
	readonly id: string;
	readonly name: string;
	readonly category: string;
	readonly matcher: RegExp | ((question: CandidateQuestion, combinedSearchText: string) => boolean);
	readonly decision: string;
	readonly assumption: string;
	readonly rationale: string;
}

export interface AutoDecision {
	readonly ruleId: string;
	readonly questionId: string | null;
	readonly category: string;
	readonly name: string;
	readonly decision: string;
	readonly assumption: string;
	readonly rationale: string;
	readonly matchedPrompt: string;
}

/**
 * Host `policy.reversibleDecisions` replaces the neutral default, whose only rule answers
 * "how do we verify" from the profile's `verify.argv`. Matchers are case-insensitive regex sources.
 */
export function buildReversibleRules(
	options: { rootDir?: string; profile?: Readonly<HostProfile> } = {},
): readonly DecisionRule[] {
	const profile = options.profile ?? loadHostProfileOrFallback(options.rootDir);
	const configured = profile.policy?.reversibleDecisions;
	if (configured) {
		return Object.freeze(configured.map((rule) => ({ ...rule, matcher: new RegExp(rule.matcher, 'i') })));
	}
	const command = (profile.verify?.argv ?? []).join(' ');
	return Object.freeze(command ? [{
		id: 'verification_command',
		name: 'Verification Command',
		category: 'verification',
		matcher: /\b(?:test\s+framework|unit\s+test\s+runner|testing\s+framework|verification\s+command|how\s+(?:do\s+we|to)\s+(?:run|verify)\s+tests?)\b/i,
		decision: `Verify changes with \`${command}\`.`,
		assumption: `Verification runs the host's configured command: ${command}.`,
		rationale: 'Host profile verify.argv.',
	}] : []);
}

export const REVERSIBLE_RULES: readonly DecisionRule[] = buildReversibleRules();

export function validateDecisionRule(rule: unknown): DecisionRule {
	if (!rule || typeof rule !== 'object') {
		throw new SdlcError('INVALID_DECISION_RULE', 'Rule must be an object');
	}
	const candidate = rule as Record<string, unknown>;
	for (const field of ['id', 'name', 'category', 'decision', 'assumption', 'rationale'] as const) {
		const val = candidate[field];
		if (typeof val !== 'string' || val.trim().length === 0) {
			throw new SdlcError('INVALID_DECISION_RULE', `Rule field '${field}' must be a non-empty string`);
		}
	}
	if (!(candidate.matcher instanceof RegExp) && typeof candidate.matcher !== 'function') {
		throw new SdlcError('INVALID_DECISION_RULE', 'Rule matcher must be a RegExp or function');
	}
	return candidate as { [K in keyof DecisionRule]: DecisionRule[K] };
}

export function resolveReversibleDecisions({
	draft,
	questions = [],
	rules = buildReversibleRules(),
}: {
	draft: unknown;
	questions?: readonly unknown[];
	rules?: readonly unknown[];
}): {
	autoDecisions: readonly AutoDecision[];
	remainingQuestions: readonly CandidateQuestion[];
	updatedDraft: SpecificationDraft;
} {
	const validDraft = validateDraft(draft);
	if (!Array.isArray(questions)) {
		throw new SdlcError('INVALID_DECISION_RULE', 'questions must be an array');
	}
	if (!Array.isArray(rules)) {
		throw new SdlcError('INVALID_DECISION_RULE', 'rules must be an array');
	}

	const validatedRules = rules.map(validateDecisionRule);
	const autoDecisions: AutoDecision[] = [];
	const remainingQuestions: CandidateQuestion[] = [];

	for (const rawQuestion of questions) {
		if (!rawQuestion || typeof rawQuestion !== 'object') {
			throw new SdlcError('INVALID_DECISION_RULE', 'Question must be an object');
		}
		const question = rawQuestion as CandidateQuestion;
		const promptText = String(question.prompt ?? '');
		const rationaleText = String(question.rationale ?? '');
		const targetsText = Array.isArray(question.targets) ? question.targets.join(' ') : '';
		const combinedSearchText = `${promptText} ${rationaleText} ${targetsText}`;

		const isIrreversible = IRREVERSIBLE_PATTERNS.some((pattern) => pattern.test(combinedSearchText));
		if (isIrreversible) {
			remainingQuestions.push(question);
			continue;
		}

		let matchedRule: DecisionRule | null = null;
		for (const rule of validatedRules) {
			const matched =
				typeof rule.matcher === 'function'
					? rule.matcher(question, combinedSearchText)
					: rule.matcher.test(combinedSearchText);
			if (matched) {
				matchedRule = rule;
				break;
			}
		}

		if (matchedRule) {
			autoDecisions.push({
				ruleId: matchedRule.id,
				questionId: question.questionId ?? null,
				category: matchedRule.category,
				name: matchedRule.name,
				decision: matchedRule.decision,
				assumption: matchedRule.assumption,
				rationale: matchedRule.rationale,
				matchedPrompt: promptText,
			});
		} else {
			remainingQuestions.push(question);
		}
	}

	const existingAssumptions = new Set(validDraft.assumptions);
	const updatedAssumptions = [...validDraft.assumptions];

	for (const dec of autoDecisions) {
		if (!existingAssumptions.has(dec.assumption)) {
			existingAssumptions.add(dec.assumption);
			updatedAssumptions.push(dec.assumption);
		}
	}

	const updatedDraft = validateDraft({
		...validDraft,
		assumptions: updatedAssumptions,
	});

	return {
		autoDecisions: Object.freeze(autoDecisions),
		remainingQuestions: Object.freeze(remainingQuestions),
		updatedDraft,
	};
}

export function formatDecisionsMarkdown({
	runId,
	autoDecisions = [],
	userDecisions = [],
}: {
	runId: string;
	autoDecisions?: readonly AutoDecision[];
	userDecisions?: readonly string[];
}): string {
	const lines = [
		`# Run Decisions: ${runId}`,
		'',
		'## Repository Standard Auto-Decisions (Reversible)',
		'',
	];

	if (autoDecisions.length === 0) {
		lines.push('_None recorded._');
	} else {
		for (const dec of autoDecisions) {
			lines.push(`### ${dec.name}`);
			lines.push(`- **Decision**: ${dec.decision}`);
			lines.push(`- **Assumption**: ${dec.assumption}`);
			lines.push(`- **Rationale**: ${dec.rationale}`);
			if (dec.matchedPrompt) {
				lines.push(`- **Resolved Question**: "${dec.matchedPrompt}"`);
			}
			lines.push('');
		}
	}

	lines.push('## User-Approved Architectural Decisions');
	lines.push('');

	if (userDecisions.length === 0) {
		lines.push('_None recorded._');
	} else {
		for (const dec of userDecisions) {
			lines.push(`- ${dec}`);
		}
	}

	lines.push('');
	return lines.join('\n');
}

export function projectDecisionsFile({
	runDir,
	runId,
	autoDecisions = [],
	userDecisions = [],
}: {
	runDir: string;
	runId: string;
	autoDecisions?: readonly AutoDecision[];
	userDecisions?: readonly string[];
}): string {
	const filePath = path.join(runDir, 'decisions.md');
	const content = formatDecisionsMarkdown({ runId, autoDecisions, userDecisions });
	fs.writeFileSync(filePath, content, 'utf8');
	return filePath;
}
