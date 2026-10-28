import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runReviewCli } from './agent-review.ts';
import { RepositoryModelGovernor } from '../adapters/model-governor.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

function makeFixtureDir(prefix) {
	const dir = path.join(REPOSITORY_ROOT, 'tools/.review', `${prefix}-${crypto.randomUUID().slice(0, 8)}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function createFakeGovernor({
	status = 'PASS',
	findings = [],
	canonicalVendor = 'anthropic',
	model = 'claude-3-7-sonnet',
	routeId = 'anthropic-direct',
	operationId = `op-${crypto.randomUUID().slice(0, 8)}`,
	usageRecordIds = ['rec-review-1'],
} = {}) {
	return {
		execute: async (request) => ({
			schemaVersion: '1.0.0',
			synthetic: true,
			output: { status, findings },
			operationId: request.operationId || operationId,
			route: {
				routeId,
				provider: canonicalVendor,
				model,
				canonicalVendor,
			},
			usageRecordIds,
		}),
	};
}

test('runReviewCli rejects oversized target with INPUT_OVERSIZED', async () => {
	const fixtureDir = makeFixtureDir('review-oversized');
	const oversizedSpec = path.join(fixtureDir, 'huge-spec.md');
	// Write 30KB of content
	fs.writeFileSync(oversizedSpec, '# Huge Spec\n' + 'A'.repeat(30_000) + '\n');

	const governor = createFakeGovernor();

	try {
		await assert.rejects(
			() =>
				runReviewCli(
					[
						'--phase',
						'spec',
						'--author-vendor',
						'google',
						'--target',
						path.relative(REPOSITORY_ROOT, oversizedSpec),
					],
					{
						rootDir: REPOSITORY_ROOT,
						governor,
						reviewBaseDir: fixtureDir,
					},
				),
			(err) => err.code === 'INPUT_OVERSIZED',
		);
	} finally {
		fs.rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test('runReviewCli executes spec phase with PASS and returns exit code 0', async () => {
	const fixtureDir = makeFixtureDir('review-base-spec');
	const specFile = path.join(fixtureDir, 'sample-spec.md');
	fs.writeFileSync(specFile, '# Feature Spec\n\n## Acceptance Criteria\n- Test passes cleanly\n');

	const governor = createFakeGovernor({
		status: 'PASS',
		findings: [],
		canonicalVendor: 'openai',
	});

	const logs = [];
	const originalLog = console.log;
	console.log = (...args) => logs.push(args.join(' '));

	try {
		const exitCode = await runReviewCli(
			[
				'--phase',
				'spec',
				'--author-vendor',
				'google',
				'--target',
				path.relative(REPOSITORY_ROOT, specFile),
			],
			{
				rootDir: REPOSITORY_ROOT,
				governor,
				reviewBaseDir: fixtureDir,
			},
		);

		assert.equal(exitCode, 0);
		assert.ok(logs.join('\n').includes('=== Critic Review Result: PASS ==='));
	} finally {
		console.log = originalLog;
		fs.rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test('runReviewCli executes plan phase with PASS and returns exit code 0', async () => {
	const fixtureDir = makeFixtureDir('review-base-plan');
	const planFile = path.join(fixtureDir, 'sample-plan.md');
	fs.writeFileSync(planFile, '# Implementation Plan\n\n## Slice 1\n- Core implementation\n');

	const governor = createFakeGovernor({
		status: 'PASS',
		findings: [],
		canonicalVendor: 'openai',
	});

	const logs = [];
	const originalLog = console.log;
	console.log = (...args) => logs.push(args.join(' '));

	try {
		const exitCode = await runReviewCli(
			[
				'--phase',
				'plan',
				'--author-vendor',
				'google',
				'--target',
				path.relative(REPOSITORY_ROOT, planFile),
			],
			{
				rootDir: REPOSITORY_ROOT,
				governor,
				reviewBaseDir: fixtureDir,
			},
		);

		assert.equal(exitCode, 0);
		assert.ok(logs.join('\n').includes('Phase:            plan'));
	} finally {
		console.log = originalLog;
		fs.rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test('runReviewCli forwards reviewer-route to governor routingConstraints', async () => {
	const fixtureDir = makeFixtureDir('review-route-forward');
	const specFile = path.join(fixtureDir, 'sample-spec.md');
	fs.writeFileSync(specFile, '# Spec for Route Test\n\n## Criteria\n- AC 1\n');

	let capturedRequest = null;
	const governor = {
		execute: async (request) => {
			capturedRequest = request;
			return {
				schemaVersion: '1.0.0',
				synthetic: true,
				output: { status: 'PASS', findings: [] },
				operationId: request.operationId,
				route: {
					routeId: 'anthropic-direct',
					provider: 'anthropic',
					model: 'claude-3-7-sonnet',
					canonicalVendor: 'anthropic',
				},
				usageRecordIds: ['rec-1'],
			};
		},
	};

	const logs = [];
	const originalLog = console.log;
	console.log = (...args) => logs.push(args.join(' '));

	try {
		const exitCode = await runReviewCli(
			[
				'--phase',
				'spec',
				'--author-vendor',
				'google',
				'--target',
				path.relative(REPOSITORY_ROOT, specFile),
				'--reviewer-route',
				'anthropic-direct',
			],
			{
				rootDir: REPOSITORY_ROOT,
				governor,
				reviewBaseDir: fixtureDir,
			},
		);

		assert.equal(exitCode, 0);
		assert.ok(capturedRequest);
		assert.deepEqual(capturedRequest.routingConstraints.preferredRouteIds, ['anthropic-direct']);
	} finally {
		console.log = originalLog;
		fs.rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test('runReviewCli executes code phase and returns exit code 1 when P1 finding exists', async () => {
	const fixtureDir = makeFixtureDir('review-base-code-p1');
	const governor = createFakeGovernor({
		status: 'FAIL',
		findings: [
			{
				severity: 'P1',
				category: 'correctness',
				file: 'review/agent-review.ts',
				evidence: 'Potential race condition',
				impact: 'Process hang',
				remediation: 'Add timeout',
			},
		],
		canonicalVendor: 'anthropic',
	});

	const mockGitCli = () => 'diff --git a/test.js b/test.js\n+console.log("hello");';

	const logs = [];
	const originalLog = console.log;
	console.log = (...args) => logs.push(args.join(' '));

	try {
		const exitCode = await runReviewCli(
			['--phase', 'code', '--author-vendor', 'openai', '--scope', 'review/agent-review.ts'],
			{
				rootDir: REPOSITORY_ROOT,
				governor,
				gitCli: mockGitCli,
				reviewBaseDir: fixtureDir,
			},
		);

		assert.equal(exitCode, 1, 'CLI must exit 1 on P1 findings');
		assert.ok(logs.join('\n').includes('=== Critic Review Result: FAIL ==='));
		assert.ok(logs.join('\n').includes('[P1 - BLOCKING]'));
	} finally {
		console.log = originalLog;
		fs.rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test('runReviewCli outputs structured JSON matching CRITIC_FINDINGS_SCHEMA with --json flag', async () => {
	const fixtureDir = makeFixtureDir('review-base-json');
	const specFile = path.join(fixtureDir, 'sample-spec.md');
	fs.writeFileSync(specFile, '# Feature Spec\n\n## Acceptance Criteria\n- AC 1\n');

	const governor = createFakeGovernor({
		status: 'PASS',
		findings: [],
		canonicalVendor: 'anthropic',
	});

	const logs = [];
	const originalLog = console.log;
	console.log = (...args) => logs.push(args.join(' '));

	try {
		const exitCode = await runReviewCli(
			[
				'--phase',
				'spec',
				'--author-vendor',
				'google',
				'--target',
				path.relative(REPOSITORY_ROOT, specFile),
				'--json',
			],
			{
				rootDir: REPOSITORY_ROOT,
				governor,
				reviewBaseDir: fixtureDir,
			},
		);

		assert.equal(exitCode, 0);
		const jsonOutput = logs.join('\n');
		const parsed = JSON.parse(jsonOutput);
		assert.equal(parsed.status, 'PASS');
		assert.ok(Array.isArray(parsed.findings));
		assert.deepEqual(Object.keys(parsed).sort(), ['findings', 'status']);
	} finally {
		console.log = originalLog;
		fs.rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test('runReviewCli executes qa phase with test output file', async () => {
	const fixtureDir = makeFixtureDir('review-base-qa');
	const specFile = path.join(fixtureDir, 'sample-spec.md');
	fs.writeFileSync(specFile, '# Feature Spec\n\n## Acceptance Criteria\n- AC 1: passes tests\n');
	const testLogFile = path.join(fixtureDir, 'test-output.log');
	fs.writeFileSync(testLogFile, '# tests 24\n# pass 24\n# fail 0\n# ok\n');

	const governor = createFakeGovernor({
		status: 'PASS',
		findings: [],
		canonicalVendor: 'xai',
	});

	const logs = [];
	const originalLog = console.log;
	console.log = (...args) => logs.push(args.join(' '));

	try {
		const exitCode = await runReviewCli(
			[
				'--phase',
				'qa',
				'--author-vendor',
				'google',
				'--target',
				path.relative(REPOSITORY_ROOT, specFile),
				'--test-output',
				path.relative(REPOSITORY_ROOT, testLogFile),
			],
			{
				rootDir: REPOSITORY_ROOT,
				governor,
				reviewBaseDir: fixtureDir,
			},
		);

		assert.equal(exitCode, 0);
	} finally {
		console.log = originalLog;
		fs.rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test('Governor AC 16: Dispatches via consumer agent-sdlc and persists operationId and usageRecordIds', async () => {
	let capturedOperation = null;
	const mockExecuteOp = async (request) => {
		capturedOperation = request;
		return {
			schemaVersion: '1.0.0',
			status: 'succeeded',
			output: { status: 'PASS', findings: [] },
			operationId: request.operationId,
			replayed: false,
			route: {
				routeId: 'openai-review-route',
				provider: 'openai',
				model: 'gpt-4o',
				canonicalVendor: 'openai',
			},
			usageRecordIds: ['rec-gov-ac16-1', 'rec-gov-ac16-2'],
		};
	};

	const realGovernor = new RepositoryModelGovernor({
		execute: mockExecuteOp,
	});

	const fixtureDir = makeFixtureDir('review-base-ac16');
	const specFile = path.join(fixtureDir, 'sample-spec.md');
	fs.writeFileSync(specFile, '# Spec for AC 16\n\n## Criteria\n- Governor must be used\n');
	const testRunId = `2026-09-08-review-${crypto.randomUUID().slice(0, 8)}`;

	const logs = [];
	const originalLog = console.log;
	console.log = (...args) => logs.push(args.join(' '));

	try {
		const exitCode = await runReviewCli(
			[
				'--phase',
				'spec',
				'--author-vendor',
				'google',
				'--target',
				path.relative(REPOSITORY_ROOT, specFile),
				'--run',
				testRunId,
			],
			{
				rootDir: REPOSITORY_ROOT,
				governor: realGovernor,
				reviewBaseDir: fixtureDir,
			},
		);

		assert.equal(exitCode, 0);

		// Assert governor request contracts
		assert.ok(capturedOperation, 'Governor executeOperation must be called');
		assert.equal(capturedOperation.schemaVersion, '1.0.0');
		assert.equal(capturedOperation.consumer, 'agent-sdlc');
		assert.equal(capturedOperation.profile, 'critic-review');
		assert.equal(capturedOperation.attribution?.nodeId, 'critic_review');
		assert.equal(capturedOperation.attribution?.roleId, 'critic-reviewer');
		assert.equal(capturedOperation.attribution?.phase, 'spec');
		assert.ok(capturedOperation.attribution?.taskId);
		assert.deepEqual(capturedOperation.routingConstraints?.excludedVendors, ['google']);

		// Assert host report persistence of IDs
		const reportFiles = fs.readdirSync(path.join(fixtureDir, testRunId));
		const reportFile = reportFiles.find((f) => f.endsWith('-spec-report.json'));
		assert.ok(reportFile, 'Report JSON file must exist in review directory');

		const reportContent = JSON.parse(
			fs.readFileSync(path.join(fixtureDir, testRunId, reportFile), 'utf8'),
		);
		assert.equal(reportContent.operationId, capturedOperation.operationId);
		assert.deepEqual(reportContent.usageRecordIds, ['rec-gov-ac16-1', 'rec-gov-ac16-2']);
	} finally {
		console.log = originalLog;
		fs.rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test('agent-review CLI process exits with code 2 on argument errors', () => {
	assert.throws(
		() => {
			execFileSync(process.execPath, ['review/agent-review.ts', '--phase', 'spec'], {
				cwd: REPOSITORY_ROOT,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		},
		(err) => {
			assert.equal(err.status, 2);
			assert.ok(err.stderr.includes('agent-review error:'));
			return true;
		},
	);
});
