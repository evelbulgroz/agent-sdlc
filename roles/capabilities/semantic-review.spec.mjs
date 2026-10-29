import assert from 'node:assert/strict';
import test from 'node:test';
import { estimatePromptTokens } from '@evelbulgroz/model-usage-govenor/tokenizer';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import { getCapability } from '../capability-registry.ts';
import { RoleRegistry } from '../role-registry.ts';
import { semanticReviewCapability } from './semantic-review.ts';

test('packed reviewer criteria keep literal on-screen text outcomes', () => {
	const reviewer = new RoleRegistry({ rootDir: REPOSITORY_ROOT }).loadRole('reviewer');
	const capability = getCapability(reviewer.role.capabilityId);
	const prompt = capability.buildPrompt({
		promptPolicy: reviewer.promptPolicy,
		maxPromptTokens: reviewer.role.requestedLimits.maxPromptTokens,
		specSummary: 'Show a Distance card.',
		acceptanceCriteria: [
			'AC-04: The card shows Distance. Given a gps log. Then its footer text is from GPS. Cases: AC-04.1: Given x, Then y.',
			...Array.from(
				{ length: 60 },
				(_, index) => `AC-${index + 10}: Filler ${index}. Given ${'word '.repeat(120)}. Then ${'word '.repeat(120)}.`,
			),
		],
		diff: `${'diff --git a/x b/x\n+line\n'.repeat(4000)}`,
	});
	assert.match(prompt, /footer text is from GPS/);
	assert.doesNotMatch(prompt, /AC-04\.1/);
});

test('semantic reviewer packs approved context below the governed prompt limit', () => {
	const reviewer = new RoleRegistry({ rootDir: REPOSITORY_ROOT }).loadRole('reviewer');
	const capability = getCapability(reviewer.role.capabilityId);
	const prompt = capability.buildPrompt({
		promptPolicy: reviewer.promptPolicy,
		maxPromptTokens: reviewer.role.requestedLimits.maxPromptTokens,
		specSummary: [
			'As a domain engineer, I want a generic ValueObject abstract base class in packages/shared-base so that domain entities across the monorepo can encapsulate immutable attribute bags with structural equality, completing the core Domain-Driven Design building block triad alongside Entity and DomainEvent.',
			'The base class also provides deep-copy serialization where Dates become ISO strings and nested ValueObjects invoke toDTO().',
		].join('\n\n'),
		acceptanceCriteria: [
			'AC-01: Instances with identical primitive properties evaluate as equal. Given two instances initialized with { a: 1 }. Then calling equals() returns true.',
			'AC-09: Serialization produces deep-copied plain snapshots. Given an instance with a Date and nested object. Then toDTO() and toJSON() return a plain object with the Date serialized as an ISO 8601 string, primitives and arrays deep-copied, and mutating the returned object does not alter the ValueObject.',
		],
		touchedFiles: [
			'packages/shared-base/',
			'packages/shared-base/src/domain/value-object.class.ts',
			'packages/shared-base/src/domain/value-object.class.spec.ts',
			'pnpm-lock.yaml',
			'services/authentication/',
		],
		diff: `${'diff --git a/packages/shared-base/src/domain/value-object.class.ts b/file\n+export class ValueObject {}\n'.repeat(400)}`,
	});
	const estimate = estimatePromptTokens({
		prompt,
		structuredOutputSchema: capability.structuredOutputSchema,
		routeFraming: '',
	});
	assert.ok(estimate.promptTokens <= reviewer.role.requestedLimits.maxPromptTokens - 200);
	assert.match(prompt, /ISO 8601/);
	assert.match(prompt, /packages\/shared-base/);
	assert.match(prompt, /services\/authentication/);
	assert.ok(prompt.includes('diff --git'));

	assert.throws(
		() =>
			capability.buildPrompt({
				promptPolicy: 'x'.repeat(13_000),
				maxPromptTokens: reviewer.role.requestedLimits.maxPromptTokens,
				diff: 'irreducible',
			}),
		/semantic review context exceeds the reviewer prompt budget/i,
	);
});

test('@ac AC-04 @case AC-04.4 semantic review over the token budget throws INPUT_OVERSIZED', () => {
	assert.throws(
		() => semanticReviewCapability.buildPrompt({
			promptPolicy: 'x'.repeat(13_000),
			maxPromptTokens: 12000,
			diff: 'irreducible',
		}),
		(error) => error.code === 'INPUT_OVERSIZED',
	);
});

test('semantic review names an empty diff and absent criteria', () => {
	const prompt = semanticReviewCapability.buildPrompt({
		promptPolicy: 'Review.',
		maxPromptTokens: 0,
		diff: '',
		acceptanceCriteria: [],
	});
	assert.match(prompt, /\(none\)/);
	assert.match(prompt, /\(no diff\)/);
});
