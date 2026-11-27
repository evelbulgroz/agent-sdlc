import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';
import { sha256 } from '../policy/contracts.ts';
import { adapterBindingHash } from '../policy/contracts/quality-schema.ts';
import { policy } from '../testing/quality-test-support.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { prepareFinalQualityCheckpoint } from './final-quality-checkpoint.ts';
import { checkpointPreparationSelection } from './checkpoint-hydration.ts';
import { sourcePreparationHash } from './quality-checkpoints.ts';
import { commandRegistrationFixture } from '../testing/command-registration-fixture.ts';

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
		const adapter = commandRegistrationFixture({ adapterId: 'checkpoint-unit', limits: { timeoutMs: 1_000, maxReportBytes: 10_000, maxArtifactBytes: 1_000, maxArtifacts: 1 } });
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

test('final quality checkpoint reuses a published closure with the same binding', async () => {
	const fixtureParent = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures');
	fs.mkdirSync(fixtureParent, { recursive: true });
	const rootDir = fs.mkdtempSync(path.join(fixtureParent, 'final-checkpoint-reuse-'));
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
		const patch = execFileSync('git', ['diff-tree', '-r', '-p', '--binary', baseTreeSha, baseTreeSha], {
			cwd: rootDir, encoding: 'utf8',
		});
		const patchHash = crypto.createHash('sha256').update(patch).digest('hex');
		const adapter = commandRegistrationFixture({ adapterId: 'checkpoint-unit', limits: { timeoutMs: 1_000, maxReportBytes: 10_000, maxArtifactBytes: 1_000, maxArtifacts: 1 } });
		const task = {
			taskId: 'task-one', sliceId: 'slice-one', title: 'Task one', targetPackage: 'src', status: 'completed',
			integrationOrder: 0, pathPrefixes: ['src'], authoredPaths: ['src/source.txt'], generatedOutputs: [],
			dependsOn: [], acceptanceCriteria: ['AC-01'], verificationCommand: ['pnpm', 'run', 'test'],
			generatorCommand: null, deliveryLayers: ['application'], dependencyMutations: [],
			shadowPaths: { unhappy: 'error', timeout: 'timeout', empty: 'empty', boundary: 'edge' },
			parentTreeSha: baseTreeSha, targetTreeSha: baseTreeSha, patchHash,
		};
		const plan = {
			schemaVersion: '2.0.0', runId: '2026-11-02-final-checkpoint-reuse', planPolicyHash: 'f'.repeat(64), baseCommitSha,
			slices: [{ sliceId: 'slice-one', kind: 'vertical', goal: 'Deliver the source.', acceptanceCriteria: ['AC-01'], dependsOn: [] }],
			integrationOrder: ['task-one'], tasks: [task], isParallel: false, createdAt: '2026-11-02T09:00:00.000Z',
			qualityPolicy: policy, qualityPolicyHash: sha256(policy), adapterBindings: [adapter],
			evidenceObligations: [{
				obligationId: 'obligation-one', criterionId: 'AC-01', caseId: null, owner: { kind: 'slice', id: 'slice-one' },
				observableOutcome: 'The result is visible.', setupAction: 'Read the source.', expectedResult: 'The source is present.',
				layer: 'unit', requiredCapabilities: [], implementationPaths: ['src/source.txt'],
				testCases: [{ file: 'src/source.spec.mjs', caseKey: 'visible' }],
				adapterBindingHash: adapterBindingHash(adapter), profileId: 'unit',
			}],
		};
		const approvedSpecHash = 'a'.repeat(64);
		const taskPlanHash = 'b'.repeat(64);
		const authorization = createDefaultAuthorizationEnvelope({
			runId: plan.runId, approvedSpecHash, baseCommitSha, allowedPackages: ['src'], allowedPathPrefixes: ['src'],
			qualityPlan: { qualityPolicy: plan.qualityPolicy, adapterBindings: plan.adapterBindings, evidenceObligations: plan.evidenceObligations },
			rootDir: REPOSITORY_ROOT,
		});
		plan.planPolicyHash = authorization.approvedPlanPolicyHash;
		const execCli = () => '';
		const selectionHash = checkpointPreparationSelection(execCli, {
			preparationPolicyHash: authorization.preparationPolicyHash ?? null,
			preparationSelectionHash: null,
			adapters: plan.adapterBindings,
		});
		const selectedRevisions = [{ taskId: 'task-one', executionRevision: 0, patchHash }];
		const checkpointId = `final-${sha256({ treeSha: baseTreeSha, selectedRevisions }).slice(0, 40)}`;
		const binding = {
			runId: plan.runId, approvedSpecHash, taskPlanHash, qualityPolicyHash: plan.qualityPolicyHash,
			checkpointId, checkpointKind: 'final', ownerId: null, candidateRevision: 0, baseCommitSha,
			treeSha: baseTreeSha, revisionSetHash: sha256(selectedRevisions),
			preparationHash: sourcePreparationHash({ targetTreeSha: baseTreeSha, generatedOutputs: [] }, selectionHash),
		};
		const runtime = {
			rootDir: REPOSITORY_ROOT,
			execCli,
			runtimeStore: {
				getTaskPlan: () => plan,
				getAuthorization: () => authorization,
				quality: {
					listCurrentTaskRevisions: () => [{
						taskId: 'task-one', executionRevision: 0, patchHash, parentTreeSha: baseTreeSha, targetTreeSha: baseTreeSha,
					}],
					getClosure: () => ({ binding, status: 'accepted' }),
					getWorktree: () => ({ bindingHash: sha256(binding), kind: 'final', ownerId: null }),
					registerWorktree() { throw new Error('published final must be reused'); },
					saveClosure() { throw new Error('published final must be reused'); },
				},
			},
			now: () => new Date(),
			gitCli: (command, args, options) => execFileSync(command, args, options),
		};
		const fields = await prepareFinalQualityCheckpoint(runtime, {
			runId: plan.runId, approvedSpecHash, approvedPlanPolicyHash: authorization.approvedPlanPolicyHash,
			taskPlanHash, targetTreeSha: baseTreeSha,
		}, rootDir);
		assert.equal(fields.qualityCheckpointId, checkpointId);
		assert.equal(fields.qualityCheckpointBindingHash, sha256(binding));
		assert.equal(fields.qualityCheckpointKind, 'final');
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});
