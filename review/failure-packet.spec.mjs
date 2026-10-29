import '../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	buildFailurePacket,
	classifyFailure,
	enrichFailureOutputWithAuthorizedExcerpts,
	failureReferencesAuthorizedPackage,
	isEnvironmentFailure,
} from './failure-packet.ts';

test('@ac AC-03 failure context includes only authorized bounded excerpts', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-context-'));
	const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.ts`);
	try {
		const authorized = path.join(root, 'apps/example/src/Page.spec.tsx');
		const unauthorized = path.join(root, 'apps/other/src/Secret.spec.ts');
		fs.mkdirSync(path.dirname(authorized), { recursive: true });
		fs.mkdirSync(path.dirname(unauthorized), { recursive: true });
		fs.writeFileSync(
			authorized,
			['line one', 'line two', 'expect(button).toBeEnabled();', 'line four'].join(
				'\n',
			),
		);
		fs.writeFileSync(unauthorized, 'forbidden context\n');
		fs.writeFileSync(outside, 'outside symlink context\n');
		fs.symlinkSync(outside, path.join(root, 'apps/example/src/Escape.spec.ts'));
		const enriched = enrichFailureOutputWithAuthorizedExcerpts({
			output:
				'FAIL src/Page.spec.tsx:3:5\nFAIL apps/other/src/Secret.spec.ts:1:1\nFAIL apps/example/src/Escape.spec.ts:1:1',
			worktreeDir: root,
			allowedPathPrefixes: ['apps/example'],
			packagePath: 'apps/example',
			contextLines: 1,
		});
		assert.match(enriched, /apps\/example\/src\/Page\.spec\.tsx:3/);
		assert.match(enriched, /expect\(button\)\.toBeEnabled/);
		assert.doesNotMatch(enriched, /forbidden context/);
		assert.doesNotMatch(enriched, /outside symlink context/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(outside, { force: true });
	}
});

test('classifyFailure correctly detects error categories', () => {
	assert.equal(classifyFailure('Error: Test failed in billing.spec.ts'), 'test_failure');
	assert.equal(classifyFailure('biome check found lint errors'), 'quality_failure');
	assert.equal(classifyFailure('TS2322: Type number is not assignable to string'), 'build_failure');
	assert.equal(classifyFailure('spawn ENOENT: command not found'), 'infrastructure_failure');
	assert.equal(
		classifyFailure('quality gate: Error: Port 3000 already in use (needed for registry).'),
		'infrastructure_failure',
	);
	assert.equal(
		classifyFailure('FAIL: vitest collection-failed in test suite loader'),
		'infrastructure_failure',
	);
	assert.equal(isEnvironmentFailure('vitest collection-failed in runner'), true);
	assert.equal(isEnvironmentFailure('AssertionError: expected true to be false'), false);
});

test('preflight failures outside authorized packages are not semantic-repair targets', () => {
	assert.equal(
		failureReferencesAuthorizedPackage({
			output:
				'[coverage] collection-failed — test:cov failed for services/import',
			targetPaths: [
				'services/billing/src/billing/domain/helpers/derive-elevation-totals.helper.ts',
			],
		}),
		false,
	);
	assert.equal(
		failureReferencesAuthorizedPackage({
			output:
				'FAIL services/billing/src/billing/domain/helpers/example.spec.ts',
			targetPaths: ['services/billing/src/billing/domain/helpers'],
		}),
		true,
	);
	assert.equal(
		failureReferencesAuthorizedPackage({
			output: 'generic preflight failure without a repository package path',
			targetPaths: ['services/billing'],
		}),
		true,
	);
});

test('buildFailurePacket sanitizes output and extracts key failure snippets', () => {
	const runId = '2026-09-05-verifier-test-1';
	const baseCommitSha = '1111111111111111111111111111111111111111';
	const rawOutput = `
		Running tests...
		Authorization: Bearer my-secret-api-token-123456789
		FAIL services/billing/src/file.spec.ts
		  ✖ test case 1 failed: expected 1 to equal 2
		    at Object.<anonymous> (file.spec.ts:12:5)
	`;

	const packet = buildFailurePacket({
		runId,
		generation: 0,
		failedCommand: 'pnpm run agent:verify',
		exitCode: 1,
		output: rawOutput,
		targetPaths: ['services/billing/**'],
		baseCommitSha,
	});

	assert.equal(packet.runId, runId);
	assert.equal(packet.exitCode, 1);
	assert.equal(packet.classification, 'test_failure');
	assert.ok(!packet.sanitizedOutput.includes('my-secret-api-token'));
	assert.ok(packet.sanitizedOutput.includes('FAIL'));
});

test('buildFailurePacket ignores stack trace frames, node_modules, and scripts in extracted paths', () => {
	const runId = '2026-09-05-verifier-stack-test';
	const baseCommitSha = '1111111111111111111111111111111111111111';
	const rawOutput = `
		❯ src/billing/domain/billing-log.entity.spec.ts (23 tests | 20 failed)
		  ✖ expected to not throw but TypeError was thrown
		    at BillingLogEntity.create (/home/ulrik/services/billing/src/billing/domain/billing-log.entity.ts:123:4)
		    at Object.toPlainObject (/home/ulrik/packages/example-base/src/dtos/recording/plain-object.util.ts:45:6)
		    at BaseEntity.constructor (/home/ulrik/packages/shared-base/src/domain/entity.class.ts:12:3)
		    at Module._compile (/home/ulrik/tools/.agent-sdlc/test-run/worktrees/billing-task/node_modules/.pnpm/some-dep/index.js:1:1)
		 ❯ Function.validateDTO ../../../packages/shared-base/src/domain/entity.class.ts:452:11
		 ❯ requireKey ../../../packages/example-base/src/dtos/recording/plain-object.util.ts:64:7
		> tools/clean-secrets-config-js.sh
	`;

	const packet = buildFailurePacket({
		runId,
		generation: 0,
		failedCommand: 'pnpm --filter @fixture/billing-service test',
		exitCode: 1,
		output: rawOutput,
		targetPaths: ['services/billing/'],
		baseCommitSha,
	});

	assert.equal(packet.runId, runId);
	assert.deepEqual(packet.targetPaths, ['services/billing/']);
	assert.ok(!packet.targetPaths.includes('packages/shared-base/src/domain/entity.class.ts'));
	assert.ok(!packet.targetPaths.includes('packages/example-base/src/dtos/recording/plain-object.util.ts'));
	assert.ok(!packet.targetPaths.includes('tools/clean-secrets-config-js.sh'));
});

test('@ac AC-01 output paths stay out of the failure packet', () => {
	const packet = buildFailurePacket({
		runId: '2026-09-27-verifier-ac01',
		generation: 0,
		failedCommand: 'pnpm --filter @fixture/billing-service test',
		exitCode: 1,
		output: 'FAIL packages/example-base/src/index.ts\nFAIL tools/quality/check.mjs\n',
		targetPaths: ['services/billing/'],
		baseCommitSha: '1111111111111111111111111111111111111111',
	});

	assert.deepEqual(packet.targetPaths, ['services/billing/']);
	assert.ok(packet.sanitizedOutput.includes('packages/example-base/src/index.ts'));
});

test('empty output leaves the caller targetPaths unchanged', () => {
	const packet = buildFailurePacket({
		runId: '2026-09-27-verifier-empty-output',
		generation: 0,
		failedCommand: 'pnpm test',
		exitCode: 1,
		output: '',
		targetPaths: ['services/billing/'],
		baseCommitSha: '1111111111111111111111111111111111111111',
	});

	assert.deepEqual(packet.targetPaths, ['services/billing/']);
});

test('a caller list of 64 paths is stored as those 64 paths', () => {
	const targetPaths = Array.from(
		{ length: 64 },
		(_, index) => `services/billing/src/file-${index}.ts`,
	);
	const packet = buildFailurePacket({
		runId: '2026-09-27-verifier-sixty-four-paths',
		generation: 0,
		failedCommand: 'pnpm test',
		exitCode: 1,
		output: 'FAIL packages/shared-base/src/domain/value-object.class.ts\n',
		targetPaths,
		baseCommitSha: '1111111111111111111111111111111111111111',
	});

	assert.deepEqual(packet.targetPaths, targetPaths);
});

test('@ac AC-05 @case AC-05.3 buildFailurePacket classifies EADDRINUSE as infrastructure_failure and keeps the caller target paths', () => {
	const packet = buildFailurePacket({
		runId: '2026-10-24-failure-packet',
		failedCommand: 'pnpm run agent:verify',
		exitCode: 1,
		output: 'Error: listen EADDRINUSE: address already in use :::3000',
		targetPaths: ['services/billing/src/a.ts'],
		baseCommitSha: '2'.repeat(40),
	});
	assert.equal(packet.classification, 'infrastructure_failure');
	assert.deepEqual(packet.targetPaths, ['services/billing/src/a.ts']);
	assert.equal(isEnvironmentFailure(packet.sanitizedOutput), true);
});
