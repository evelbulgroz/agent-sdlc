import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ModelUsageError } from '@fitness-app/model-usage/errors';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { RepositoryModelGovernor } from './model-governor.ts';

const TEST_ONLY_MJS_FILES = new Set([
	'test-support.mjs',
	'governor-test-support.mjs',
	'ledger-test-support.mjs',
	'live-adapters-test-support.mjs',
	'ledger-child.mjs',
	'ledger-success-child.mjs',
]);

test('@ac AC-04 @case AC-04.1 the port default path resolves @fitness-app/model-usage governor entrypoint and every source production file under packages/model-usage is .ts', () => {
	const governor = new RepositoryModelGovernor();
	const normalized = governor.governorPath.split(path.sep).join('/');
	assert.equal(
		normalized.endsWith('packages/model-usage/dist/governor.js') ||
			normalized.endsWith('packages/model-usage/governor.ts') ||
			normalized.endsWith('@fitness-app/model-usage/dist/governor.js'),
		true,
		`expected governorPath to resolve to @fitness-app/model-usage governor entrypoint, got ${normalized}`,
	);
	assert.equal(fs.existsSync(governor.governorPath), true);

	for (const subDir of [
		'packages/model-usage',
		'packages/model-usage/governor',
		'packages/model-usage/ledger',
		'packages/model-usage/policy',
		'packages/model-usage/routing',
		'packages/model-usage/adapters',
		'packages/model-usage/scripts',
	]) {
		const dirPath = path.join(REPOSITORY_ROOT, subDir);
		if (!fs.existsSync(dirPath)) continue;
		const entries = fs.readdirSync(dirPath, { withFileTypes: true }).filter((e) => e.isFile());
		const tsFiles = entries.filter((e) => e.name.endsWith('.ts'));
		assert.ok(tsFiles.length > 0, `expected .ts production files in ${subDir}`);
		for (const entry of entries) {
			if (entry.name.endsWith('.mjs')) {
				const isAllowedTestFile =
					entry.name.endsWith('.spec.mjs') || TEST_ONLY_MJS_FILES.has(entry.name);
				assert.equal(
					isAllowedTestFile,
					true,
					`unexpected production .mjs file in ${subDir}: ${entry.name}`,
				);
			}
		}
	}
});

test('@ac AC-04 @case AC-04.2 packages/model-usage/governor.mjs is absent', () => {
	const legacyGovernorMjs = path.join(REPOSITORY_ROOT, 'packages/model-usage/governor.mjs');
	assert.equal(fs.existsSync(legacyGovernorMjs), false);
});

test('@ac AC-10 the adapter preflight is the governor function', async () => {
	let executeCalls = 0;
	const governor = new RepositoryModelGovernor({
		execute: async () => {
			executeCalls += 1;
			throw new Error('executeOperation should not run');
		},
		assessReservation: async () => {
			throw new ModelUsageError(
				'ERR_TOKEN_BUDGET_EXCEEDED',
				'Attempt token reservation exceeds route or operation ceiling',
				{
					dimension: 'maxTotalTokens',
					limit: 26000,
					requested: 27000,
					remaining: 0,
				},
			);
		},
	});

	await assert.rejects(
		() =>
			governor.assertCanReserve({
				schemaVersion: '1.0.0',
				operationId: 'operation-ac10',
				runId: 'run-ac10',
				consumer: 'agent-sdlc',
				profile: 'agent-sdlc-default',
				prompt: 'Return a small JSON object.',
				structuredOutputSchema: {
					type: 'object',
					required: ['ok'],
					properties: { ok: { type: 'boolean' } },
					additionalProperties: false,
				},
				routingConstraints: { requiredCapabilities: ['structured-output'] },
			}),
		(error) => {
			assert.equal(error.code, 'GOVERNOR_BUDGET_DENIED');
			return true;
		},
	);
	assert.equal(executeCalls, 0);
});

test('run deadline expiry stays distinct from route exhaustion', async () => {
	const deadline = new RepositoryModelGovernor({
		assessReservation: async () => {
			throw new ModelUsageError('ERR_RUN_DEADLINE_EXPIRED', 'Run deadline has expired', {
				runId: 'run-deadline',
				profile: 'agent-sdlc-default',
				limit: 28800000,
				runDeadlineAt: '2026-10-21T19:50:03.867Z',
			});
		},
	});
	await assert.rejects(
		() => deadline.assertCanReserve({}),
		(error) => {
			assert.equal(error.code, 'GOVERNOR_RUN_DEADLINE_EXPIRED');
			assert.equal(error.message, 'Run deadline has expired');
			assert.equal(error.metadata.runDeadlineAt, '2026-10-21T19:50:03.867Z');
			assert.equal(error.metadata.limit, 28800000);
			return true;
		},
	);

	const timeout = new RepositoryModelGovernor({
		assessReservation: async () => {
			throw new ModelUsageError('ERR_OPERATION_TIMEOUT', 'Model operation timed out', {
				runId: 'run-timeout',
			});
		},
	});
	await assert.rejects(
		() => timeout.assertCanReserve({}),
		(error) => {
			assert.equal(error.code, 'GOVERNOR_ROUTES_EXHAUSTED');
			assert.equal(error.message, 'No allowed governed model route completed');
			return true;
		},
	);
});

test('RepositoryModelGovernor resolves host project .agent-sdlc/local-policy.json and tools/.model-usage/local-policy.json from rootDir', () => {
	const tempHostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-host-governor-policy-'));
	try {
		const defaultGov = new RepositoryModelGovernor({ rootDir: tempHostDir });
		assert.equal(
			defaultGov.executeOptions.defaultLocalPolicyPath,
			path.join(tempHostDir, 'tools', '.model-usage', 'local-policy.json'),
		);

		const sdlcDir = path.join(tempHostDir, '.agent-sdlc');
		fs.mkdirSync(sdlcDir, { recursive: true });
		const sdlcPolicyFile = path.join(sdlcDir, 'local-policy.json');
		fs.writeFileSync(sdlcPolicyFile, '{}\n');

		const sdlcGov = new RepositoryModelGovernor({ rootDir: tempHostDir });
		assert.equal(sdlcGov.executeOptions.defaultLocalPolicyPath, sdlcPolicyFile);

		const explicitPolicyFile = path.join(tempHostDir, 'custom-policy.json');
		const explicitGov = new RepositoryModelGovernor({
			rootDir: tempHostDir,
			localPolicyPath: explicitPolicyFile,
		});
		assert.equal(explicitGov.executeOptions.defaultLocalPolicyPath, explicitPolicyFile);
	} finally {
		fs.rmSync(tempHostDir, { recursive: true, force: true });
	}
});
