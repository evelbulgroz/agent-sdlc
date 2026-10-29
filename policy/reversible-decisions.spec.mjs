import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import crypto from 'node:crypto';
import { emptyDraft } from './contracts.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import {
	IRREVERSIBLE_PATTERNS,
	REVERSIBLE_RULES,
	buildReversibleRules,
	formatDecisionsMarkdown,
	projectDecisionsFile,
	resolveReversibleDecisions,
	validateDecisionRule,
} from './reversible-decisions.ts';

const HOST_RULE_SOURCES = [
	['module_system', 'Module System', '\\b(?:esm|commonjs|cjs)\\b', 'Architecture strictly uses ECMAScript Modules (ESM).'],
	['test_framework', 'Test Framework', '\\b(?:test\\s+framework|jest|vitest)\\b', 'Tests use existing framework placements.'],
	['package_manager', 'Package Manager', '\\b(?:npm|yarn|pnpm)\\b', 'Toolchain uses pnpm exclusively.'],
	['change_classification', 'Change Classification', '\\b(?:change\\s+class|preflight\\s+class)\\b', 'Classification is derived mechanically.'],
	['error_handling', 'Error Handling', '\\b(?:error\\s+handling|typed\\s+errors|sdlcerror)\\b', 'Errors are typed.'],
];
const HOST_RULES = buildReversibleRules({
	profile: {
		version: '1.3.0',
		policy: {
			reversibleDecisions: HOST_RULE_SOURCES.map(([category, name, matcher, assumption]) => ({
				id: `${category}_rule`, name, category, matcher, decision: `Decision for ${name}.`, assumption, rationale: 'Host convention.',
			})),
		},
	},
});

test('buildReversibleRules: neutral default references only verify.argv; host rules override it', () => {
	const defaults = buildReversibleRules({ profile: { version: '1.3.0', verify: { argv: ['pnpm', 'run', 'test:unit'] } } });
	assert.equal(defaults.length, 1);
	assert.match(defaults[0].decision, /`pnpm run test:unit`/);
	assert.doesNotMatch(JSON.stringify(defaults), /handbook|AGENTS\.md|Jest|Vitest|Nest|preflight\.sh|services/);
	assert.deepEqual(buildReversibleRules({ profile: { version: '1.3.0' } }), []);
	assert.equal(HOST_RULES.length, 5);
	assert.ok(HOST_RULES[0].matcher instanceof RegExp);
	assert.ok(REVERSIBLE_RULES.every((rule) => !/handbook/.test(rule.rationale)));
});

test('reversible decisions: happy path auto-resolves standard technical questions and appends assumptions', () => {
	const draft = emptyDraft('Build a reporting utility');
	const questions = [
		{
			questionId: 'q-esm',
			prompt: 'Should we use CommonJS or ESM for the new utility?',
			targets: ['invariantsAndConstraints'],
			rationale: 'Module format needs definition.',
		},
		{
			questionId: 'q-test',
			prompt: 'Which test framework should be used for unit tests?',
			targets: ['verificationPlan'],
			rationale: 'Jest vs Vitest placement.',
		},
		{
			questionId: 'q-pm',
			prompt: 'Can we install packages using npm or pnpm?',
			targets: ['invariantsAndConstraints'],
			rationale: 'Package manager choice.',
		},
		{
			questionId: 'q-class',
			prompt: 'What preflight change class should apply?',
			targets: ['invariantsAndConstraints'],
			rationale: 'Preflight class determination.',
		},
		{
			questionId: 'q-err',
			prompt: 'How should typed errors and SdlcError be structured?',
			targets: ['invariantsAndConstraints'],
			rationale: 'Error handling convention.',
		},
		{
			questionId: 'q-domain',
			prompt: 'Should the report include historical workout summary metrics or only live stats?',
			targets: ['acceptanceCriteria'],
			rationale: 'Domain requirements ambiguity.',
		},
	];

	const { autoDecisions, remainingQuestions, updatedDraft } = resolveReversibleDecisions({
		draft,
		questions,
		rules: HOST_RULES,
	});

	// 5 standard questions auto-resolved, 1 domain question remains
	assert.equal(autoDecisions.length, 5);
	assert.equal(remainingQuestions.length, 1);
	assert.equal(remainingQuestions[0].questionId, 'q-domain');

	// Verify categories
	const categories = autoDecisions.map((d) => d.category);
	assert.deepEqual(categories.sort(), [
		'change_classification',
		'error_handling',
		'module_system',
		'package_manager',
		'test_framework',
	]);

	// Assumptions appended to draft
	assert.equal(updatedDraft.assumptions.length, 5);
	assert.ok(
		updatedDraft.assumptions.some((a) =>
			a.includes('Architecture strictly uses ECMAScript Modules (ESM)'),
		),
	);
	assert.ok(
		updatedDraft.assumptions.some((a) =>
			a.includes('Tests use existing framework placements'),
		),
	);

	// Deduplication on subsequent resolution
	const secondPass = resolveReversibleDecisions({
		draft: updatedDraft,
		questions: [questions[0]], // question about ESM again
		rules: HOST_RULES,
	});
	assert.equal(secondPass.autoDecisions.length, 1);
	assert.equal(secondPass.updatedDraft.assumptions.length, 5); // count did not increase
});

test('reversible decisions: irreversible patterns are never auto-decided and remain for HITL', () => {
	const draft = emptyDraft('Sensitive feature');
	const questions = [
		{
			questionId: 'q-breaking',
			prompt: 'Is this a breaking change to the conditioning API contracts?',
			targets: ['publicContractImpact'],
		},
		{
			questionId: 'q-auth',
			prompt: 'Do we need to modify authentication service token validation?',
			targets: ['touchedSurfaces'],
		},
		{
			questionId: 'q-secret',
			prompt: 'Where should the new API key secret be stored in security-config?',
			targets: ['invariantsAndConstraints'],
		},
		{
			questionId: 'q-destructive',
			prompt: 'Can we run git reset or drop table during test cleanup?',
			targets: ['failureDefenses'],
		},
	];

	const { autoDecisions, remainingQuestions, updatedDraft } = resolveReversibleDecisions({
		draft,
		questions,
	});

	assert.equal(autoDecisions.length, 0);
	assert.equal(remainingQuestions.length, 4);
	assert.equal(updatedDraft.assumptions.length, 0);
});

test('reversible decisions: shadow paths (null, empty, malformed input)', () => {
	const draft = emptyDraft('Shadow path test');

	// Empty questions array
	const emptyResult = resolveReversibleDecisions({ draft, questions: [] });
	assert.equal(emptyResult.autoDecisions.length, 0);
	assert.equal(emptyResult.remainingQuestions.length, 0);
	assert.equal(emptyResult.updatedDraft.assumptions.length, 0);

	// Null or non-array questions
	assert.throws(
		() => resolveReversibleDecisions({ draft, questions: null }),
		/questions must be an array/,
	);
	assert.throws(
		() => resolveReversibleDecisions({ draft, questions: 'not an array' }),
		/questions must be an array/,
	);

	// Null draft
	assert.throws(
		() => resolveReversibleDecisions({ draft: null, questions: [] }),
		/must be an object/,
	);

	// Malformed question element
	assert.throws(
		() => resolveReversibleDecisions({ draft, questions: [null] }),
		/Question must be an object/,
	);

	// Malformed rules
	assert.throws(
		() => resolveReversibleDecisions({ draft, questions: [], rules: 'bad' }),
		/rules must be an array/,
	);
	assert.throws(
		() => validateDecisionRule(null),
		/Rule must be an object/,
	);
	assert.throws(
		() => validateDecisionRule({ id: 'r1' }), // missing required fields
		/Rule field 'name' must be a non-empty string/,
	);
	assert.throws(
		() =>
			validateDecisionRule({
				id: 'r1',
				name: 'R1',
				category: 'c1',
				decision: 'd1',
				assumption: 'a1',
				rationale: 'rat1',
				matcher: 'not a regex or function',
			}),
		/Rule matcher must be a RegExp or function/,
	);
});

test('reversible decisions: markdown formatting and file projection', () => {
	const runId = '2026-09-06-test-decisions';
	const autoDecisions = [
		{
			ruleId: 'module_system_esm',
			category: 'module_system',
			name: 'Module System',
			decision: 'Use Node.js ESM.',
			assumption: 'Strictly uses ESM.',
			rationale: 'Handbook style guide.',
			matchedPrompt: 'Should we use ESM?',
		},
	];
	const userDecisions = ['Approved SQLite persistence with schema migration v4.'];

	const markdown = formatDecisionsMarkdown({ runId, autoDecisions, userDecisions });
	assert.ok(markdown.includes(`# Run Decisions: ${runId}`));
	assert.ok(markdown.includes('### Module System'));
	assert.ok(markdown.includes('- **Decision**: Use Node.js ESM.'));
	assert.ok(markdown.includes('- **Resolved Question**: "Should we use ESM?"'));
	assert.ok(markdown.includes('- Approved SQLite persistence with schema migration v4.'));

	// File projection test
	const tmpDir = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`decisions-${crypto.randomUUID()}`,
	);
	fs.mkdirSync(tmpDir, { recursive: true });
	try {
		const filePath = projectDecisionsFile({
			runDir: tmpDir,
			runId,
			autoDecisions,
			userDecisions,
		});
		assert.equal(filePath, path.join(tmpDir, 'decisions.md'));
		assert.ok(fs.existsSync(filePath));
		const readContent = fs.readFileSync(filePath, 'utf8');
		assert.equal(readContent, markdown);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('buildIrreversiblePatterns treats configured secretPaths as irreversible but not security-config by default', async () => {
	const { buildIrreversiblePatterns } = await import('./reversible-decisions.ts');
	const hits = (patterns, text) => patterns.some((re) => re.test(text));
	const base = buildIrreversiblePatterns({ profile: { version: '1.3.0' } });
	assert.equal(hits(base, 'move the security-config folder'), false);
	assert.equal(hits(base, 'rotate the api-key'), true);
	const configured = buildIrreversiblePatterns({ profile: { version: '1.3.0', policy: { secretPaths: ['vault/'] } } });
	assert.equal(hits(configured, 'edit vault files'), true);
});
