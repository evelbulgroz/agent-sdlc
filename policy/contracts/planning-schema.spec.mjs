import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTaskManifest, validateTaskManifestAcceptanceCriteria } from './planning-schema.ts';

function validTaskManifest() {
	return {
		schemaVersion: '1.0.0',
		slices: [
			{
				sliceId: 'foundation',
				kind: 'enabling',
				goal: 'Prepare the deterministic foundation',
				acceptanceCriteria: [],
				dependsOn: [],
			},
			{
				sliceId: 'behavior',
				kind: 'vertical',
				goal: 'Deliver one bounded behavior',
				acceptanceCriteria: ['AC-01'],
				dependsOn: ['foundation'],
			},
		],
		tasks: [
			{
				taskId: 'foundation-task',
				sliceId: 'foundation',
				targetPackage: 'tools',
				authoredPaths: ['tools/agent-sdlc/policy/contracts.mjs'],
				pathPrefixes: ['tools/agent-sdlc'],
				generatedOutputs: [],
				dependsOn: [],
				deliveryLayers: ['tooling'],
				dependencyMutations: [],
				shadowPaths: {
					unhappy: 'invalid contract',
					timeout: 'deadline exceeded',
					empty: 'no delta',
					boundary: 'path escape',
				},
				verificationCommand: ['pnpm', 'run', 'agent:test-sdlc'],
				generatorCommand: null,
			},
			{
				taskId: 'behavior-task',
				sliceId: 'behavior',
				targetPackage: 'tools',
				authoredPaths: ['tools/agent-sdlc/workflow/specification.mjs'],
				pathPrefixes: ['tools/agent-sdlc'],
				generatedOutputs: [],
				dependsOn: ['foundation-task'],
				deliveryLayers: ['tooling'],
				dependencyMutations: [],
				shadowPaths: {
					unhappy: 'invalid input',
					timeout: 'command timeout',
					empty: 'empty manifest',
					boundary: 'scope mismatch',
				},
				verificationCommand: ['pnpm', 'run', 'agent:test-sdlc'],
				generatorCommand: null,
			},
		],
	};
}

test('task manifest contract validates closed slices, tasks, commands, and nested records', () => {
	const manifest = validTaskManifest();
	const parsed = validateTaskManifest(manifest);
	assert.equal(parsed.slices.length, 2);
	assert.equal(parsed.tasks[1].verificationCommand[2], 'agent:test-sdlc');
});

test('task manifest rejects verification and generator argv outside the closed command allowlist', () => {
	for (const [field, command] of [
		['verificationCommand', ['pnpm', 'install']],
		['verificationCommand', ['bash', '-c', 'echo bypass']],
		['generatorCommand', ['pnpm', 'exec', 'custom-generator']],
	]) {
		const manifest = validTaskManifest();
		manifest.tasks[1][field] = command;
		if (field === 'generatorCommand') {
			manifest.tasks[1].generatedOutputs = ['tools/agent-sdlc/generated'];
		}
		assert.throws(
			() => validateTaskManifest(manifest),
			(error) =>
				error.code === 'INVALID_CONTRACT' &&
				error.message.includes(`${field} must be`),
		);
	}

	const unitManifest = validTaskManifest();
	unitManifest.tasks[1].verificationCommand = [
		'pnpm',
		'--filter',
		'@fitness-app/conditioning-service',
		'run',
		'test:unit',
	];
	assert.doesNotThrow(() => validateTaskManifest(unitManifest));

	const intManifest = validTaskManifest();
	intManifest.tasks[1].verificationCommand = [
		'pnpm',
		'--filter',
		'@fitness-app/conditioning-service',
		'run',
		'test:integration',
	];
	assert.doesNotThrow(() => validateTaskManifest(intManifest));

	const generatorManifest = validTaskManifest();
	generatorManifest.tasks[1].generatorCommand = [
		'pnpm',
		'--filter',
		'@fitness-app/conditioning-service',
		'run',
		'build:contracts',
	];
	generatorManifest.tasks[1].generatedOutputs = [
		'apps/services/conditioning/openapi/conditioning-service.openapi.json',
	];
	assert.doesNotThrow(() => validateTaskManifest(generatorManifest));

	const manifest = validTaskManifest();
	assert.throws(
		() => validateTaskManifest({ ...manifest, unexpected: true }),
		/unknown field 'unexpected'/,
	);
	assert.throws(
		() =>
			validateTaskManifest({
				...manifest,
				tasks: [{ ...manifest.tasks[0], unexpected: true }, manifest.tasks[1]],
			}),
		/unknown field 'unexpected'/,
	);
	assert.throws(
		() =>
			validateTaskManifest({
				...manifest,
				tasks: [
					{
						...manifest.tasks[0],
						generatedOutputs: ['tools/generated'],
					},
					manifest.tasks[1],
				],
			}),
		/generatorCommand is required/,
	);
	assert.throws(() => validateTaskManifest(null), /must be an object/);
});

test('task manifest contract rejects cyclic slice and task DAGs', () => {
	const manifest = validTaskManifest();
	assert.throws(
		() =>
			validateTaskManifest({
				...manifest,
				slices: [
					{ ...manifest.slices[0], dependsOn: ['behavior'] },
					manifest.slices[1],
				],
			}),
		/dependency cycle/,
	);
	assert.throws(
		() =>
			validateTaskManifest({
				...manifest,
				tasks: [
					{ ...manifest.tasks[0], dependsOn: ['behavior-task'] },
					manifest.tasks[1],
				],
			}),
		/dependency cycle/,
	);
});

test('@ac AC-07 task manifest criteria have one non-enabling owner', () => {
	const manifest = validTaskManifest();
	assert.doesNotThrow(() =>
		validateTaskManifestAcceptanceCriteria(manifest, ['AC-01']),
	);
	assert.throws(
		() => validateTaskManifestAcceptanceCriteria(manifest, ['AC-01', 'AC-02']),
		/missing: AC-02/,
	);
	assert.throws(
		() =>
			validateTaskManifestAcceptanceCriteria(
				{
					...manifest,
					slices: [
						{ ...manifest.slices[0], acceptanceCriteria: ['AC-01'] },
						manifest.slices[1],
					],
				},
				['AC-01'],
			),
		(error) =>
			error.code === 'INVALID_CONTRACT' &&
			error.message.includes('enabling slice') &&
			error.message.includes('AC-01'),
	);
	assert.throws(
		() =>
			validateTaskManifestAcceptanceCriteria(
				{
					...manifest,
					slices: [
						manifest.slices[0],
						manifest.slices[1],
						{
							sliceId: 'duplicate-owner',
							kind: 'activation',
							goal: 'Activate behavior',
							acceptanceCriteria: ['AC-01'],
							dependsOn: ['behavior'],
						},
					],
					tasks: [
						...manifest.tasks,
						{
							...manifest.tasks[1],
							taskId: 'activation-task',
							sliceId: 'duplicate-owner',
							dependsOn: ['behavior-task'],
						},
					],
				},
				['AC-01'],
			),
		/duplicate: AC-01/,
	);
});

test('task manifest with no tasks fails closed', () => {
	const manifest = validTaskManifest();
	manifest.tasks = [];
	assert.throws(() => validateTaskManifest(manifest), /non-empty array/);
});
