import assert from 'node:assert/strict';
import test from 'node:test';
import { AppliedSkillsRegistrySchema, CLOSED_FRICTION_CATEGORIES, SkillFindingsSyncArtifactSchema, VALID_FRICTION_SIGNALS, applyPatchToContent, resolveAggregatedAttributionLayer, validateFindingKey, validateProposedDiff } from './skill-learning-schema.ts';

test('validateFindingKey strictly validates roles, signals, and closed categories', () => {
	const valid = validateFindingKey('[repairer] churn_failure:typeorm-runner-leak');
	assert.equal(valid.role, 'repairer');
	assert.equal(valid.signal, 'churn_failure');
	assert.equal(valid.category, 'typeorm-runner-leak');
	assert.equal(valid.key, '[repairer] churn_failure:typeorm-runner-leak');

	// Verify all closed categories across all signals pass with a valid role
	for (const signal of VALID_FRICTION_SIGNALS) {
		for (const cat of CLOSED_FRICTION_CATEGORIES[signal]) {
			const parsed = validateFindingKey(`[implementer] ${signal}:${cat}`);
			assert.equal(parsed.category, cat);
		}
	}

	// Reject non-strings and untrimmed strings
	assert.throws(() => validateFindingKey(null), /must be a non-empty trimmed string/);
	assert.throws(() => validateFindingKey('  [repairer] churn_failure:typeorm-runner-leak  '), /must be a non-empty trimmed string/);

	// Reject malformed patterns
	assert.throws(() => validateFindingKey('repairer churn_failure:typeorm-runner-leak'), /does not match pattern/);
	assert.throws(() => validateFindingKey('[repairer] churn_failure-typeorm-runner-leak'), /does not match pattern/);

	// Reject invalid roles
	assert.throws(() => validateFindingKey('[unknown-role] tool_failure:command-not-found'), /not a valid prompt role/);

	// Reject invalid signals
	assert.throws(() => validateFindingKey('[implementer] invalid_signal:command-not-found'), /not a valid friction signal/);

	// Reject categories outside the closed vocabulary for that signal
	assert.throws(() => validateFindingKey('[implementer] tool_failure:typeorm-runner-leak'), /not valid for signal 'tool_failure'/);
	assert.throws(() => validateFindingKey('[repairer] churn_failure:command-not-found'), /not valid for signal 'churn_failure'/);
	assert.throws(() => validateFindingKey('[repairer] churn_failure:custom-category'), /not valid for signal 'churn_failure'/);
});

test('resolveAggregatedAttributionLayer enforces Ratchet precedence (layer1 > layer5 > layer3)', () => {
	// Single layer
	assert.equal(resolveAggregatedAttributionLayer(['layer3']), 'layer3');
	assert.equal(resolveAggregatedAttributionLayer(new Set(['layer3'])), 'layer3');
	assert.equal(resolveAggregatedAttributionLayer(['layer5']), 'layer5');
	assert.equal(resolveAggregatedAttributionLayer(['layer1']), 'layer1');

	// Any layer1 wins over layer3 and layer5
	assert.equal(resolveAggregatedAttributionLayer(['layer3', 'layer1']), 'layer1');
	assert.equal(resolveAggregatedAttributionLayer(['layer1', 'layer3', 'layer3']), 'layer1');
	assert.equal(resolveAggregatedAttributionLayer(['layer5', 'layer1']), 'layer1');
	assert.equal(resolveAggregatedAttributionLayer(['layer3', 'layer5', 'layer1']), 'layer1');

	// Layer 5 wins over Layer 3 when no layer1 is present
	assert.equal(resolveAggregatedAttributionLayer(['layer3', 'layer5']), 'layer5');
	assert.equal(resolveAggregatedAttributionLayer(['layer5', 'layer3', 'layer3']), 'layer5');
});

test('SkillFindingsSyncArtifactSchema and AppliedSkillsRegistrySchema validate valid contracts', () => {
	const now = new Date().toISOString();
	const syncArtifact = {
		schemaVersion: '1.0.0',
		runId: 'run-1',
		analyzedAt: now,
		findings: [
			{
				findingId: 'find-1',
				roleId: 'repairer',
				signalType: 'churn_failure',
				category: 'typeorm-runner-leak',
				findingKey: '[repairer] churn_failure:typeorm-runner-leak',
				status: 'PROVISIONAL',
				attributionLayer: 'layer3',
				evidence: { repairAttempts: 2 },
				proposedDiff: null,
			},
		],
	};
	assert.doesNotThrow(() => SkillFindingsSyncArtifactSchema.parse(syncArtifact));

	const appliedRegistry = {
		schemaVersion: '1.0.0',
		applied: [
			{
				findingKey: '[repairer] churn_failure:typeorm-runner-leak',
				appliedAt: now,
				promptFile: '.agents/workflows/prompts/repairer.md',
			},
		],
	};
	assert.doesNotThrow(() => AppliedSkillsRegistrySchema.parse(appliedRegistry));
});

test('validateProposedDiff enforces path allowlist, traversal protection, and length limits', () => {
	const validDiff = [
		'diff --git a/.agents/workflows/prompts/implementer.md b/.agents/workflows/prompts/implementer.md',
		'--- a/.agents/workflows/prompts/implementer.md',
		'+++ b/.agents/workflows/prompts/implementer.md',
		'@@ -1,1 +1,4 @@',
		'+<!-- Learned SDLC Rule: [implementer] tool_failure:test-runner-lookup -->',
		'+- Invariant [test-runner-lookup]: Always verify test runner.',
	].join('\n');

	// Valid diff returns the diff string
	assert.equal(validateProposedDiff(validDiff, 'implementer'), validDiff);

	// Diff targeting wrong file returns null
	const wrongFileDiff = validDiff.replaceAll('implementer.md', 'repairer.md');
	assert.equal(validateProposedDiff(wrongFileDiff, 'implementer'), null);

	// Diff targeting non-prompt file returns null
	const externalFileDiff = [
		'diff --git a/src/index.ts b/src/index.ts',
		'--- a/src/index.ts',
		'+++ b/src/index.ts',
		'+malicious code',
	].join('\n');
	assert.equal(validateProposedDiff(externalFileDiff, 'implementer'), null);

	// Traversal returns null
	const traversalDiff = validDiff.replaceAll('.agents/', '../.agents/');
	assert.equal(validateProposedDiff(traversalDiff, 'implementer'), null);

	// Null byte returns null
	assert.equal(validateProposedDiff(validDiff + '\0', 'implementer'), null);

	// Over 4000 chars returns null
	const hugeDiff = validDiff + '\n+' + 'x'.repeat(4001);
	assert.equal(validateProposedDiff(hugeDiff, 'implementer'), null);

	// Non-string returns null
	assert.equal(validateProposedDiff(null, 'implementer'), null);
	assert.equal(validateProposedDiff(123, 'implementer'), null);
});

test('applyPatchToContent applies unified diff hunks, additions, and text cleanly', () => {
	const original = '# repairer Role Prompt\n\nExisting instructions.\n';
	const unifiedDiff = [
		'diff --git a/.agents/workflows/prompts/repairer.md b/.agents/workflows/prompts/repairer.md',
		'--- a/.agents/workflows/prompts/repairer.md',
		'+++ b/.agents/workflows/prompts/repairer.md',
		'@@ -3,1 +3,4 @@',
		'+<!-- Learned SDLC Rule: [repairer] churn_failure:typeorm-runner-leak -->',
		'+- Invariant [typeorm-runner-leak]: Custom leak defense.',
	].join('\n');

	const applied = applyPatchToContent(original, unifiedDiff);
	assert.match(applied, /<!-- Learned SDLC Rule: \[repairer\] churn_failure:typeorm-runner-leak -->/);
	assert.match(applied, /- Invariant \[typeorm-runner-leak\]: Custom leak defense\./);
	assert.match(applied, /Existing instructions\./);

	// Case: added lines without hunk header
	const addedOnly = '+<!-- Learned Rule -->\n+- Invariant: Always test.\n';
	const appliedAdded = applyPatchToContent(original, addedOnly);
	assert.match(appliedAdded, /<!-- Learned Rule -->/);
	assert.match(appliedAdded, /- Invariant: Always test\./);

	// Case: empty original
	const appliedEmpty = applyPatchToContent('', unifiedDiff);
	assert.match(appliedEmpty, /<!-- Learned SDLC Rule: \[repairer\] churn_failure:typeorm-runner-leak -->/);
	assert.match(appliedEmpty, /- Invariant \[typeorm-runner-leak\]: Custom leak defense\./);
});
