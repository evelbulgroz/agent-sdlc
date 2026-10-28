import assert from 'node:assert/strict';
import test from 'node:test';
import { makeFixture } from '../testing/test-support.mjs';
import {
	canonicalizeAuthorVendor,
	canonicalizeAuthorVendors,
	detectHostVendor,
	resolveAuthorVendor,
	resolveCodeAuthorVendors,
} from './author-vendor.ts';

test('@ac AC-03 @case AC-03.1 canonicalizeAuthorVendor normalizes model names and fails closed on unknown', () => {
	assert.equal(canonicalizeAuthorVendor('openai'), 'openai');
	assert.equal(canonicalizeAuthorVendor('gpt-4o'), 'openai');
	assert.equal(canonicalizeAuthorVendor('o1-preview'), 'openai');
	assert.equal(canonicalizeAuthorVendor('o3-mini'), 'openai');

	assert.equal(canonicalizeAuthorVendor('anthropic'), 'anthropic');
	assert.equal(canonicalizeAuthorVendor('Claude-3.5-Sonnet'), 'anthropic');
	assert.equal(canonicalizeAuthorVendor('claude'), 'anthropic');

	assert.equal(canonicalizeAuthorVendor('google'), 'google');
	assert.equal(canonicalizeAuthorVendor('gemini-2.5-flash'), 'google');
	assert.equal(canonicalizeAuthorVendor('Google/Gemini'), 'google');

	assert.equal(canonicalizeAuthorVendor('xai'), 'xai');
	assert.equal(canonicalizeAuthorVendor('x-ai'), 'xai');
	assert.equal(canonicalizeAuthorVendor('grok-2'), 'xai');

	assert.equal(canonicalizeAuthorVendor('deepseek'), 'deepseek');
	assert.equal(canonicalizeAuthorVendor('deepseek-chat'), 'deepseek');

	assert.equal(canonicalizeAuthorVendor('meta'), 'meta');
	assert.equal(canonicalizeAuthorVendor('llama-3.1-70b'), 'meta');
	assert.equal(canonicalizeAuthorVendor('meta-llama'), 'meta');
	assert.equal(canonicalizeAuthorVendor('copilot'), 'openai');
	assert.equal(canonicalizeAuthorVendor('github'), 'openai');
	assert.equal(canonicalizeAuthorVendor('github-copilot'), 'openai');
	assert.equal(canonicalizeAuthorVendor('copilot/gpt-4o'), 'openai');
	assert.equal(canonicalizeAuthorVendor('antigravity'), 'google');

	assert.throws(() => canonicalizeAuthorVendor(''), /Canonical author vendor is required/);
	assert.throws(() => canonicalizeAuthorVendor(null), /Canonical author vendor is required/);
	assert.throws(() => canonicalizeAuthorVendor('some-random-vendor'), /Unknown or unsupported author vendor/);
	assert.deepEqual(
		canonicalizeAuthorVendors({
			authorVendor: 'gpt-6.1-sol',
			authorVendors: ['gpt-6.1-sol', 'gemini-pro-latest', 'gpt-6.1-sol'],
		}),
		['openai', 'google'],
	);
});

test('@ac AC-03 @case AC-03.2 detectHostVendor identifies copilot, antigravity, grok, claude and falls back', () => {
	assert.equal(detectHostVendor({ ANTIGRAVITY_AGENT: '1' }), 'google');
	assert.equal(detectHostVendor({ ANTIGRAVITY_CONVERSATION_ID: 'conv-1' }), 'google');
	assert.equal(detectHostVendor({ COPILOT_DEBUG_NONCE: 'abc' }), 'copilot');
	assert.equal(detectHostVendor({ GITHUB_COPILOT: '1' }), 'copilot');
	assert.equal(detectHostVendor({ VSCODE_COPILOT: '1' }), 'copilot');
	assert.equal(detectHostVendor({ COPILOT_AGENT: '1' }), 'copilot');
	assert.equal(detectHostVendor({ GROK_AGENT: '1' }), 'xai');
	assert.equal(detectHostVendor({ XAI_AGENT: '1' }), 'xai');
	assert.equal(detectHostVendor({ CLAUDE_AGENT: '1' }), 'anthropic');
	assert.equal(detectHostVendor({}), null);
});

test('@ac AC-03 @case AC-03.2 resolveAuthorVendor respects priority: snapshot > env > host detection > default', () => {
	assert.equal(resolveAuthorVendor({ authorVendor: 'copilot' }), 'openai');
	assert.equal(resolveAuthorVendor({ authorVendor: 'google' }), 'google');
	assert.equal(resolveAuthorVendor({ authorVendor: 'xai' }), 'xai');
	assert.equal(resolveAuthorVendor({}, { synthetic: true }), 'google');
});

test('@ac AC-03 @case AC-03.3 resolveCodeAuthorVendors derives every successful code contributor and fails closed on unknown models', () => {
	const fixture = makeFixture('critic-code-author-vendors', []);
	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Track code author vendors',
		});
		for (const [operationId, roleId, modelId] of [
			['implement-openai', 'implementer', 'gpt-6.1-sol'],
			['implement-google', 'implementer', 'gemini-pro-latest'],
			['repair-xai', 'repairer', 'grok-4.20-0309-reasoning'],
			['critic-ignored', 'critic-reviewer', 'claude-sonnet-5'],
		]) {
			fixture.store.recordModelOperation({
				operationId,
				runId: fixture.runId,
				synthetic: false,
				status: 'succeeded',
				roleId,
				modelId,
			});
		}
		assert.deepEqual(
			resolveCodeAuthorVendors(
				{ runId: fixture.runId, authorVendor: 'anthropic' },
				fixture.store,
			),
			['openai', 'google', 'xai'],
		);
		fixture.store.recordModelOperation({
			operationId: 'hardener-unknown',
			runId: fixture.runId,
			synthetic: false,
			status: 'succeeded',
			roleId: 'hardener',
			modelId: 'unmapped-model',
		});
		assert.throws(
			() =>
				resolveCodeAuthorVendors(
					{ runId: fixture.runId, authorVendor: 'anthropic' },
					fixture.store,
				),
			/Unknown or unsupported author vendor/,
		);
	} finally {
		fixture.close();
	}
});

test('@ac AC-03 @case AC-03.3 resolveCodeAuthorVendors attributes synthetic code operations to the synthetic fallback vendor', () => {
	const fixture = makeFixture('critic-synthetic-author-vendor', []);
	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Attribute synthetic author vendor',
		});
		fixture.store.recordModelOperation({
			operationId: 'synthetic-implementer',
			runId: fixture.runId,
			synthetic: true,
			status: 'succeeded',
			roleId: 'implementer',
			modelId: 'deterministic-json',
		});
		assert.deepEqual(
			resolveCodeAuthorVendors(
				{ runId: fixture.runId, authorVendor: null },
				fixture.store,
				{ synthetic: true },
			),
			['google'],
		);
	} finally {
		fixture.close();
	}
});
