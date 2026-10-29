import assert from 'node:assert/strict';
import test from 'node:test';
import {
	resolveAcceptanceEvidenceCommand,
	resolveTargetedVerificationCommand,
	resolveTaskVerificationCommand,
	resolveTaskVerificationSequence,
	resolveTestFrameworkGuidance,
	withContractPreservationCommands,
} from './task-verification-plan.ts';

test('Vitest task guidance requires explicit API imports', () => {
	assert.match(
		resolveTestFrameworkGuidance('vitest run --config vitest.config.ts'),
		/import \{ describe, expect, it \} from 'vitest'/,
	);
	assert.equal(resolveTestFrameworkGuidance('jest --runInBand'), null);
	assert.doesNotMatch(
		resolveTestFrameworkGuidance('vitest run', {
			devDependencies: { vitest: '^3.0.0' },
		}),
		/@vitest-environment jsdom/,
	);
	assert.match(
		resolveTestFrameworkGuidance('vitest run', {
			devDependencies: {
				'@testing-library/react': '^16.0.0',
				vitest: '^3.0.0',
			},
		}),
		/@vitest-environment jsdom/,
	);
});

test('@ac AC-04 derives targeted Jest or Vitest verification from authored tests', () => {
	const task = {
		targetPackage: 'apps/frontends/example',
		authoredPaths: [
			'apps/frontends/example/src/ui/Page.tsx',
			'apps/frontends/example/src/ui/Page.spec.tsx',
		],
		verificationCommand: ['pnpm', '--filter', '@example/example', 'test'],
	};
	assert.deepEqual(
		resolveTargetedVerificationCommand(task, {
			scripts: { test: 'vitest run' },
		}),
		[
			'pnpm',
			'--filter',
			'@example/example',
			'test',
			'--',
			'src/ui/Page.spec.tsx',
		],
	);
	assert.equal(
		resolveTargetedVerificationCommand(
			{ ...task, authoredPaths: ['apps/frontends/example/src/ui/Page.tsx'] },
			{ scripts: { test: 'vitest run' } },
		),
		null,
	);
	assert.deepEqual(
		resolveTargetedVerificationCommand(task, {
			scripts: { test: 'node --test' },
		}),
		[
			'pnpm',
			'--filter',
			'@example/example',
			'test',
			'--',
			'src/ui/Page.spec.tsx',
		],
	);
	assert.deepEqual(
		resolveTargetedVerificationCommand(task, {
			name: '@example/example',
			scripts: {
				test: 'pnpm run test:unit && pnpm run test:integration',
				'test:unit': 'cross-env NODE_ENV=test vitest run --config vitest.config.ts',
				'test:integration':
					'cross-env NODE_ENV=test vitest run --config vitest.integration.config.ts',
			},
		}),
		[
			'pnpm',
			'--filter',
			'@example/example',
			'run',
			'test:unit',
			'src/ui/Page.spec.tsx',
		],
	);
	assert.deepEqual(
		resolveTargetedVerificationCommand(
			{
				...task,
				verificationCommand: ['pnpm', '--filter', '@example/example', 'run', 'test:unit'],
			},
			{
				name: '@example/example',
				scripts: {
					test: 'pnpm run test:unit && pnpm run test:integration',
					'test:unit': 'cross-env NODE_ENV=test vitest run --config vitest.config.ts',
				},
			},
		),
		[
			'pnpm',
			'--filter',
			'@example/example',
			'run',
			'test:unit',
			'src/ui/Page.spec.tsx',
		],
	);
});

test('@ac AC-01 AC-04 derives closed JSON evidence commands for supported test runners', () => {
	const task = {
		targetPackage: 'apps/frontends/example',
		authoredPaths: ['apps/frontends/example/src/ui/Page.spec.tsx'],
		verificationCommand: ['pnpm', '--filter', '@example/example', 'test'],
	};
	assert.deepEqual(
		resolveAcceptanceEvidenceCommand(task, {
			scripts: { test: 'vitest run' },
		}),
		[
			'pnpm',
			'--filter',
			'@example/example',
			'test',
			'--',
			'src/ui/Page.spec.tsx',
			'--reporter=json',
		],
	);
	assert.deepEqual(
		resolveAcceptanceEvidenceCommand(task, {
			name: '@example/example',
			scripts: {
				test: 'pnpm run test:unit && pnpm run test:integration',
				'test:unit': 'cross-env NODE_ENV=test vitest run --config vitest.config.ts',
				'test:integration':
					'cross-env NODE_ENV=test vitest run --config vitest.integration.config.ts',
			},
		}),
		[
			'pnpm',
			'--filter',
			'@example/example',
			'run',
			'test:unit',
			'src/ui/Page.spec.tsx',
			'--reporter=json',
		],
	);
	assert.deepEqual(
		resolveAcceptanceEvidenceCommand(task, {
			scripts: { test: 'jest' },
		}),
		[
			'pnpm',
			'--filter',
			'@example/example',
			'test',
			'--',
			'src/ui/Page.spec.tsx',
			'--json',
		],
	);
	assert.deepEqual(
		resolveAcceptanceEvidenceCommand(task, {
			scripts: { test: 'node --test' },
		}),
		[
			'pnpm',
			'--filter',
			'@example/example',
			'test',
			'--',
			'src/ui/Page.spec.tsx',
		],
	);
});

test('repository-scoped tasks retain their exact declared verification command without package metadata', () => {
	const task = {
		targetPackage: 'docs',
		authoredPaths: ['tools/agent-sdlc/example.spec.mjs'],
		verificationCommand: ['pnpm', 'run', 'test:unit'],
	};
	assert.deepEqual(resolveTaskVerificationCommand(task, {}), [
		'pnpm',
		'run',
		'test:unit',
	]);
	assert.deepEqual(resolveAcceptanceEvidenceCommand(task, {}), [
		'pnpm',
		'run',
		'test:unit',
	]);
});

test('verification sequence runs the declared generator before the verification command', () => {
	const generatorCommand = ['pnpm', '--filter', 'pkg', 'run', 'build:contracts'];
	const verificationCommand = ['pnpm', '--filter', 'pkg', 'test'];
	assert.deepEqual(resolveTaskVerificationSequence({ generatorCommand, verificationCommand }), [
		generatorCommand,
		verificationCommand,
	]);
	assert.deepEqual(resolveTaskVerificationSequence({ verificationCommand }), [verificationCommand]);
	assert.deepEqual(resolveTaskVerificationSequence({ generatorCommand: null }, {}), []);
});

test('verification sequence appends the package build when the package defines one', () => {
	const verificationCommand = ['pnpm', '--filter', '@example/conditioning-service', 'test'];
	const packageJson = {
		name: '@example/conditioning-service',
		scripts: { build: 'nest build', test: 'vitest run' },
	};
	const build = ['pnpm', '--filter', '@example/conditioning-service', 'run', 'build'];
	assert.deepEqual(resolveTaskVerificationSequence({ verificationCommand }, packageJson), [
		verificationCommand,
		build,
	]);
	assert.deepEqual(
		resolveTaskVerificationSequence(
			{
				verificationCommand,
				generatorCommand: ['pnpm', '--filter', '@example/conditioning-service', 'run', 'build:contracts'],
			},
			packageJson,
		).at(-1),
		build,
	);
	assert.deepEqual(resolveTaskVerificationSequence({ verificationCommand: build }, packageJson), [build]);
	assert.deepEqual(
		resolveTaskVerificationSequence({ verificationCommand }, { name: 'pkg', scripts: { test: 'vitest run' } }),
		[verificationCommand],
	);
});

test('withContractPreservationCommands appends sink checks and leaves a plain sequence unchanged', () => {
	const verificationCommand = ['pnpm', '--filter', '@example/demo-service', 'test'];
	const base = resolveTaskVerificationSequence({ verificationCommand });
	assert.deepEqual(withContractPreservationCommands(base, null), base);
	assert.deepEqual(withContractPreservationCommands(base, {}), base);
	const extra = [
		['pnpm', '--filter', '@example/demo-service', 'run', 'build:contracts'],
		['pnpm', '--filter', '@example/demo-service', 'run', 'check:contract-drift'],
		['pnpm', 'run', 'quality:changed'],
	];
	assert.deepEqual(
		withContractPreservationCommands(base, { contractVerificationCommands: extra }),
		[...base, ...extra],
	);
	assert.deepEqual(
		withContractPreservationCommands([...base, extra[0]], { contractVerificationCommands: extra }),
		[...base, ...extra],
	);
});
