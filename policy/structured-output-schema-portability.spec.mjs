import assert from 'node:assert/strict';
import test from 'node:test';
import {
	listCapabilityIds,
	getCapability,
} from '../roles/capability-registry.ts';
import { ATTRIBUTION_OUTPUT_SCHEMA } from '../scripts/trace-skill-auditor.ts';
import {
	validateSchemaDefinition,
	assertStrictModeSchemaCompleteness,
} from '@fitness-app/model-usage';
import { minimalActionSchema } from '../execution/minimal-executor.ts';

// Every known structuredOutputSchema authored across the repo, keyed by a
// human-readable label for failure messages. Schemas defined per-capability
// come from capability-registry.mjs (including the per-role variants exposed
// via structuredOutputSchemaForRole); standalone governed-call schemas come
// from the agent-sdlc scripts/ directory.
//
// A schema can pass validateSchemaDefinition() (the governor's portable
// keyword subset) and still be rejected live by an OpenAI-compatible route
// under strict mode, because strict mode additionally requires every object
// node to set additionalProperties:false and list ALL of its properties in
// 'required'. Two real instances of this gap shipped undetected and were
// only discovered via a live canary run routing to OpenAI. This suite walks
// every known schema against both checks so the whole bug class is caught
// deterministically, without needing a live governed call to any provider.
function collectKnownSchemas() {
	const schemas = [];
	for (const capabilityId of listCapabilityIds()) {
		const capability = getCapability(capabilityId);
		if (typeof capability.structuredOutputSchemaForRole === 'function') {
			for (const roleId of ['implementer', 'repairer']) {
				const schema = capability.structuredOutputSchemaForRole(roleId);
				if (!schema) continue;
				schemas.push({
					label: `capability:${capabilityId}#${roleId}`,
					schema,
				});
			}
		} else if (capability.structuredOutputSchema) {
			schemas.push({
				label: `capability:${capabilityId}`,
				schema: capability.structuredOutputSchema,
			});
		}
	}
	schemas.push(
		{ label: 'scripts/trace-skill-auditor:attribution', schema: ATTRIBUTION_OUTPUT_SCHEMA },
	);
	return schemas;
}

test('every known structuredOutputSchema is portable to the governed schema subset', () => {
	const schemas = collectKnownSchemas();
	assert.ok(schemas.length > 0, 'expected at least one known schema to validate');
	for (const { label, schema } of schemas) {
		try {
			validateSchemaDefinition(schema);
		} catch (error) {
			assert.fail(`${label} failed validateSchemaDefinition(): ${error.message}`);
		}
	}
});

test('every known structuredOutputSchema satisfies OpenAI strict-mode completeness', () => {
	const schemas = collectKnownSchemas();
	assert.ok(schemas.length > 0, 'expected at least one known schema to validate');
	for (const { label, schema } of schemas) {
		try {
			assertStrictModeSchemaCompleteness(schema);
		} catch (error) {
			assert.fail(`${label} failed assertStrictModeSchemaCompleteness(): ${error.message}`);
		}
	}
});

test('assertStrictModeSchemaCompleteness rejects an object schema missing additionalProperties:false', () => {
	assert.throws(
		() => assertStrictModeSchemaCompleteness({ type: 'object', required: ['a'], properties: { a: { type: 'string' } } }),
		/additionalProperties:false/,
	);
});

test('assertStrictModeSchemaCompleteness rejects an object schema with an incomplete required list', () => {
	assert.throws(
		() =>
			assertStrictModeSchemaCompleteness({
				type: 'object',
				additionalProperties: false,
				required: ['a'],
				properties: { a: { type: 'string' }, b: { type: 'string' } },
			}),
		/missing b/,
	);
});

test('minimal action schema lists every parameter in required for OpenAI strict mode', () => {
	const schema = minimalActionSchema();
	validateSchemaDefinition(schema);
	assert.doesNotThrow(() => assertStrictModeSchemaCompleteness(schema));
	const parameters = new Map();
	for (const arm of schema.properties.action.anyOf) {
		const toolName = arm.properties?.toolName?.enum?.[0];
		if (toolName) parameters.set(toolName, arm.properties.parameters);
	}
	assert.deepEqual(parameters.get('read_file').required, ['path', 'start_line', 'end_line']);
	assert.deepEqual(parameters.get('replace_snapshot_range').required, [
		'path',
		'expected_file_hash',
		'start_line',
		'end_line',
		'new_string',
		'acknowledgedShrink',
	]);
	assert.deepEqual(parameters.get('replace_snapshot_range').properties.expected_file_hash, { type: 'string' });
	assert.deepEqual(parameters.get('write_file').required, ['path', 'content', 'acknowledgedShrink']);
	assert.deepEqual(parameters.get('find_files').required, ['path', 'pattern', 'query']);
});

test('assertStrictModeSchemaCompleteness rejects const without a type', () => {
	assert.throws(
		() => assertStrictModeSchemaCompleteness({ const: 'pnpm' }),
		/type beside const/,
	);
});

test('assertStrictModeSchemaCompleteness rejects an array or object const', () => {
	assert.throws(
		() =>
			assertStrictModeSchemaCompleteness({
				type: 'array',
				items: { type: 'string' },
				const: [],
			}),
		/non-primitive const/,
	);
	assert.throws(
		() =>
			assertStrictModeSchemaCompleteness({
				type: 'object',
				const: { forced: true },
			}),
		/non-primitive const/,
	);
});

test('assertStrictModeSchemaCompleteness accepts a primitive const beside its type', () => {
	assert.doesNotThrow(() =>
		assertStrictModeSchemaCompleteness({
			type: 'object',
			additionalProperties: false,
			required: ['kind', 'ready', 'count', 'note'],
			properties: {
				kind: { type: 'string', const: 'tool_call' },
				ready: { type: 'boolean', const: true },
				count: { type: 'integer', const: 1 },
				note: { type: 'null', const: null },
			},
		}),
	);
});

test('assertStrictModeSchemaCompleteness accepts a nullable anyOf as the strict-mode substitute for an optional property', () => {
	assert.doesNotThrow(() =>
		assertStrictModeSchemaCompleteness({
			type: 'object',
			additionalProperties: false,
			required: ['a', 'b'],
			properties: {
				a: { type: 'string' },
				b: { anyOf: [{ type: 'string' }, { type: 'null' }] },
			},
		}),
	);
});

