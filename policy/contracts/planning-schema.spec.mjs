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
				verificationCommand: ['pnpm', 'run', 'test:unit'],
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
				verificationCommand: ['pnpm', 'run', 'test:unit'],
				generatorCommand: null,
			},
		],
	};
}

test('task manifest contract validates closed slices, tasks, commands, and nested records', () => {
	const manifest = validTaskManifest();
	const parsed = validateTaskManifest(manifest);
	assert.equal(parsed.slices.length, 2);
	assert.equal(parsed.tasks[1].verificationCommand[2], 'test:unit');
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
		'@fixture/billing-service',
		'run',
		'test:unit',
	];
	assert.doesNotThrow(() => validateTaskManifest(unitManifest));

	const intManifest = validTaskManifest();
	intManifest.tasks[1].verificationCommand = [
		'pnpm',
		'--filter',
		'@fixture/billing-service',
		'run',
		'test:integration',
	];
	assert.doesNotThrow(() => validateTaskManifest(intManifest));

	const generatorManifest = validTaskManifest();
	generatorManifest.tasks[1].generatorCommand = [
		'pnpm',
		'--filter',
		'@fixture/billing-service',
		'run',
		'build:contracts',
	];
	generatorManifest.tasks[1].generatedOutputs = [
		'services/billing/openapi/billing-service.openapi.json',
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

test('removedPaths is optional and accepts only covered files outside the write set', () => {
	const omitted = validateTaskManifest(validTaskManifest());
	assert.equal(omitted.tasks[0].removedPaths, undefined);

	const covered = validTaskManifest();
	covered.tasks[0] = {
		...covered.tasks[0],
		pathPrefixes: ['tools/agent-sdlc', 'tools/agent-sdlc/policy/legacy.mjs'],
		removedPaths: ['tools/agent-sdlc/policy/legacy.mjs', 'tools/agent-sdlc/policy/other.ts'],
	};
	assert.deepEqual(validateTaskManifest(covered).tasks[0].removedPaths, [
		'tools/agent-sdlc/policy/legacy.mjs',
		'tools/agent-sdlc/policy/other.ts',
	]);

	const rejected = [
		{ removedPaths: ['tools/agent-sdlc'], message: /directory/ },
		{ removedPaths: ['elsewhere/file.ts'], message: /outside pathPrefixes/ },
		{ removedPaths: ['tools/agent-sdlc/policy/contracts.mjs'], message: /overlaps/ },
		{ removedPaths: [''], message: /non-empty/ },
		{ removedPaths: ['tools/agent-sdlc/a.ts', 'tools/agent-sdlc/a.ts'], message: /duplicate/ },
		{ removedPaths: ['/tmp/a.ts'], message: /non-repository-relative/ },
		{ removedPaths: ['tools/../a.ts'], message: /non-repository-relative/ },
		{ removedPaths: ['tools/./a.ts'], message: /non-repository-relative/ },
		{
			removedPaths: Array.from({ length: 9 }, (_, index) => `tools/agent-sdlc/file-${index}.ts`),
			message: /at most 8/,
		},
	];
	for (const item of rejected) {
		const manifest = validTaskManifest();
		manifest.tasks[0] = { ...manifest.tasks[0], removedPaths: item.removedPaths };
		assert.throws(() => validateTaskManifest(manifest), item.message);
	}

	const generated = validTaskManifest();
	generated.tasks[0] = {
		...generated.tasks[0],
		generatedOutputs: ['tools/agent-sdlc/generated/out.ts'],
		generatorCommand: ['pnpm', '--filter', '@fixture/billing-service', 'run', 'build:contracts'],
		removedPaths: ['tools/agent-sdlc/generated/out.ts'],
	};
	assert.throws(() => validateTaskManifest(generated), /overlaps/);
});

test('optional retirement boolean survives manifest validation', () => {
	const manifest = validTaskManifest();
	manifest.tasks[1] = { ...manifest.tasks[1], retirement: true };
	const parsed = validateTaskManifest(manifest);
	assert.equal(parsed.tasks[1].retirement, true);
	assert.equal(parsed.tasks[0].retirement, undefined);
	assert.throws(
		() => validateTaskManifest({
			...manifest,
			tasks: [{ ...manifest.tasks[0], retirement: 'yes' }],
		}),
		/retirement must be a boolean/,
	);
});
