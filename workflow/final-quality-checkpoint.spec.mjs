import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';
import { sha256 } from '../policy/contracts.ts';
import { adapterBindingHash } from '../policy/contracts/quality-schema.ts';
import { policy } from '../testing/quality-test-support.mjs';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { prepareFinalQualityCheckpoint } from './final-quality-checkpoint.ts';

function git(cwd, args) {
	return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('final quality checkpoint rejects a tree outside the selected task delta closure', async () => {
	const fixtureParent = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures');
	fs.mkdirSync(fixtureParent, { recursive: true });
	const rootDir = fs.mkdtempSync(path.join(fixtureParent, 'final-checkpoint-'));
	try {
		git(rootDir, ['init', '--quiet']);
		git(rootDir, ['config', 'user.name', 'Checkpoint fixture']);
		git(rootDir, ['config', 'user.email', 'checkpoint@example.invalid']);
		fs.mkdirSync(path.join(rootDir, 'src'));
		fs.writeFileSync(path.join(rootDir, 'src/source.txt'), 'base\n');
		git(rootDir, ['add', '.']);
		git(rootDir, ['commit', '--quiet', '-m', 'base']);
		const baseCommitSha = git(rootDir, ['rev-parse', 'HEAD']);
		const baseTreeSha = git(rootDir, ['rev-parse', 'HEAD^{tree}']);
		const patchHash = crypto.createHash('sha256').update('').digest('hex');
		const adapter = {
			adapterId: 'checkpoint-unit',
			protocolVersion: '1.0.0',
			bundleFiles: [{ path: 'src/adapter.mjs', sha256: 'd'.repeat(64) }],
			dependencyFiles: [],
			configurationFiles: [],
			argv: ['node', 'src/adapter.mjs'],
			profiles: [{ profileId: 'unit', layers: ['unit'], capabilities: [] }],
			qualificationArtifactHash: 'e'.repeat(64),
			limits: { timeoutMs: 1_000, maxReportBytes: 10_000, maxArtifactBytes: 1_000, maxArtifacts: 1 },
		};
		const task = {
			taskId: 'task-one',
			sliceId: 'slice-one',
			title: 'Task one',
			targetPackage: 'src',
			status: 'completed',
			integrationOrder: 0,
			pathPrefixes: ['src'],
			authoredPaths: ['src/source.txt', 'src/source.spec.mjs'],
			generatedOutputs: [],
			dependsOn: [],
			acceptanceCriteria: ['AC-01'],
			verificationCommand: ['pnpm', 'run', 'test'],
			generatorCommand: null,
			deliveryLayers: ['application'],
			dependencyMutations: [],
			shadowPaths: { unhappy: 'error', timeout: 'timeout', empty: 'empty', boundary: 'edge' },
			parentTreeSha: baseTreeSha,
			targetTreeSha: baseTreeSha,
			patchHash,
		};
		const plan = {
			schemaVersion: '2.0.0',
			runId: '2026-11-02-final-checkpoint-tree',
			planPolicyHash: 'f'.repeat(64),
			baseCommitSha,
			slices: [{
				sliceId: 'slice-one',
				kind: 'vertical',
				goal: 'Deliver the source.',
				acceptanceCriteria: ['AC-01'],
				dependsOn: [],
			}],
			integrationOrder: ['task-one'],
			tasks: [task],
			isParallel: false,
			createdAt: '2026-11-02T09:00:00.000Z',
			qualityPolicy: policy,
			qualityPolicyHash: sha256(policy),
			adapterBindings: [adapter],
			evidenceObligations: [{
				obligationId: 'obligation-one',
				criterionId: 'AC-01',
				caseId: null,
				owner: { kind: 'slice', id: 'slice-one' },
				observableOutcome: 'The result is visible.',
				setupAction: 'Read the source.',
				expectedResult: 'The source is present.',
				layer: 'unit',
				requiredCapabilities: [],
				implementationPaths: ['src/source.txt'],
				testCases: [{ file: 'src/source.spec.mjs', caseKey: 'visible' }],
				adapterBindingHash: adapterBindingHash(adapter),
				profileId: 'unit',
			}],
		};
		const approvedSpecHash = 'a'.repeat(64);
		const authorization = createDefaultAuthorizationEnvelope({
			runId: plan.runId,
			approvedSpecHash,
			baseCommitSha,
			allowedPackages: ['src'],
			allowedPathPrefixes: ['src'],
			qualityPlan: {
				qualityPolicy: plan.qualityPolicy,
				adapterBindings: plan.adapterBindings,
				evidenceObligations: plan.evidenceObligations,
			},
			rootDir: REPOSITORY_ROOT,
		});
		plan.planPolicyHash = authorization.approvedPlanPolicyHash;
		const runtime = {
			rootDir: REPOSITORY_ROOT,
			runtimeStore: {
				getTaskPlan: () => plan,
				getAuthorization: () => authorization,
				quality: {
					listCurrentTaskRevisions: () => [{
						taskId: 'task-one',
						executionRevision: 0,
						patchHash,
						parentTreeSha: baseTreeSha,
						targetTreeSha: baseTreeSha,
					}],
					registerWorktree() {
						assert.fail('Mismatched integration tree must fail before registering final evidence');
					},
				},
			},
			now: () => new Date(),
			gitCli: (command, args, options) => execFileSync(command, args, options),
		};
		await assert.rejects(
			() => prepareFinalQualityCheckpoint(runtime, {
				runId: plan.runId,
				approvedSpecHash,
				approvedPlanPolicyHash: authorization.approvedPlanPolicyHash,
				taskPlanHash: 'b'.repeat(64),
				targetTreeSha: 'c'.repeat(40),
			}, rootDir),
			(error) => error.code === 'INVALID_CONTRACT',
		);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});
