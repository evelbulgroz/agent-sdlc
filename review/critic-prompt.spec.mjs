import '../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import {
	PROMPT_TRUNCATION_SUFFIX,
	buildPhasePrompt,
	estimateCriticPromptTokens,
	loadRubric,
	sliceSafe,
	truncatePromptToTokenCeiling,
} from './critic-prompt.ts';

test('loadRubric loads markdown rubric from repository or throws INVALID_CONTRACT', () => {
	const specRubric = loadRubric(REPOSITORY_ROOT, 'spec');
	assert.ok(specRubric.includes('Specification Quality & Invariant Rubric'));

	const planRubric = loadRubric(REPOSITORY_ROOT, 'plan');
	assert.ok(planRubric.includes('Implementation Plan Quality & Invariant Rubric'));
	assert.ok(planRubric.includes('complexityInputs'));
	assert.ok(planRubric.includes('slices[].acceptanceCriteria'));

	const codeRubric = loadRubric(REPOSITORY_ROOT, 'code');
	assert.ok(codeRubric.includes('Code Quality & Architecture Rubric'));

	const qaRubric = loadRubric(REPOSITORY_ROOT, 'qa');
	assert.ok(qaRubric.includes('Quality Assurance & Test Verification Rubric'));

	assert.throws(
		() => loadRubric('/tmp/nonexistent-root-dir-test', 'spec'),
		/Review rubric file missing for phase 'spec'/,
	);
});

test('loadRubric throws INVALID_CONTRACT when rubric file is empty', () => {
	const tmpDir = path.join(os.tmpdir(), `empty-rubric-${crypto.randomUUID().slice(0, 8)}`);
	const rubricDir = path.join(tmpDir, '.agents', 'review-rubrics');
	fs.mkdirSync(rubricDir, { recursive: true });
	fs.writeFileSync(path.join(rubricDir, 'spec.md'), '   \n  \n');
	try {
		assert.throws(
			() => loadRubric(tmpDir, 'spec'),
			(err) => err.code === 'INVALID_CONTRACT' && err.message.includes('Review rubric file is empty'),
		);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.1 buildPhasePrompt with rootDir generates rubrics for all 4 phases', () => {
	const specPrompt = buildPhasePrompt({
		rootDir: REPOSITORY_ROOT,
		phase: 'spec',
		documentText: '# Spec: Foo Feature\nDetails here.',
	});
	assert.ok(specPrompt.includes('Specification Quality & Invariant Rubric'));
	assert.ok(specPrompt.includes('Target Specification'));
	assert.ok(specPrompt.includes('# Spec: Foo Feature'));

	const planPrompt = buildPhasePrompt({
		rootDir: REPOSITORY_ROOT,
		phase: 'plan',
		documentText: '# Implementation Plan\nSteps here.',
	});
	assert.ok(planPrompt.includes('Implementation Plan Quality & Invariant Rubric'));
	assert.ok(planPrompt.includes('Target Implementation Plan'));
	assert.ok(planPrompt.includes('# Implementation Plan'));

	const codePrompt = buildPhasePrompt({
		rootDir: REPOSITORY_ROOT,
		phase: 'code',
		promptPolicy: 'Strict reviewer policy',
		specSummary: 'Add critic review',
		acceptanceCriteria: ['AC 1', 'AC 2'],
		diff: 'diff --git a/foo b/foo',
		touchedFiles: ['foo.mjs'],
	});
	assert.ok(codePrompt.includes('Code Quality & Architecture Rubric'));
	assert.ok(codePrompt.includes('AC 1'));
	assert.ok(codePrompt.includes('Strict reviewer policy'));

	const qaPrompt = buildPhasePrompt({
		rootDir: REPOSITORY_ROOT,
		phase: 'qa',
		specSummary: 'Test suite validation',
		acceptanceCriteria: ['AC QA 1'],
		testOutput: 'Tests: 5 passed',
	});
	assert.ok(qaPrompt.includes('Quality Assurance & Test Verification Rubric'));
	assert.ok(qaPrompt.includes('Tests: 5 passed'));
	assert.ok(qaPrompt.includes('AC QA 1'));
});

test('@ac AC-01 @case AC-01.1 buildPhasePrompt rejects oversized assembled prompts with INPUT_OVERSIZED', () => {
	const hugeDoc = 'x'.repeat(25000);

	assert.throws(
		() =>
			buildPhasePrompt({
				rootDir: REPOSITORY_ROOT,
				phase: 'spec',
				documentText: hugeDoc,
			}),
		(err) => err.code === 'INPUT_OVERSIZED' && err.message.includes('exceeds packing ceiling'),
	);

	const manyLinesDoc = Array.from({ length: 1100 }, (_, i) => `Line ${i}`).join('\n');
	assert.throws(
		() =>
			buildPhasePrompt({
				rootDir: REPOSITORY_ROOT,
				phase: 'plan',
				documentText: manyLinesDoc,
			}),
		(err) => err.code === 'INPUT_OVERSIZED' && err.message.includes('1,000 lines'),
	);
});

test('AC-07: QA critic prompt receives assertion text, not mere paths, and truncates 3KB assertion to <=240 chars', () => {
	const hugeAssertion = 'y'.repeat(3000);
	const content1 = `
it('test one @ac AC-01', () => {
  expect(val1).toBe(1);
});
`;
	const content2 = `
it('test two @ac AC-02', () => {
  expect(val2).toEqual("${hugeAssertion}");
});
`;

	const prompt = buildPhasePrompt({
		rootDir: REPOSITORY_ROOT,
		phase: 'qa',
		specSummary: 'Test spec',
		acceptanceCriteria: ['AC-01: first outcome. Given X. Then Y.', 'AC-02: second outcome. Given A. Then B.'],
		touchedFiles: [
			{ path: 'test/one.spec.ts', content: content1 },
			{ path: 'test/two.spec.ts', content: content2 },
		],
	});

	assert.ok(prompt.includes('test/one.spec.ts:2 it("test one @ac AC-01")'));
	assert.ok(prompt.includes('test/one.spec.ts:3 expect(val1).toBe(1);'));
	assert.ok(prompt.includes('test/two.spec.ts:2 it("test two @ac AC-02")'));
	assert.ok(prompt.includes('expect(val2)'));
	assert.ok(!prompt.includes(hugeAssertion)); // Truncated!
	assert.ok(prompt.includes('…'));
});

test('AC-09: Packing overflow fails closed with INPUT_OVERSIZED and hint to split run', () => {
	// Create a test file whose single test cannot fit within maxBytes
	const content = `
it('massive test', () => {
  expect(1).toBe(1);
});
`;
	assert.throws(
		() =>
			buildPhasePrompt({
				rootDir: REPOSITORY_ROOT,
				phase: 'qa',
				promptPolicy: 'x'.repeat(25000), // Enormous rubric/policy > 24KB
				touchedFiles: [{ path: 'test/massive.spec.ts', content }],
			}),
		(err) => {
			assert.equal(err.code, 'INPUT_OVERSIZED');
			assert.ok(err.message.includes('split the run or reduce touched tests'));
			assert.ok(err.message.includes('bytes'));
			assert.ok(err.message.includes('lines'));
			assert.ok(!err.message.includes('skip QA'));
			assert.ok(!err.message.includes('approvedSpecHash'));
			return true;
		},
	);
});

test('@ac AC-01 @case AC-01.2 prompt truncation respects estimator ceilings for multibyte text', () => {
	const getTokens = (prompt) => Buffer.byteLength(prompt, 'utf8') + 64;
	const truncated = truncatePromptToTokenCeiling('é'.repeat(200), getTokens, 180);

	assert.ok(getTokens(truncated) <= 180);
	assert.match(truncated, /\[prompt truncated for token budget\]$/);
	assert.equal(truncatePromptToTokenCeiling('é'.repeat(200), getTokens, 1), '');
});

test('@ac AC-01 @case AC-01.2 multibyte prompts remain within the model prompt ceiling and never slice surrogate pairs', () => {
	const getTokens = (prompt) => Buffer.byteLength(prompt, 'utf8') + 64;
	const emojiText = '🚀🔥🎉✨'.repeat(50);
	const targetCeiling = 200;
	const truncatedEmoji = truncatePromptToTokenCeiling(emojiText, getTokens, targetCeiling);

	assert.ok(getTokens(truncatedEmoji) <= targetCeiling);
	assert.match(truncatedEmoji, /\[prompt truncated for token budget\]$/);

	for (let i = 0; i <= emojiText.length; i++) {
		const sliced = sliceSafe(emojiText, i);
		const decoded = Buffer.from(sliced, 'utf8').toString('utf8');
		assert.equal(decoded, sliced);
		assert.equal(sliced.includes('\uFFFD'), false);
	}

	const cjkText = '日本語テストテキスト'.repeat(30);
	const truncatedCjk = truncatePromptToTokenCeiling(cjkText, getTokens, 250);
	assert.ok(getTokens(truncatedCjk) <= 250);
	assert.match(truncatedCjk, /\[prompt truncated for token budget\]$/);
});

test('@ac AC-01 @case AC-01.2 truncatePromptToTokenCeiling leaves a prompt under the ceiling untouched', () => {
	const getTokens = (prompt) => Buffer.byteLength(prompt, 'utf8');
	assert.equal(truncatePromptToTokenCeiling('short prompt', getTokens, 1000), 'short prompt');
	const truncated = truncatePromptToTokenCeiling('x'.repeat(500), getTokens, 200);
	assert.ok(truncated.endsWith(PROMPT_TRUNCATION_SUFFIX));
	assert.ok(getTokens(truncated) <= 200);
});

test('@ac AC-01 @case AC-01.2 sliceSafe drops a trailing high surrogate instead of splitting the pair', () => {
	const text = 'a🚀b';
	assert.equal(sliceSafe(text, 2), 'a');
	assert.equal(sliceSafe(text, 3), 'a🚀');
	assert.equal(sliceSafe(text, 0), '');
	assert.equal(sliceSafe(text, 99), text);
});

test('estimateCriticPromptTokens returns a positive count that grows with the prompt', () => {
	const small = estimateCriticPromptTokens('hello');
	const large = estimateCriticPromptTokens('hello '.repeat(2000));
	assert.ok(Number.isInteger(small) && small > 0);
	assert.ok(large > small);
});

test('@ac AC-04 @case AC-04.1 loadRubric and buildPhasePrompt compose default protocol and philosophy rubrics when .agents/review-rubrics is absent', () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'critic-standalone-'));
	try {
		for (const phase of ['spec', 'plan', 'code', 'qa']) {
			const rubric = loadRubric(tmpDir, phase);
			assert.ok(rubric.length > 0);
			const prompt = buildPhasePrompt({
				rootDir: tmpDir,
				phase,
				documentText: '# Sample Doc',
			});
			assert.ok(prompt.includes(rubric));
		}
		assert.throws(
			() => loadRubric(tmpDir, 'unknown-phase'),
			(err) => err.code === 'INVALID_CONTRACT',
		);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('@ac AC-04 @case AC-04.2 @ac AC-03 loadRubric appends Layer 3 host rubric and matching pathScopedRules and stays within packing ceiling', () => {
	const pwaCodePrompt = buildPhasePrompt({
		rootDir: REPOSITORY_ROOT,
		phase: 'code',
		specSummary: 'PWA change',
		acceptanceCriteria: ['AC-01'],
		touchedFiles: ['apps/frontends/example-pwa-frontend/src/App.tsx'],
	});
	assert.ok(pwaCodePrompt.includes('Code Quality & Architecture Rubric'));
	assert.ok(pwaCodePrompt.includes('Host Code & Architecture Invariants'));
	assert.ok(pwaCodePrompt.includes('Path-Scoped Rules: Frontend PWA'));
	assert.equal(pwaCodePrompt.includes('Path-Scoped Rules: Backend Services'), false);
	assert.ok(Buffer.byteLength(pwaCodePrompt, 'utf8') <= 24576);
	assert.ok(pwaCodePrompt.split('\n').length <= 1000);
});
