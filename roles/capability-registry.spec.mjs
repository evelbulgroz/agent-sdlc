import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as registry from './capability-registry.ts';
import { semanticReviewCapability } from './capabilities/semantic-review.ts';
import { specificationSynthesisCapability } from './capabilities/specification-synthesis.ts';

const PINNED_HASH = 'b554c01b940729ab654c21dd84571ee0d2de2b38a77acf34d97ebe1291a9e402';
const PINNED_IDS = [
	'governed-structured-synthesis-v1',
	'semantic-review-v1',
	'deterministic-preflight-v1',
	'cleaner-tool-loop-v1',
	'hardener-tool-loop-v1',
	'architect-analysis-v1',
	'lean-tool-loop-v1',
];

test('@ac AC-04 @case AC-04.1 capabilityRegistryHash equals the pinned literal', () => {
	assert.equal(registry.capabilityRegistryHash(), PINNED_HASH);
});

test('@ac AC-04 @case AC-04.2 listCapabilityIds equals the pinned order', () => {
	assert.deepEqual(registry.listCapabilityIds(), PINNED_IDS);
});

test('@ac AC-04 @case AC-04.3 moved capabilities keep their module object identity', () => {
	assert.equal(registry.getCapability('semantic-review-v1'), semanticReviewCapability);
	assert.equal(registry.getCapability('governed-structured-synthesis-v1'), specificationSynthesisCapability);
});

test('@ac AC-04 @case AC-04.5 capability modules do not import the registry', () => {
	const dir = path.dirname(fileURLToPath(import.meta.url));
	for (const name of ['semantic-review.ts', 'specification-synthesis.ts']) {
		const source = fs.readFileSync(path.join(dir, 'capabilities', name), 'utf8');
		assert.equal(source.includes('capability-registry.ts'), false, name);
	}
});

test('unknown capability id is rejected', () => {
	assert.throws(
		() => registry.getCapability('missing-capability'),
		(error) => error.code === 'INVALID_CONTRACT',
	);
});

test('capability registry exports the frozen names', () => {
	assert.deepEqual(Object.keys(registry).sort(), [
		'LEAN_TOOL_LOOP_CAPABILITY',
		'LEAN_TOOL_LOOP_ID',
		'capabilityRegistryHash',
		'getCapability',
		'hasCapability',
		'listCapabilityIds',
	]);
});
