import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { sha256 } from '../policy/contracts.ts';
import { hashEvidenceBytes } from './evidence-files.ts';
import { qualify } from './evidence-qualification-fixture.mjs';
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
	const qualification = qualify(root, 'runtime/qualification.json', TREE, H);
	fs.writeFileSync(path.join(root, 'runtime/adapter.mjs'), `
		import fs from 'node:fs';
		const request = JSON.parse(fs.readFileSync(0, 'utf8'));
		if (process.env.DRIFT) fs.writeFileSync('runtime/dependency', 'changed');
		console.log(JSON.stringify({schemaVersion:'1.0.0',operationId:request.operationId,
			requestHash:process.env.REQUEST_HASH,
			adapterBindingHash:request.adapterBindingHash,profileId:'unit',
			cases:[{file:'src/case.mjs',caseKey:'visible',obligationIds:['visible'],
				exercisedCapabilities:[],outcome:'passed',
				attempts:[{index:0,outcome:'passed',durationMs:1,artifactPaths:[]}]}],artifacts:[]}));
	`);
	const file = relative => ({ path: relative,
		sha256: hashEvidenceBytes(fs.readFileSync(path.join(root, relative))) });
	fs.writeFileSync(path.join(root, 'runtime/dependencies.json'), JSON.stringify({
		schemaVersion: '1.0.0', files: [file('runtime/dependency')],
	}));
	const adapter = { adapterId: 'manifest-fixture', protocolVersion: '1.0.0',
		bundleFiles: [file('runtime/adapter.mjs')], dependencyFiles: [], configurationFiles: [],
		dependencyManifest: file('runtime/dependencies.json'),
		argv: [fs.realpathSync(process.execPath), 'runtime/adapter.mjs'],
		executableSha256: hashEvidenceBytes(fs.readFileSync(process.execPath)),
		profiles: [{ profileId: 'unit', layers: ['unit'], capabilities: [] }],
		...qualification,
		limits: { timeoutMs: 2000, maxReportBytes: 4096, maxArtifactBytes: 1024, maxArtifacts: 1 } };
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
		environment: { REQUEST_HASH: sha256(request) },
		targetPackage: 'src', frozenAdapterBindingHash: sha256(adapter), expectedSourceHash: H,
		allowedArgv: [adapter.argv], observeSource: async () => ({ treeSha: TREE, sourceHash: H, preparationHash: H }),
		authorization: { runId: request.binding.runId, approvedSpecHash: H, baseCommitSha: TREE,
			allowedPackages: ['src'], allowedPathPrefixes: ['src/case.mjs'],
			allowedOperations: { runAllowlistedCommands: true }, expiresAt: '2099-01-01T00:00:00Z',
			qualityPlan: { qualityPolicy: policy, adapterBindings: [adapter], evidenceObligations: request.obligations } } };
	let completion, invocation, calls = 0;
	const store = {
		async reserve(record) { if (completion) return { kind: 'existing', invocation, completion };
			invocation = record; return { kind: 'reserved' }; },
		async started(record) { invocation = record; },
		async complete(record) { completion = record; invocation = record.invocation; },
	};
	return { root, adapter, context, request, run: () => executeEvidence(request, adapter, context,
		(...args) => { calls++; return spawn(...args); }, store), calls: () => calls };
}

test('approved frozen read closure stays outside edit scope and is reverified on receipt reuse', async t => {
	const f = fixture(t);
	assert.equal((await f.run()).receipt.status, 'passed');
	assert.equal((await f.run()).reused, true);
	assert.equal(f.calls(), 1);
	fs.writeFileSync(path.join(f.root, 'runtime/dependency'), 'changed');
	await assert.rejects(f.run(), /frozen-adapter-file-changed/);
	assert.equal(f.calls(), 1);
});

for (const stage of ['before', 'after']) test(`manifest dependency drift ${stage} dispatch cannot pass`, async t => {
	const f = fixture(t);
	if (stage === 'before') fs.writeFileSync(path.join(f.root, 'runtime/dependency'), 'changed');
	else f.context.environment.DRIFT = '1';
	const result = await f.run();
	assert.equal(result.receipt.status, 'incomplete');
	assert.deepEqual(result.receipt.dischargedObligationIds, []);
	assert.equal(result.invocation.failureReason, 'frozen-adapter-file-changed');
	assert.equal(f.calls(), stage === 'before' ? 0 : 1);
});

test('a different manifest binding cannot be substituted into authorization', async t => {
	const f = fixture(t);
	f.context.authorization.qualityPlan = structuredClone(f.context.authorization.qualityPlan);
	f.context.authorization.qualityPlan.adapterBindings[0].dependencyManifest.sha256 = crypto.randomBytes(32).toString('hex');
	await assert.rejects(f.run(), /evidence-quality-plan-not-authorized/);
	assert.equal(f.calls(), 0);
});
