import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTaskManifest, validateTaskManifestAcceptanceCriteria } from './planning-schema.ts';
import { TEST_FILE_PATTERN, isTestFilePath } from './primitives.ts';

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
				authoredPaths: [
					'tools/agent-sdlc/workflow/specification.mjs',
					'tools/agent-sdlc/workflow/specification.spec.mjs',
				],
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

test('@ac AC-01 a task manifest containing a non-enabling slice without any test-authoring task fails contract validation', () => {
	// AC-01.1: a vertical slice authoring only production code throws INVALID_CONTRACT
	const prodOnlyManifest = validTaskManifest();
	prodOnlyManifest.tasks[1] = {
		...prodOnlyManifest.tasks[1],
		authoredPaths: ['tools/agent-sdlc/workflow/specification.mjs'],
	};
	assert.throws(
		() => validateTaskManifestAcceptanceCriteria(prodOnlyManifest, ['AC-01']),
		(error) =>
			error.code === 'INVALID_CONTRACT' &&
			error.message.includes("taskManifest slice 'behavior' has no task authoring a test file matching TEST_FILE_PATTERN"),
	);

	// AC-01.2: a vertical slice authoring only shell scripts under tests throws INVALID_CONTRACT
	const shellOnlyManifest = validTaskManifest();
	shellOnlyManifest.tasks[1] = {
		...shellOnlyManifest.tasks[1],
		authoredPaths: ['tests/run.sh', 'tests/check.sh'],
	};
	assert.throws(
		() => validateTaskManifestAcceptanceCriteria(shellOnlyManifest, ['AC-01']),
		(error) =>
			error.code === 'INVALID_CONTRACT' &&
			error.message.includes("taskManifest slice 'behavior' has no task authoring a test file matching TEST_FILE_PATTERN"),
	);

	// AC-01.3: a vertical slice authoring only documentation throws INVALID_CONTRACT
	const docsOnlyManifest = validTaskManifest();
	docsOnlyManifest.tasks[1] = {
		...docsOnlyManifest.tasks[1],
		authoredPaths: ['docs/README.md', 'docs/config.json'],
	};
	assert.throws(
		() => validateTaskManifestAcceptanceCriteria(docsOnlyManifest, ['AC-01']),
		(error) =>
			error.code === 'INVALID_CONTRACT' &&
			error.message.includes("taskManifest slice 'behavior' has no task authoring a test file matching TEST_FILE_PATTERN"),
	);
});

test('@ac AC-02 enabling slices and slices with pooled test-authoring tasks pass contract validation', () => {
	// AC-02.1: an enabling slice requires no test file
	const enablingManifest = validTaskManifest();
	assert.equal(
		enablingManifest.tasks.some(
			(t) => t.sliceId === 'foundation' && t.authoredPaths.some(isTestFilePath),
		),
		false,
	);
	assert.doesNotThrow(() =>
		validateTaskManifestAcceptanceCriteria(enablingManifest, ['AC-01']),
	);

	// AC-02.2: a vertical slice with an implementation task and a sibling test-authoring task passes
	const pooledManifest = validTaskManifest();
	pooledManifest.tasks = [
		pooledManifest.tasks[0],
		{
			...pooledManifest.tasks[1],
			sliceId: 'behavior',
			taskId: 'impl-task',
			authoredPaths: ['tools/agent-sdlc/workflow/specification.mjs'],
		},
		{
			...pooledManifest.tasks[1],
			sliceId: 'behavior',
			taskId: 'test-task',
			dependsOn: ['impl-task'],
			authoredPaths: ['tools/agent-sdlc/workflow/specification.spec.mjs'],
		},
	];
	assert.doesNotThrow(() =>
		validateTaskManifestAcceptanceCriteria(pooledManifest, ['AC-01']),
	);

	// AC-02.3: a task producing a test file via generatedOutputs passes
	const generatedTestManifest = validTaskManifest();
	generatedTestManifest.tasks[1] = {
		...generatedTestManifest.tasks[1],
		authoredPaths: ['tools/agent-sdlc/workflow/specification.mjs'],
		generatedOutputs: ['tools/agent-sdlc/workflow/generated.spec.ts'],
		generatorCommand: ['pnpm', '--filter', '@fixture/billing-service', 'run', 'build:contracts'],
	};
	assert.doesNotThrow(() =>
		validateTaskManifestAcceptanceCriteria(generatedTestManifest, ['AC-01']),
	);
});

test('@ac AC-03 TEST_FILE_PATTERN and isTestFilePath accurately recognize test files and reject non-tests', () => {
	assert.ok(TEST_FILE_PATTERN.test('src/feature.spec.ts'));
	assert.ok(TEST_FILE_PATTERN.test('src/feature.test.js'));
	assert.ok(TEST_FILE_PATTERN.test('src/feature.spec.mjs'));
	assert.ok(TEST_FILE_PATTERN.test('src/feature.test.cjs'));
	assert.ok(TEST_FILE_PATTERN.test('src/feature.spec.tsx'));
	assert.ok(TEST_FILE_PATTERN.test('src/feature.test.jsx'));

	assert.equal(isTestFilePath('src/feature.spec.ts'), true);
	assert.equal(isTestFilePath('tests/run.sh'), false);
	assert.equal(isTestFilePath('tests/check.sh'), false);
	assert.equal(isTestFilePath('test/README.md'), false);
	assert.equal(isTestFilePath('src/feature.ts'), false);
	assert.equal(isTestFilePath(''), false);
	assert.equal(isTestFilePath(null), false);
	assert.equal(isTestFilePath(undefined), false);
	assert.equal(isTestFilePath(123), false);
});

test('@ac AC-04 touched contract, policy, execution, and test files remain within navigability ceilings', () => {
	const files = [
		'policy/contracts/primitives.ts',
		'policy/contracts.ts',
		'policy/contracts/planning-schema.ts',
		'execution/task-verification-plan.ts',
		'policy/contracts/planning-schema.spec.mjs',
		'policy/contracts.spec.mjs',
		'testing/deepen-contracts.spec.mjs',
		'testing/task-planner-fixtures.ts',
	];
	for (const rel of files) {
		const full = path.resolve(rel);
		const content = fs.readFileSync(full, 'utf8');
		const lineCount = content.split('\n').length;
		const byteCount = Buffer.byteLength(content, 'utf8');
		assert.ok(
			lineCount <= 500,
			`${rel} exceeded line ceiling: ${lineCount} > 500`,
		);
		assert.ok(
			byteCount <= 20480,
			`${rel} exceeded byte ceiling: ${byteCount} > 20480`,
		);
	}
});
