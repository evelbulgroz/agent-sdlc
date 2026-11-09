import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sha256 } from '../policy/contracts.ts';
import { CommandRegistrationSchema } from '../policy/contracts/quality-evidence-schema.ts';
import { commandBindingHash, recordPins } from './command-evidence.ts';
import { hashEvidenceBytes } from './evidence-files.ts';
import { executeEvidence } from './evidence-port.ts';

const H = 'a'.repeat(64), TREE = 'b'.repeat(40);

function fixture(t) {
	const root = fs.mkdtempSync(path.resolve('.evidence-manifest-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, 'artifacts'));
	fs.mkdirSync(path.join(root, 'src'));
	fs.mkdirSync(path.join(root, 'runtime'));
	fs.writeFileSync(path.join(root, 'src/case.mjs'), 'assert visible\n');
	fs.writeFileSync(path.join(root, 'runtime/dependency'), 'frozen');
	const executable = { path: fs.realpathSync(process.execPath), sha256: hashEvidenceBytes(fs.readFileSync(process.execPath)) };
	const pins = recordPins(root, 'runtime', [{ file: 'dependency' }]);
	const argv = [executable.path, 'run.mjs'];
	const adapter = CommandRegistrationSchema.parse({ kind: 'command', adapterId: 'manifest-fixture', protocolVersion: '1.0.0',
		argv, cwd: 'runtime', reportFormat: 'junit', retries: 0, executable, pins,
		commandSha256: commandBindingHash(argv, executable.sha256, pins),
		profiles: [{ profileId: 'unit', layers: ['unit'], capabilities: [] }],
		limits: { timeoutMs: 2000, maxReportBytes: 4096, maxArtifactBytes: 1024, maxArtifacts: 1 } });
	const policy = { schemaVersion: '1.0.0', policyId: 'checkpoint-evidence-v1',
		additionalCandidateReviews: 1, followUpDispatches: 1, testRetryPolicy: 'clean-success',
		retrieval: { maxPacketBytes: 24576, maxPacketLines: 1000, maxTotalBytesPerCandidate: 49152, maxTotalLinesPerCandidate: 2000 },
		execution: { maxInvocations: 48, maxTotalDurationMs: 1800000 },
		review: { maxLogicalDispatches: 12, maxPhysicalCalls: 24, maxInputTokens: 480000, maxOutputTokens: 144000 } };
	const request = { schemaVersion: '1.0.0', operationId: 'manifest-op',
		binding: { runId: '2026-11-02-manifest', approvedSpecHash: H, taskPlanHash: H,
			qualityPolicyHash: sha256(policy), checkpointId: 'task', checkpointKind: 'task',
			ownerId: 'task', candidateRevision: 0, baseCommitSha: TREE, treeSha: TREE,
			revisionSetHash: H, preparationHash: H },
		adapterBindingHash: sha256(adapter), profileId: 'unit', artifactDirectory: path.join(root, 'artifacts'),
		obligations: [{ obligationId: 'visible', criterionId: 'AC-01', caseId: 'AC-01.1',
			owner: { kind: 'task', id: 'task' }, observableOutcome: 'visible', setupAction: 'activate',
			expectedResult: 'visible', layer: 'unit', requiredCapabilities: [],
			implementationPaths: ['src/case.mjs'], testCases: [{ file: 'src/case.mjs', caseKey: 'visible' }],
			adapterBindingHash: sha256(adapter), profileId: 'unit' }] };
	const context = { worktreeDir: root, worktreeRegistryId: 'fixture', artifactDirectory: request.artifactDirectory,
		targetPackage: 'src', frozenAdapterBindingHash: sha256(adapter), expectedSourceHash: H,
		allowedArgv: [adapter.argv], observeSource: async () => ({ treeSha: TREE, sourceHash: H, preparationHash: H }),
		authorization: { runId: request.binding.runId, approvedSpecHash: H, baseCommitSha: TREE,
			allowedPackages: ['src'], allowedPathPrefixes: ['src/case.mjs'],
			allowedOperations: { runAllowlistedCommands: true }, expiresAt: '2099-01-01T00:00:00Z',
			qualityPlan: { qualityPolicy: policy, adapterBindings: [adapter], evidenceObligations: request.obligations } } };
	let completion, invocation, calls = 0;
	const behavior = { drift: false };
	const store = {
		async reserve(record) { if (completion) return { kind: 'existing', invocation, completion };
			invocation = record; return { kind: 'reserved' }; },
		async started(record) { invocation = record; },
		async complete(record) { completion = record; invocation = record.invocation; },
	};
	const spawn = Object.assign(() => assert.fail('command evidence must not spawn an adapter'), {
		runCommand: async () => {
			calls++;
			if (behavior.drift) fs.writeFileSync(path.join(root, 'runtime/dependency'), 'changed');
			return { exitCode: 0, reportBytes: Buffer.from('<testsuites/>'),
				cases: [{ identity: 'AC-01.1', outcome: 'passed', message: '', attempts: 1 }] };
		},
	});
	return { root, adapter, context, request, behavior, run: () => executeEvidence(request, adapter, context, spawn, store),
		calls: () => calls };
}

test('approved pinned read closure stays outside edit scope and is reverified on receipt reuse', async t => {
	const f = fixture(t);
	assert.equal((await f.run()).receipt.status, 'passed');
	assert.equal((await f.run()).reused, true);
	assert.equal(f.calls(), 1);
	fs.writeFileSync(path.join(f.root, 'runtime/dependency'), 'changed');
	await assert.rejects(f.run(), /PINNED_FILE_MODIFIED/);
	assert.equal(f.calls(), 1);
});

for (const stage of ['before', 'after']) test(`pinned dependency drift ${stage} dispatch cannot pass`, async t => {
	const f = fixture(t);
	if (stage === 'before') fs.writeFileSync(path.join(f.root, 'runtime/dependency'), 'changed');
	else f.behavior.drift = true;
	const result = await f.run();
	assert.equal(result.receipt.status, 'incomplete');
	assert.deepEqual(result.receipt.dischargedObligationIds, []);
	assert.equal(result.invocation.failureReason, 'PINNED_FILE_MODIFIED');
	assert.equal(f.calls(), stage === 'before' ? 0 : 1);
});

test('a different pin binding cannot be substituted into authorization', async t => {
	const f = fixture(t);
	f.context.authorization.qualityPlan = structuredClone(f.context.authorization.qualityPlan);
	f.context.authorization.qualityPlan.adapterBindings[0].pins[0].sha256 = crypto.randomBytes(32).toString('hex');
	await assert.rejects(f.run(), /evidence-quality-plan-not-authorized/);
	assert.equal(f.calls(), 0);
});
