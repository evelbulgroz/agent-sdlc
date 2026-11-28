import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	resolveAcceptanceEvidenceCommand,
	resolveTargetedVerificationCommand,
	resolveTaskVerificationCommand,
	resolveTaskVerificationContext,
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
		targetPackage: 'frontends/example',
		authoredPaths: [
			'frontends/example/src/ui/Page.tsx',
			'frontends/example/src/ui/Page.spec.tsx',
		],
		verificationCommand: ['pnpm', '--filter', '@fixture/example', 'test'],
	};
	assert.deepEqual(
		resolveTargetedVerificationCommand(task, {
			scripts: { test: 'vitest run' },
		}),
		[
			'pnpm',
			'--filter',
			'@fixture/example',
			'test',
			'--',
			'src/ui/Page.spec.tsx',
		],
	);
	assert.equal(
		resolveTargetedVerificationCommand(
			{ ...task, authoredPaths: ['frontends/example/src/ui/Page.tsx'] },
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
			'@fixture/example',
			'test',
			'--',
			'src/ui/Page.spec.tsx',
		],
	);
	assert.deepEqual(
		resolveTargetedVerificationCommand(task, {
			name: '@fixture/example',
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
			'@fixture/example',
			'run',
			'test:unit',
			'src/ui/Page.spec.tsx',
		],
	);
	assert.deepEqual(
		resolveTargetedVerificationCommand(
			{
				...task,
				verificationCommand: ['pnpm', '--filter', '@fixture/example', 'run', 'test:unit'],
			},
			{
				name: '@fixture/example',
				scripts: {
					test: 'pnpm run test:unit && pnpm run test:integration',
					'test:unit': 'cross-env NODE_ENV=test vitest run --config vitest.config.ts',
				},
			},
		),
		[
			'pnpm',
			'--filter',
			'@fixture/example',
			'run',
			'test:unit',
			'src/ui/Page.spec.tsx',
		],
	);
});

test('@ac AC-01 AC-04 derives closed JSON evidence commands for supported test runners', () => {
	const task = {
		targetPackage: 'frontends/example',
		authoredPaths: ['frontends/example/src/ui/Page.spec.tsx'],
		verificationCommand: ['pnpm', '--filter', '@fixture/example', 'test'],
	};
	assert.deepEqual(
		resolveAcceptanceEvidenceCommand(task, {
			scripts: { test: 'vitest run' },
		}),
		[
			'pnpm',
			'--filter',
			'@fixture/example',
			'test',
			'--',
			'src/ui/Page.spec.tsx',
			'--reporter=json',
		],
	);
	assert.deepEqual(
		resolveAcceptanceEvidenceCommand(task, {
			name: '@fixture/example',
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
			'@fixture/example',
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
			'@fixture/example',
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
			'@fixture/example',
			'test',
			'--',
			'src/ui/Page.spec.tsx',
		],
	);
});

test('@ac AC-01 @case AC-01.1 @case AC-01.2 a registered unit argv is used verbatim', () => {
	const task = {
		targetPackage: 'frontends/example',
		authoredPaths: ['frontends/example/src/ui/Page.spec.tsx'],
		verificationCommand: ['pnpm', '--filter', '@fixture/example', 'test'],
	};
	const registered = ['pnpm', 'run', 'test:unit'];
	const packageJson = {
		scripts: { test: 'vitest run && node --test scripts/evidence.spec.mjs', posttest: 'node scripts/posttest-sentinel.mjs' },
	};
	const argv = resolveAcceptanceEvidenceCommand(task, packageJson, registered);
	assert.deepEqual(argv, registered);
	assert.equal(argv.includes('--reporter=json'), false);
	assert.equal(argv.includes('src/ui/Page.spec.tsx'), false);
	assert.equal(argv.includes('vitest'), false);
	assert.equal(argv.some((token) => token.includes('posttest')), false);
	const withPlaceholder = ['pnpm', 'run', 'test:unit', '{reportPath}'];
	assert.deepEqual(
		resolveAcceptanceEvidenceCommand(task, packageJson, withPlaceholder),
		withPlaceholder,
	);
});

test('@ac AC-02 @case AC-02.1 @case AC-02.2 a compound test script gains neither a reporter nor a spec path', () => {
	const task = {
		targetPackage: 'frontends/example',
		authoredPaths: ['frontends/example/src/ui/Page.spec.tsx'],
		verificationCommand: ['pnpm', '--filter', '@fixture/example', 'test'],
	};
	const argv = resolveAcceptanceEvidenceCommand(task, {
		scripts: {
			test: 'vitest run && node --test scripts/evidence.spec.mjs',
			posttest: 'node scripts/posttest-sentinel.mjs',
		},
	});
	assert.deepEqual(argv, ['pnpm', '--filter', '@fixture/example', 'test']);
	assert.equal(argv.includes('--reporter=json'), false);
	assert.equal(argv.includes('scripts/evidence.spec.mjs'), false);
	assert.equal(argv.includes('src/ui/Page.spec.tsx'), false);
	assert.equal(argv.some((token) => token.includes('posttest')), false);
});

test('@ac AC-03 @case AC-03.1 @case AC-03.2 a single Vitest script still ends with the JSON reporter', () => {
	const task = {
		targetPackage: 'frontends/example',
		authoredPaths: ['frontends/example/src/ui/Page.spec.tsx'],
		verificationCommand: ['pnpm', '--filter', '@fixture/example', 'test'],
	};
	const argv = resolveAcceptanceEvidenceCommand(task, {
		scripts: {
			test: 'vitest run',
			posttest: 'node scripts/posttest-sentinel.mjs',
		},
	});
	assert.equal(argv.at(-1), '--reporter=json');
	assert.equal(argv.filter((token) => token === '--reporter=json').length, 1);
	assert.equal(argv.some((token) => token.includes('posttest')), false);
});

test('an empty registered unit argv is rejected and a command outside the allowlist is rejected before spawn', () => {
	const task = {
		targetPackage: 'frontends/example',
		authoredPaths: ['frontends/example/src/ui/Page.spec.tsx'],
		verificationCommand: ['pnpm', '--filter', '@fixture/example', 'test'],
	};
	const packageJson = { scripts: { test: 'vitest run' } };
	assert.throws(
		() => resolveAcceptanceEvidenceCommand(task, packageJson, []),
		(err) => err.code === 'INVALID_INPUT' && err.message.includes('empty'),
	);
	assert.throws(
		() => resolveAcceptanceEvidenceCommand(task, packageJson, ['pnpm', 'run', 'publish']),
		(err) => err.code === 'INVALID_INPUT',
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
	const verificationCommand = ['pnpm', '--filter', '@fixture/billing-service', 'test'];
	const packageJson = {
		name: '@fixture/billing-service',
		scripts: { build: 'nest build', test: 'vitest run' },
	};
	const build = ['pnpm', '--filter', '@fixture/billing-service', 'run', 'build'];
	assert.deepEqual(resolveTaskVerificationSequence({ verificationCommand }, packageJson), [
		verificationCommand,
		build,
	]);
	assert.deepEqual(
		resolveTaskVerificationSequence(
			{
				verificationCommand,
				generatorCommand: ['pnpm', '--filter', '@fixture/billing-service', 'run', 'build:contracts'],
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
	const verificationCommand = ['pnpm', '--filter', '@fixture/demo-service', 'test'];
	const base = resolveTaskVerificationSequence({ verificationCommand });
	assert.deepEqual(withContractPreservationCommands(base, null), base);
	assert.deepEqual(withContractPreservationCommands(base, {}), base);
	const extra = [
		['pnpm', '--filter', '@fixture/demo-service', 'run', 'build:contracts'],
		['pnpm', '--filter', '@fixture/demo-service', 'run', 'check:contract-drift'],
		['pnpm', 'run', 'quality:affected'],
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

const ac = (id, outcome) => `${id}: ${outcome}. Given the fixture. Then the result holds.`;
const UNIT = 'frontends/example/src/ui/Page.spec.tsx';
const E2E = 'frontends/example/e2e/session-actions.spec.ts';
const UNIT_TITLE = 'renders @ac AC-01';
const E2E_TITLE = 'saves @ac AC-02';
const BOTH = [ac('AC-01', 'Unit page renders'), ac('AC-02', 'Browser session saves')];
const FILTER = ['pnpm', '--filter', '@fixture/example', 'test'];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-'));

function writeSpec(root, relativePath, title, body = 'expect(1).toBe(1);') {
	const full = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, `import { expect, it } from 'vitest';\nit(${JSON.stringify(title)}, () => { ${body} });\n`);
}
function invoke(validator, command, title, file = UNIT) {
	const rows = title ? [{ status: 'passed', title, fullName: title }] : [];
	const stdout = JSON.stringify({ testResults: [{ name: file, assertionResults: rows }] });
	return validator({ state: { lastSubstantiveWriteStep: 1, toolHistory: [{ toolName: 'run_allowlisted_command', stepIndex: 2, parameters: { command: command[0], args: command.slice(1) }, result: { exitCode: 0, stdout, stderr: '' } }] } });
}
function context(root, scripts, authoredPaths, criteria, task = {}, taskPlan = null) {
	const dir = path.join(root, 'frontends/example');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@fixture/example', scripts }));
	return resolveTaskVerificationContext({
		task: { taskId: 'mixed', targetPackage: 'frontends/example', pathPrefixes: ['frontends/example'], authoredPaths, verificationCommand: FILTER, ...task },
		taskPlan, worktreeDir: root, acceptanceCriteria: criteria,
	});
}
function expectIds(result, pass, key, ids) {
	assert.equal(result.evidenceMissing, false);
	assert.equal(result.pass, pass);
	assert.deepEqual(result.coverage[key], ids);
}

test('@ac AC-01 @case AC-01.1 @case AC-01.2 @case AC-01.3 @case AC-01.4 package e2e specs are omitted from a unit runner', () => {
	const pkg = 'frontends/pwa';
	const scripts = { test: 'cross-env NODE_ENV=test vitest run', 'test:e2e': 'playwright test' };
	const declared = ['pnpm', '--filter', '@fixture/pwa', 'test'];
	const task = { taskId: 'e2e', targetPackage: pkg, pathPrefixes: [pkg], verificationCommand: declared, authoredPaths: [`${pkg}/e2e/session-data-sources.spec.ts`, `${pkg}/e2e/session-actions.spec.ts`] };
	for (const candidate of [task, { ...task, authoredPaths: [`${pkg}/e2e\\flow.spec.ts`] }]) {
		assert.equal(resolveTargetedVerificationCommand(candidate, { scripts }), null);
		assert.equal(resolveAcceptanceEvidenceCommand(candidate, { scripts }), null);
	}
	assert.deepEqual(resolveTaskVerificationCommand(task, { scripts }), declared);
	const root = tmp();
	fs.mkdirSync(path.join(root, pkg), { recursive: true });
	fs.writeFileSync(path.join(root, pkg, 'package.json'), JSON.stringify({ name: '@fixture/pwa', scripts }));
	assert.equal(resolveTaskVerificationContext({
		task, worktreeDir: root, acceptanceCriteria: [ac('AC-01', 'Browser session saves')],
	}).completionValidator, null);
	const onlyE2e = { targetPackage: 'frontends/example', authoredPaths: ['frontends/example/e2e/session.spec.ts'], verificationCommand: FILTER };
	const compound = { name: '@fixture/example', scripts: { test: 'vitest run && pnpm run test:e2e', 'test:e2e': 'playwright test' } };
	assert.equal(resolveTargetedVerificationCommand(onlyE2e, compound), null);
	assert.equal(resolveAcceptanceEvidenceCommand(onlyE2e, compound), null);
});

test('@ac AC-02 @case AC-02.1 @case AC-02.2 @case AC-02.3 a unit-runner test:e2e keeps its reporter', () => {
	const pkg = 'frontends/example';
	const paths = ['e2e/session-data-sources.spec.ts', 'e2e/session-actions.spec.ts'];
	const task = { taskId: 'e2e', targetPackage: pkg, pathPrefixes: [pkg], verificationCommand: FILTER, authoredPaths: paths.map((file) => `${pkg}/${file}`) };
	const base = ['pnpm', '--filter', '@fixture/example', 'run', 'test:e2e', ...paths];
	const evidence = (script) => resolveAcceptanceEvidenceCommand(task, {
		name: '@fixture/example', scripts: { test: 'vitest run', 'test:e2e': script },
	});
	assert.deepEqual(evidence('vitest run --config vitest.e2e.config.ts'), [...base, '--reporter=json']);
	assert.deepEqual(evidence('jest'), [...base, '--json']);
	assert.deepEqual(evidence('node --test'), base);
});

test('@ac AC-03 @case AC-03.1 @case AC-03.2 unit specs keep the Vitest evidence command', () => {
	const argv = resolveAcceptanceEvidenceCommand({
		taskId: 'unit', targetPackage: 'frontends/example', pathPrefixes: ['frontends/example'],
		authoredPaths: [UNIT], verificationCommand: FILTER,
	}, { scripts: { test: 'vitest run' } });
	assert.deepEqual(argv, [...FILTER, '--', 'src/ui/Page.spec.tsx', '--reporter=json']);
	assert.equal(argv.some((token) => token.includes('e2e/')), false);
});

test('@ac AC-04 @case AC-04.1 @case AC-04.2 @case AC-04.3 @case AC-04.4 @case AC-04.5 @case AC-04.6 @case AC-04.7 mixed tasks complete on unit evidence', () => {
	const scripts = { test: 'vitest run', 'test:e2e': 'playwright test' };
	const task = { taskId: 'mixed', targetPackage: 'frontends/example', pathPrefixes: ['frontends/example'], authoredPaths: [UNIT, E2E], verificationCommand: FILTER };
	for (const argv of [resolveTargetedVerificationCommand(task, { scripts }), resolveAcceptanceEvidenceCommand(task, { name: '@fixture/example', scripts })]) {
		assert.equal(argv.includes('src/ui/Page.spec.tsx'), true);
		assert.equal(argv.includes('e2e/session-actions.spec.ts'), false);
	}
	const root = tmp();
	writeSpec(root, UNIT, UNIT_TITLE);
	writeSpec(root, E2E, E2E_TITLE);
	const ctx = context(root, scripts, [UNIT, E2E], BOTH);
	assert.equal(ctx.completionValidator.staticCheck(), null);
	expectIds(invoke(ctx.completionValidator, ctx.acceptanceEvidenceCommand, UNIT_TITLE), true, 'notExecutedAcIds', []);
	writeSpec(root, E2E, E2E_TITLE, '');
	assert.equal(ctx.completionValidator.staticCheck(), null);
	expectIds(invoke(ctx.completionValidator, ctx.acceptanceEvidenceCommand, UNIT_TITLE), true, 'notExecutedAcIds', []);
	assert.equal(ctx.completionValidator.staticCheck(), null);
	expectIds(invoke(ctx.completionValidator, ctx.acceptanceEvidenceCommand, null), false, 'notExecutedAcIds', ['AC-01']);
	writeSpec(root, UNIT, 'renders without a citation');
	const only = context(root, scripts, [UNIT, E2E], [BOTH[1]]);
	assert.equal(only.completionValidator.staticCheck(), null);
	assert.equal(only.completionValidator({ state: { toolHistory: [], lastSubstantiveWriteStep: 1 } }).pass, true);
	const earlyRoot = tmp();
	const early = context(earlyRoot, scripts, [UNIT, E2E], BOTH);
	writeSpec(earlyRoot, UNIT, UNIT_TITLE);
	writeSpec(earlyRoot, E2E, E2E_TITLE);
	expectIds(invoke(early.completionValidator, early.acceptanceEvidenceCommand, null), false, 'notExecutedAcIds', ['AC-01']);
	writeSpec(root, UNIT, UNIT_TITLE);
	writeSpec(root, E2E, 'browser without a citation');
	const uncited = context(root, scripts, [UNIT, E2E], BOTH);
	expectIds(invoke(uncited.completionValidator, uncited.acceptanceEvidenceCommand, UNIT_TITLE), false, 'uncoveredAcIds', ['AC-02']);
	const siblingRoot = tmp();
	writeSpec(siblingRoot, UNIT, UNIT_TITLE);
	writeSpec(siblingRoot, E2E, E2E_TITLE);
	const sibling = context(siblingRoot, scripts, [UNIT], BOTH, { taskId: 'unit', sliceId: 'slice' }, { tasks: [{ taskId: 'browser', sliceId: 'slice', status: 'completed', targetPackage: 'frontends/example', pathPrefixes: ['frontends/example'], authoredPaths: [E2E] }] });
	assert.equal(sibling.acceptanceEvidenceCommand.includes('e2e/session-actions.spec.ts'), false);
	expectIds(invoke(sibling.completionValidator, sibling.acceptanceEvidenceCommand, UNIT_TITLE), true, 'notExecutedAcIds', []);
});

test('@ac AC-05 @case AC-05.1 @case AC-05.2 @case AC-05.3 @case AC-05.4 untargeted commands keep uncited criteria', () => {
	const pkg = 'frontends/pwa';
	const registered = ['pnpm', 'run', 'test:unit'];
	const task = { taskId: 'e2e', targetPackage: pkg, pathPrefixes: [pkg], verificationCommand: ['pnpm', '--filter', '@fixture/pwa', 'test'], authoredPaths: [`${pkg}/e2e/session-data-sources.spec.ts`, `${pkg}/e2e/session-actions.spec.ts`] };
	assert.deepEqual(resolveAcceptanceEvidenceCommand(task, { scripts: { test: 'vitest run' } }, registered), registered);
	assert.equal(resolveTargetedVerificationCommand({
		taskId: 'name', targetPackage: 'frontends/example', pathPrefixes: ['frontends/example'],
		authoredPaths: ['frontends/example/src/flow.e2e-spec.ts'], verificationCommand: FILTER,
	}, { name: '@fixture/example', scripts: { test: 'pnpm run test:unit && pnpm run test:e2e', 'test:e2e': 'vitest run --config vitest.e2e.config.ts' } }), null);
	const root = tmp();
	writeSpec(root, UNIT, UNIT_TITLE);
	const compound = context(root, { test: 'vitest run && node --test scripts/evidence.spec.mjs' }, [UNIT], BOTH);
	assert.deepEqual(compound.acceptanceEvidenceCommand, FILTER);
	expectIds(invoke(compound.completionValidator, compound.acceptanceEvidenceCommand, UNIT_TITLE), false, 'uncoveredAcIds', ['AC-02']);
	const repoRoot = tmp();
	writeSpec(repoRoot, 'docs/example.spec.mjs', UNIT_TITLE);
	const repo = resolveTaskVerificationContext({
		task: { taskId: 'repo', targetPackage: 'docs', pathPrefixes: ['docs'], authoredPaths: ['docs/example.spec.mjs'], verificationCommand: registered },
		worktreeDir: repoRoot, acceptanceCriteria: BOTH,
	});
	assert.deepEqual(repo.acceptanceEvidenceCommand, registered);
	assert.notEqual(repo.completionValidator, null);
	expectIds(invoke(repo.completionValidator, repo.acceptanceEvidenceCommand, UNIT_TITLE, 'docs/example.spec.mjs'), false, 'uncoveredAcIds', ['AC-02']);
});
