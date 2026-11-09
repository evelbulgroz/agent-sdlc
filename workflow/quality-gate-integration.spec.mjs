import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { TaskExecutor } from '../execution/task-executor.ts';
import { liveRunRoot } from '../persistence/run-paths.ts';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';
import { canonicalJson, sha256 } from '../policy/contracts.ts';
import { hashTaskPlanProjection } from '../policy/contracts/dag-schema.ts';
import { makeFixture } from '../testing/test-support.mjs';
import { CommandRegistrationSchema } from '../policy/contracts/quality-evidence-schema.ts';
import { commandBindingHash } from '../host/command-evidence.ts';
import { policy as defaultPolicy } from '../testing/quality-test-support.mjs';
import { SdlcWorkflowRuntime } from './graph.ts';
import { createExecuteQaCriticNode } from './nodes/review-qa.ts';
import { applyAcCoverageGate } from './preflight-gate.ts';
import { executeCheckpointObligations } from './quality-checkpoints.ts';
import { assertQualityDeliveryAllowed } from './quality-delivery.ts';
import { createApplyQualityAnswerNode } from './nodes/quality-answer.ts';

const H = 'a'.repeat(64), BASE = 'b'.repeat(40), TREE = 'c'.repeat(40);

function fixture(t, finalReview) {
	const f = makeFixture('checkpoint-gate-integration', [
		{ __role: 'critic', status: 'PASS', findings: [] },
		{ __role: 'critic', status: 'PASS', findings: [] },
		finalReview,
	]);
	t.after(() => {
		fs.rmSync(path.join(liveRunRoot(f.runtime.rootDir), f.runId), { recursive: true, force: true });
		f.close();
	});
	const worktreeDir = path.join(f.runtimeDir, 'checkpoint-worktrees', 'candidate');
	fs.mkdirSync(path.join(worktreeDir, 'src'), { recursive: true });
	const source = 'export const visible = true;\n';
	fs.writeFileSync(path.join(worktreeDir, 'src/main.ts'), source);
	for (const index of [1, 2]) {
		fs.writeFileSync(path.join(worktreeDir, `src/case${index}.spec.mjs`),
			`import assert from 'node:assert/strict';\nimport test from 'node:test';\n` +
			`test('@ac AC-0${index} @case AC-0${index}.1 visible', () => { assert.equal(true, true); });\n`);
	}
	const policy = {
		...defaultPolicy,
		followUpDispatches: 0,
		execution: { maxInvocations: 10, maxTotalDurationMs: 10_000 },
		review: { maxLogicalDispatches: 6, maxPhysicalCalls: 6, maxInputTokens: 24_000, maxOutputTokens: 2_000 },
	};
	const executable = { path: fs.realpathSync(process.execPath),
		sha256: crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex') };
	const adapterArgv = [executable.path, 'run.mjs'];
	const adapter = CommandRegistrationSchema.parse({
		kind: 'command', adapterId: 'fixture-unit', protocolVersion: '1.0.0', argv: adapterArgv, cwd: 'src',
		reportFormat: 'junit', retries: 0, executable, pins: [],
		commandSha256: commandBindingHash(adapterArgv, executable.sha256, [], []),
		profiles: [{ profileId: 'unit', layers: ['unit'], capabilities: [] }],
		limits: { timeoutMs: 1_000, maxReportBytes: 16_384, maxArtifactBytes: 1_000, maxArtifacts: 1 },
	});
	const obligations = [1, 2].map(index => ({
		obligationId: `obligation-${index}`, criterionId: `AC-0${index}`, caseId: `AC-0${index}.1`,
		owner: { kind: 'slice', id: `slice-${index}` },
		observableOutcome: 'The result is visible.', setupAction: 'Read the result.',
		expectedResult: 'The result is true.', layer: 'unit', requiredCapabilities: [],
		implementationPaths: ['src/main.ts'],
		testCases: [{ file: `src/case${index}.spec.mjs`, caseKey: `visible-${index}` }],
		adapterBindingHash: sha256(adapter), profileId: 'unit',
	}));
	const qualityPlan = { qualityPolicy: policy, adapterBindings: [adapter], evidenceObligations: obligations };
	const authorization = createDefaultAuthorizationEnvelope({
		runId: f.runId, approvedSpecHash: H, repositoryId: 'fixture/repo', baseCommitSha: BASE,
		allowedPackages: ['src'], allowedPathPrefixes: ['src'], qualityPlan,
	});
	const plan = {
		schemaVersion: '2.0.0', runId: f.runId, planPolicyHash: authorization.approvedPlanPolicyHash,
		baseCommitSha: BASE, qualityPolicy: policy, qualityPolicyHash: sha256(policy),
		adapterBindings: [adapter], evidenceObligations: obligations,
		slices: [1, 2].map(index => ({
			sliceId: `slice-${index}`, kind: 'vertical', goal: 'Expose result.',
			acceptanceCriteria: [`AC-0${index}`], dependsOn: index === 1 ? [] : ['slice-1'],
		})),
		tasks: [1, 2].map(index => ({
			taskId: `task-${index}`, sliceId: `slice-${index}`, title: 'Expose result',
			targetPackage: 'src', pathPrefixes: ['src'], authoredPaths: ['src/main.ts'],
			generatedOutputs: [], acceptanceCriteria: [`AC-0${index}`], status: 'pending',
			dependsOn: index === 1 ? [] : ['task-1'], integrationOrder: index - 1,
			baseCommitSha: BASE, worktreeSubdir: `worktrees/task-${index}`,
			verificationCommand: ['pnpm', 'run', 'test'], generatorCommand: null,
			deliveryLayers: ['application'], dependencyMutations: [],
			shadowPaths: { unhappy: 'error', timeout: 'timeout', empty: 'empty', boundary: 'edge' },
		})),
		integrationOrder: ['task-1', 'task-2'], isParallel: false, createdAt: new Date().toISOString(),
	};
	const spawned = [], gitCalls = [];
	const evidenceSpawn = Object.assign(() => assert.fail('command evidence must not spawn an adapter'), {
		runCommand: async (_registration, request) => {
			spawned.push(request.binding.checkpointId);
			return {
				exitCode: 0, reportBytes: Buffer.from('<testsuites/>'),
				cases: [...new Set(request.obligations.map(obligation => obligation.caseId))]
					.map(identity => ({ identity, outcome: 'passed', message: '', attempts: 1 })),
			};
		},
	});
	const runtime = new SdlcWorkflowRuntime({
		runtimeStore: f.store, artifactStore: f.artifacts, registry: f.registry, governor: f.governor,
		evidenceSpawn,
		gitCli(command, args) {
			gitCalls.push(args);
			if (args[0] === 'diff' && args.includes('--name-only')) return 'src/case1.spec.mjs\nsrc/case2.spec.mjs\n';
			return '';
		},
		execCli() { throw new Error('No external commands are permitted by this fixture'); },
	});
	const initial = runtime.initialize({ runId: f.runId, goal: 'Gate dependent slices and final delivery.' });
	f.store.saveAuthorization(authorization);
	f.store.saveTaskPlan(plan);
	f.store.quality.initializeBudget({
		schemaVersion: '1.0.0', runId: f.runId, qualityPolicyHash: sha256(policy), revision: 0,
		counters: { executionInvocations: 0, executionDurationMs: 0, logicalDispatches: 0,
			physicalCalls: 0, inputTokens: 0, outputTokens: 0 }, reservations: [],
	}, policy);
	let snapshot = {
		...initial, state: 'EXECUTING_IMPLEMENTATION', approvedSpecHash: H,
		approvedPlanPolicyHash: authorization.approvedPlanPolicyHash,
		taskPlanHash: hashTaskPlanProjection(plan), taskPlanFrozen: true,
		draftArtifact: f.artifacts.writeJson('draft', {
			goal: 'Expose results.', acceptanceCriteria: [1, 2].map(index =>
				`AC-0${index}: Result is visible. Given a valid input. Then the result is true. Cases: AC-0${index}.1: Read the result.`),
		}),
		targetTreeSha: TREE, worktreePath: worktreeDir, integrationWorktreePath: worktreeDir,
	};
	f.store.database.prepare('UPDATE runs SET state=?,state_json=?,state_hash=? WHERE run_id=?')
		.run(snapshot.state, canonicalJson(snapshot), sha256(snapshot), f.runId);
	const ran = [];
	const scheduler = new TaskExecutor({
		governor: f.governor, runtimeStore: f.store, artifactStore: f.artifacts, roleRegistry: f.registry,
	});
	scheduler.executeTask = async ({ task }) => {
		ran.push(task.taskId);
		const patchHash = sha256(task.taskId);
		const receiptHash = f.store.quality.saveVerificationReceipt({
			schemaVersion: '1.0.0', runId: f.runId, taskId: task.taskId, executionRevision: 0,
			treeSha: TREE, command: task.verificationCommand,
			artifactHash: f.artifacts.writeJson('task-verification', { taskId: task.taskId, treeSha: TREE, exitCode: 0 }),
			exitCode: 0, status: 'passed',
		});
		f.store.quality.saveTaskRevision({
			schemaVersion: '1.0.0', runId: f.runId, taskPlanHash: snapshot.taskPlanHash,
			taskId: task.taskId, executionRevision: 0, correctionId: null,
			parentTreeSha: BASE, targetTreeSha: TREE, patchHash, parentRevisionSetHash: sha256([]),
			status: 'completed', receiptHashes: [receiptHash],
		});
		f.store.quality.selectTaskRevision(f.runId, task.taskId, 0);
		Object.assign(task, { status: 'completed', parentTreeSha: BASE, targetTreeSha: TREE, patchHash });
		return task;
	};
	const quality = {
		plan,
		closureStatus: id => f.store.quality.listClosures(f.runId).find(entry => entry.binding.ownerId === id)?.status ?? null,
		verifyEnabling: async () => { throw new Error('No enabling slice'); },
		verifyTask: async () => {},
	};
	async function schedule() {
		return scheduler.executeTaskPlan({ taskPlan: f.store.getTaskPlan(f.runId), snapshot, quality, authorization });
	}
	async function bindCheckpoint(ownerId) {
		const kind = ownerId ? 'slice' : 'final';
		const checkpointId = ownerId ?? 'final-candidate';
		const revisions = f.store.quality.listCurrentTaskRevisions(f.runId);
		const selectedRevisions = revisions.map(({ taskId, executionRevision, patchHash }) => ({
			taskId, executionRevision, patchHash,
		}));
		const binding = {
			runId: f.runId, approvedSpecHash: H, taskPlanHash: snapshot.taskPlanHash,
			qualityPolicyHash: sha256(policy), checkpointId, checkpointKind: kind, ownerId,
			candidateRevision: 0, baseCommitSha: BASE, treeSha: TREE,
			revisionSetHash: sha256(selectedRevisions), preparationHash: H,
		};
		f.store.quality.registerWorktree({
			runId: f.runId, registryId: checkpointId, kind, ownerId,
			relativePath: 'checkpoint-worktrees/candidate', bindingHash: sha256(binding), sourceHash: H,
		});
		const receiptHashes = await executeCheckpointObligations({
			runtime, snapshot, plan, binding, worktreeDir, registryId: checkpointId,
			obligations: ownerId ? obligations.filter(entry => entry.owner.id === ownerId) : obligations,
			observeSource: async () => ({ treeSha: TREE, sourceHash: H, preparationHash: H }),
		});
		f.store.quality.saveClosure({
			schemaVersion: '1.0.0', binding, selectedRevisions, registryId: checkpointId,
			status: 'reviewing', receiptHashes, reviewOperationIds: [],
		});
		snapshot = runtime.transition(snapshot, {
			to: 'REVIEWING_QA', eventType: 'SLICE_CHECKPOINT_CREATED', causalId: `checkpoint-${checkpointId}`,
			updates: {
				qualityPolicy: policy, qualityCheckpointId: checkpointId, qualityCheckpointKind: kind,
				qualityCheckpointSliceId: ownerId ?? undefined, qualityCheckpointTreeSha: TREE,
				qualityCheckpointBindingHash: sha256(binding),
				...(ownerId ? {} : { preflightBindingArtifact: f.artifacts.writeJson('canonical-preflight', {
					status: 'OK', canonical: true, targetTreeSha: TREE, preflightResultHash: H,
				}) }),
			}, payload: { checkpointId },
		});
		if (!ownerId) snapshot = applyAcCoverageGate(runtime, snapshot, authorization, worktreeDir).snapshot;
	}
	async function review() { snapshot = (await createExecuteQaCriticNode(runtime)({ snapshot })).snapshot; return snapshot; }
	return { ...f, runtime, ran, spawned, gitCalls, schedule, bindCheckpoint, review, snapshot: () => snapshot };
}

for (const finalPass of [true, false]) {
	test(`runtime slice QA releases the persisted scheduler and ${finalPass ? 'accepts' : 'blocks'} the distinct final gate`, async t => {
		const f = fixture(t, finalPass ? { __role: 'critic', status: 'PASS', findings: [] } : {
			__role: 'critic', status: 'FAIL', findings: [{
				severity: 'P1', category: 'correctness', file: 'src/main.ts', lineRange: [1, 1],
				evidence: 'The visible result is hardcoded.', impact: 'Inputs cannot affect the result.',
				remediation: 'Compute the result from input.',
			}],
		});
		assert.equal((await f.schedule()).sliceId, 'slice-1');
		assert.deepEqual(f.ran, ['task-1']);
		await f.bindCheckpoint('slice-1');
		assert.equal((await f.schedule()).sliceId, 'slice-1');
		assert.deepEqual(f.ran, ['task-1']);
		assert.equal((await f.review()).state, 'EXECUTING_IMPLEMENTATION');
		assert.equal(f.store.quality.getClosure(f.runId, 'slice-1', 0).status, 'accepted');
		assert.throws(() => assertQualityDeliveryAllowed(f.runtime, f.snapshot()), /final checkpoint/);
		assert.equal((await f.schedule()).sliceId, 'slice-2');
		assert.deepEqual(f.ran, ['task-1', 'task-2']);
		await f.bindCheckpoint('slice-2');
		assert.equal((await f.review()).state, 'EXECUTING_IMPLEMENTATION');
		assert.equal((await f.schedule()).status, 'COMPLETED');
		await f.bindCheckpoint(null);
		const coverageEvent = f.store.listEvents(f.runId).filter(event => event.eventType.startsWith('AC_COVERAGE_')).at(-1);
		assert.equal(f.snapshot().state, 'REVIEWING_QA',
			JSON.stringify(f.artifacts.readJson(coverageEvent.payload.coverageArtifact)));
		assert.throws(() => assertQualityDeliveryAllowed(f.runtime, f.snapshot()), /not been accepted/);
		const final = await f.review();
		assert.equal(final.state, finalPass ? 'READY_FOR_GIT_APPROVAL' : 'BLOCKED');
		assert.equal(f.store.quality.getClosure(f.runId, 'final-candidate', 0).status, finalPass ? 'accepted' : 'reviewing');
		if (finalPass) assert.doesNotThrow(() => assertQualityDeliveryAllowed(f.runtime, final));
		else {
			assert.ok(final.pendingInterruptId);
			assert.throws(() => assertQualityDeliveryAllowed(f.runtime, final), /not been accepted/);
			assert.equal(f.store.listEvents(f.runId).some(event => event.eventType === 'RUN_READY_FOR_GIT_APPROVAL'), false);
		}

		assert.deepEqual(f.spawned, ['slice-1', 'slice-2', 'final-candidate']);
		const reviews = f.store.listCriticReviews(f.runId).filter(entry => entry.phase === 'qa');
		assert.equal(reviews.length, 3);
		assert.equal(new Set(reviews.map(entry => entry.attemptKey)).size, 3);
		assert.equal(f.store.quality.getBudget(f.runId).counters.logicalDispatches, 3);
		assert.equal(f.gitCalls.some(args => ['commit', 'push', 'branch'].includes(args[0])), false);
	});
}

test('final refutation resumes delivery after a crash following its durable review event', async t => {
	const f = fixture(t, { __role: 'critic', status: 'FAIL', findings: [{
		severity: 'P1', category: 'correctness', file: 'src/main.ts', lineRange: [1, 1],
		evidence: 'The result appears hardcoded.', impact: 'Inputs may not affect it.',
		remediation: 'Check the input behavior.',
	}] });
	for (const sliceId of ['slice-1', 'slice-2']) {
		await f.schedule();
		await f.bindCheckpoint(sliceId);
		await f.review();
	}
	await f.schedule();
	await f.bindCheckpoint(null);
	const blocked = await f.review();
	const pending = f.store.getPendingInterrupt(f.runId);
	const request = f.artifacts.readJson(pending.requestArtifact);
	const answer = {
		schemaVersion: '1.0.0', answerId: 'refute-final', interruptId: pending.interruptId,
		bindingHash: blocked.qualityCheckpointBindingHash, action: 'refute',
		findingIds: request.findings.map(finding => finding.findingId),
		evidenceHashes: [f.artifacts.writeJson('claim-evidence', {
			schemaVersion: '1.0.0', bindingHash: blocked.qualityCheckpointBindingHash,
			findingId: request.findings[0].findingId, rationale: 'Inputs were exercised successfully.',
			evidenceHashes: [f.artifacts.writeText('reproduction', 'Inputs were exercised successfully.')],
		})],
		rationale: 'The bound execution disproves the finding.', correction: null,
	};
	f.runtime.onBoundary = async name => {
		if (name === 'quality-human-refutation-recorded') throw new Error('injected refutation transition crash');
	};
	const apply = createApplyQualityAnswerNode(f.runtime);
	await assert.rejects(apply({ snapshot: blocked, humanResponse: answer }), /injected refutation transition crash/);
	assert.equal(f.store.getPendingInterrupt(f.runId), null);
	assert.equal(f.store.getRun(f.runId).pendingInterruptId, pending.interruptId);
	f.runtime.onBoundary = async () => {};
	const recovered = await apply({ snapshot: blocked, humanResponse: answer });
	assert.equal(recovered.snapshot.state, 'READY_FOR_GIT_APPROVAL');
	assert.equal(recovered.snapshot.pendingInterruptId, null);
	assert.doesNotThrow(() => assertQualityDeliveryAllowed(f.runtime, recovered.snapshot));
	assert.equal(f.store.listCriticReviews(f.runId).filter(review => review.phase === 'qa').length, 3);
	assert.equal(f.store.listEvents(f.runId).filter(event => event.payload.qualityHumanRefutation).length, 1);
});
