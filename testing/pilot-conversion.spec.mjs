import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { listBoundedPlanningFiles } from '../policy/canary-planning-files.ts';
import { currentCanaryBindings } from '../policy/reliability/canary.ts';

const FACTORY_ROOT = path.join(REPOSITORY_ROOT, 'packages/agent-sdlc');

const PILOT_MODULES = Object.freeze([
	{
		tsRel: 'policy/errors.ts',
		mjsRel: 'policy/errors.mjs',
		tsImport: '../policy/errors.ts',
	},
	{
		tsRel: 'policy/contracts/dag-schema.ts',
		mjsRel: 'policy/contracts/dag-schema.mjs',
		tsImport: '../policy/contracts/dag-schema.ts',
	},
	{
		tsRel: 'execution/ac-coverage.ts',
		mjsRel: 'execution/ac-coverage.mjs',
		tsImport: '../execution/ac-coverage.ts',
	},
]);

test('the three pilot .ts files exist and their temporary .mjs shims are removed after freeze', () => {
	for (const { tsRel, mjsRel } of PILOT_MODULES) {
		assert.equal(fs.existsSync(path.join(FACTORY_ROOT, tsRel)), true, tsRel);
		assert.equal(fs.existsSync(path.join(FACTORY_ROOT, mjsRel)), false, mjsRel);
	}
});

test('each pilot .ts module exports its runtime symbols', async () => {
	for (const { tsRel, tsImport } of PILOT_MODULES) {
		const tsModule = await import(tsImport);
		const tsKeys = Object.keys(tsModule).sort();
		assert.ok(tsKeys.length > 0, `${tsRel} must export at least one runtime symbol`);
	}
});

test('pnpm --filter @fitness-app/agent-sdlc run typecheck and the pilot test suites exit 0', () => {
	const typecheck = spawnSync('pnpm', ['--filter', '@fitness-app/agent-sdlc', 'run', 'typecheck'], {
		cwd: REPOSITORY_ROOT,
		encoding: 'utf8',
		timeout: 60_000,
	});
	const typecheckOutput = `${typecheck.stdout ?? ''}\n${typecheck.stderr ?? ''}`;
	assert.equal(typecheck.status, 0, typecheckOutput);

	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const testSuite = spawnSync(
		process.execPath,
		[
			'--test',
			'--test-concurrency=1',
			'packages/agent-sdlc/testing/type-gate.spec.mjs',
			'packages/agent-sdlc/testing/verify-scripts.spec.mjs',
			'packages/agent-sdlc/testing/type-escape.spec.mjs',
			'packages/agent-sdlc/policy/contracts/dag-schema.spec.mjs',
			'packages/agent-sdlc/policy/contract-types.spec.mjs',
			'packages/agent-sdlc/execution/ac-coverage.spec.mjs',
		],
		{
			cwd: REPOSITORY_ROOT,
			encoding: 'utf8',
			timeout: 120_000,
			env,
		},
	);
	const testOutput = `${testSuite.stdout ?? ''}\n${testSuite.stderr ?? ''}`;
	assert.equal(testSuite.status, 0, testOutput);
});

test('the computed canary bindings include policy/contracts/dag-schema.ts', () => {
	const bounded = listBoundedPlanningFiles(REPOSITORY_ROOT);
	assert.equal(
		bounded.includes('packages/agent-sdlc/policy/contracts/dag-schema.ts'),
		true,
	);
	const bindings = currentCanaryBindings(REPOSITORY_ROOT);
	assert.match(bindings.boundedPlanningHash, /^[a-f0-9]{64}$/);
});
