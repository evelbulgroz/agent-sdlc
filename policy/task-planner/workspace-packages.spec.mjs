import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
	contractArtifactPaths,
	isContractPreservingRefactor,
	isContractProducerSurface,
	missingContractCommands,
} from './workspace-packages.ts';
import { evaluateTaskReadiness } from './task-readiness.ts';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import {
	demoTask,
	evaluateDemo,
	readinessDraft,
	withDemoRoot,
} from '../../testing/task-planner-fixtures.mjs';

test('readiness reports every exceeded task dimension and aggregate score', () => {
	assert.throws(
		() =>
			evaluateTaskReadiness({
				draft: readinessDraft({
					touchedSurfaces: Array.from(
						{ length: 9 },
						(_, index) => `tools/agent-sdlc/file-${index}.mjs`,
					),
					acceptanceCriteria: Array.from(
						{ length: 6 },
						(_, index) =>
							`AC-${String(index + 1).padStart(2, '0')}: Criterion ${index + 1} holds. Given bounded input. Then output is deterministic.`,
					),
				}),
			}),
		(error) =>
			error.code === 'TASK_DECOMPOSITION_REQUIRED' &&
			error.message.includes('acceptanceCriteria=6') &&
			error.message.includes('authoredPaths=9'),
	);

	const manifest = {
		schemaVersion: '1.0.0',
		slices: [
			{
				sliceId: 'behavior',
				kind: 'vertical',
				goal: 'Deliver behavior',
				acceptanceCriteria: ['AC-01', 'AC-02', 'AC-03', 'AC-04', 'AC-05'],
				dependsOn: [],
			},
		],
		tasks: [
			{
				taskId: 'behavior-task',
				sliceId: 'behavior',
				targetPackage: 'tools',
				authoredPaths: [
					...Array.from(
						{ length: 7 },
						(_, index) => `tools/agent-sdlc/file-${index}.mjs`,
					),
					'tools/package.json',
				],
				pathPrefixes: ['tools/agent-sdlc'],
				generatedOutputs: [],
				dependsOn: [],
				deliveryLayers: ['tooling', 'documentation', 'configuration'],
				dependencyMutations: [
					{
						manifestPath: 'tools/package.json',
						dependencyName: 'example',
						fromRange: '1.0.0',
						toRange: '1.0.1',
					},
				],
				shadowPaths: {
					unhappy: 'failure',
					timeout: 'timeout',
					empty: 'empty',
					boundary: 'boundary',
				},
				verificationCommand: ['pnpm', 'run', 'agent:test-sdlc'],
				generatorCommand: null,
			},
		],
	};
	const scoreDraft = readinessDraft({
		touchedSurfaces: ['tools'],
		acceptanceCriteria: Array.from(
			{ length: 5 },
			(_, index) =>
				`AC-${String(index + 1).padStart(2, '0')}: Criterion ${index + 1} holds. Given bounded input. Then output is deterministic.`,
		),
	});

	assert.throws(
		() => evaluateTaskReadiness({ draft: scoreDraft, taskManifest: manifest }),
		(error) =>
			error.code === 'TASK_DECOMPOSITION_REQUIRED' &&
			error.message.includes('complexityScore=21'),
	);
});

test('isContractProducerSurface accurately detects contract paths', () => {
	assert.equal(isContractProducerSurface(['apps/services/conditioning/contracts/overview.dto.ts']), true);
	assert.equal(isContractProducerSurface(['apps/services/conditioning/src/contracts/index.ts']), true);
	assert.equal(isContractProducerSurface(['apps/services/conditioning/src/conditioning/entity.ts']), false);

	// With (pathPrefixes, targetPackage, pkgData) shape:
	const conditioningPkgData = {
		pkgJson: { scripts: { 'build:contracts': 'node build-contracts.mjs' } },
	};
	const registryPkgData = {
		pkgJson: { scripts: { 'build:types': 'tsc -p tsconfig.build.json' } },
	};
	const gatewayPkgData = {
		pkgJson: { scripts: { 'build:gateway-client': 'node build.mjs' } },
	};

	// 1. Non-contract service src task does NOT produce contracts
	assert.equal(
		isContractProducerSurface(
			['apps/services/conditioning/src/conditioning/entity.ts'],
			'apps/services/conditioning',
			conditioningPkgData,
		),
		false,
	);

	// 2. Package root prefix on contract-producing service produces contracts
	assert.equal(
		isContractProducerSurface(
			['apps/services/registry'],
			'apps/services/registry',
			registryPkgData,
		),
		true,
	);

	// 3. Gateway is consumer, not producer, even if package root is specified
	assert.equal(
		isContractProducerSurface(
			['apps/services/api-gateway'],
			'apps/services/api-gateway',
			gatewayPkgData,
		),
		false,
	);
});

test('isContractPreservingRefactor matches one criterion that both names and preserves a contract', () => {
	assert.equal(
		isContractPreservingRefactor({
			acceptanceCriteria: ['AC-01: The OpenAPI document must not change.'],
		}),
		true,
	);
	assert.equal(
		isContractPreservingRefactor({
			acceptanceCriteria: ['AC-01: OpenAPI lists the new field.'],
		}),
		false,
	);
	assert.equal(
		isContractPreservingRefactor({
			acceptanceCriteria: [
				'AC-01: OpenAPI documents the route.',
				'AC-02: The response shape must not grow.',
			],
		}),
		false,
	);
	assert.equal(
		isContractPreservingRefactor({
			acceptanceCriteria: ['AC-01: Zero consumer drift for readers.'],
		}),
		false,
	);
	assert.equal(
		isContractPreservingRefactor({
			goal: 'OpenAPI must not change.',
			acceptanceCriteria: ['AC-01: Readers keep working.'],
		}),
		false,
	);
	assert.equal(isContractPreservingRefactor(null), false);
	assert.equal(isContractPreservingRefactor({ acceptanceCriteria: [] }), false);
});

test('contractArtifactPaths reads the authentication drift script and fails closed otherwise', () => {
	const pkg = {
		scripts: {
			'check:contract-drift':
				'bash ../../../tools/check-contract-drift.sh apps/services/authentication openapi/authentication-service.openapi.json contracts/generated-api.ts',
		},
	};
	assert.deepEqual(contractArtifactPaths('apps/services/authentication', pkg), [
		'apps/services/authentication/openapi/authentication-service.openapi.json',
		'apps/services/authentication/contracts/generated-api.ts',
	]);
	assert.equal(
		contractArtifactPaths('apps/services/demo', {
			scripts: { 'check:contract-drift': 'node drift.js' },
		}),
		null,
	);
	assert.equal(contractArtifactPaths('apps/services/demo', { scripts: {} }), null);
});

test('a preserving sink that omits a controller or a contract artifact is TASK_PLAN_INVALID', () => {
	withDemoRoot((rootDir) => {
		const omittedController = demoTask({
			authoredPaths: [
				'apps/services/demo/src/a.controller.ts',
				'apps/services/demo/openapi/demo.openapi.json',
				'apps/services/demo/contracts/generated-api.ts',
			],
			pathPrefixes: [
				'apps/services/demo/src',
				'apps/services/demo/src/new.controller.ts',
			],
		});
		assert.throws(
			() =>
				evaluateDemo({
					criteria: ['AC-01: The OpenAPI document must not change.'],
					tasks: [omittedController],
					rootDir,
				}),
			(error) =>
				error.code === 'TASK_PLAN_INVALID' &&
				error.message.includes('b.controller.ts') &&
				error.message.includes('new.controller.ts'),
		);

		assert.throws(
			() =>
				evaluateDemo({
					criteria: ['AC-01: The OpenAPI document must not change.'],
					tasks: [
						demoTask({
							authoredPaths: ['apps/services/demo/src'],
							pathPrefixes: ['apps/services/demo/src'],
							generatedOutputs: [],
						}),
					],
					rootDir,
				}),
			(error) =>
				error.code === 'TASK_PLAN_INVALID' &&
				error.message.includes('demo.openapi.json'),
		);

		assert.throws(
			() =>
				evaluateDemo({
					criteria: ['AC-01: The OpenAPI document must not change.'],
					scripts: {
						test: 'node --test',
						'build:contracts': 'node build.mjs',
						'check:contract-drift': 'node drift.js',
					},
					tasks: [demoTask()],
					rootDir,
				}),
			(error) =>
				error.code === 'TASK_PLAN_INVALID' &&
				/must name the OpenAPI document and the generated contract/.test(error.message),
		);
	});
});

test('a directory prefix on the sink covers controllers and generated outputs cover artifacts', () => {
	withDemoRoot((rootDir) => {
		const foundation = demoTask({
			taskId: 'foundation-task',
			authoredPaths: ['apps/services/demo/src/helper.ts'],
			pathPrefixes: ['apps/services/demo/src/helper.ts'],
			deliveryLayers: ['domain'],
		});
		const sink = demoTask({
			dependsOn: ['foundation-task'],
			authoredPaths: ['apps/services/demo/src'],
			pathPrefixes: ['apps/services/demo/src'],
			generatedOutputs: [
				'apps/services/demo/openapi/demo.openapi.json',
				'apps/services/demo/contracts/generated-api.ts',
			],
			generatorCommand: [
				'pnpm',
				'--filter',
				'@example/demo-service',
				'run',
				'build:contracts',
			],
		});
		const readiness = evaluateDemo({
			criteria: ['AC-01: The OpenAPI document must not change.'],
			tasks: [foundation, sink],
			rootDir,
		});
		assert.equal(readiness.tasks.length, 2);

		assert.throws(
			() =>
				evaluateDemo({
					criteria: ['AC-01: The OpenAPI document must not change.'],
					tasks: [
						demoTask({
							taskId: 'foundation-task',
							authoredPaths: [
								'apps/services/demo/src',
								'apps/services/demo/openapi/demo.openapi.json',
								'apps/services/demo/contracts/generated-api.ts',
							],
							pathPrefixes: ['apps/services/demo/src'],
						}),
						demoTask({
							taskId: 'sink-task',
							dependsOn: ['foundation-task'],
							authoredPaths: ['apps/services/demo/src/helper.ts'],
							pathPrefixes: ['apps/services/demo/src/helper.ts'],
							deliveryLayers: ['domain'],
						}),
					],
					rootDir,
				}),
			(error) =>
				error.code === 'TASK_PLAN_INVALID' && error.message.includes("Task 'sink-task'"),
		);
	});
});

test('a non-preserving spec and a package without both contract scripts stay valid', () => {
	withDemoRoot((rootDir) => {
		const tasks = [
			demoTask({
				authoredPaths: ['apps/services/demo/src/a.controller.ts'],
				pathPrefixes: ['apps/services/demo/src'],
			}),
		];
		assert.equal(
			evaluateDemo({
				criteria: [
					'AC-01: Bounded behavior is planned. Given a complete host specification. Then readiness is deterministic.',
				],
				tasks,
				rootDir,
			}).tasks.length,
			1,
		);
		assert.equal(
			evaluateDemo({
				criteria: ['AC-01: OpenAPI lists the new field.'],
				tasks,
				rootDir,
			}).tasks.length,
			1,
		);
		assert.equal(
			evaluateDemo({
				criteria: ['AC-01: Zero consumer drift for readers.'],
				tasks,
				rootDir,
			}).tasks.length,
			1,
		);
		assert.equal(
			evaluateDemo({
				criteria: [
					'AC-01: OpenAPI documents the route.',
					'AC-02: The response shape must not grow.',
				],
				tasks,
				rootDir,
				criterionIds: ['AC-01', 'AC-02'],
			}).tasks.length,
			1,
		);
		assert.equal(
			evaluateDemo({
				criteria: ['AC-01: The OpenAPI document must not change.'],
				scripts: { test: 'node --test' },
				tasks,
				rootDir,
			}).tasks.length,
			1,
		);
	});
});

test('missingContractCommands requires each argv to pass after the latest write', () => {
	const quality = ['pnpm', 'run', 'quality:changed'];
	const drift = ['pnpm', '--filter', '@example/demo-service', 'run', 'check:contract-drift'];
	const commandItem = (argv, stepIndex, result) => ({
		toolName: 'run_allowlisted_command',
		stepIndex,
		parameters: { command: argv[0], args: argv.slice(1) },
		result,
	});

	assert.deepEqual(
		missingContractCommands({
			toolHistory: [],
			commands: [quality],
			lastSubstantiveWriteStep: -1,
		}),
		[quality],
	);
	assert.deepEqual(
		missingContractCommands({
			toolHistory: [commandItem(quality, 0, { exitCode: 0 })],
			commands: [quality],
			lastSubstantiveWriteStep: -1,
		}),
		[],
	);
	assert.deepEqual(
		missingContractCommands({
			toolHistory: [commandItem(quality, 1, { exitCode: 0 })],
			commands: [quality, drift],
			lastSubstantiveWriteStep: -1,
		}),
		[drift],
	);
	assert.deepEqual(
		missingContractCommands({
			toolHistory: [commandItem(quality, 1, { exitCode: 0 })],
			commands: [quality],
			lastSubstantiveWriteStep: 2,
		}),
		[quality],
	);
	assert.deepEqual(
		missingContractCommands({
			toolHistory: [
				commandItem(quality, 1, { exitCode: 0 }),
				commandItem(quality, 3, { exitCode: 1, error: 'failed' }),
			],
			commands: [quality],
			lastSubstantiveWriteStep: -1,
		}),
		[quality],
	);
	assert.deepEqual(missingContractCommands({ commands: null }), []);
	assert.deepEqual(missingContractCommands({ commands: [] }), []);
});
