import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { sha256 } from '../policy/contracts/primitives.ts';
import { hashEvidenceBytes } from './evidence-files.ts';
import { qualify } from './evidence-qualification-fixture.mjs';

export const H = 'a'.repeat(64);
export const TREE = 'b'.repeat(40);

export async function fixture(fn, layer = 'unit') {
	const root = path.resolve(`.evidence-fixture-${crypto.randomUUID()}`);
	const artifacts = path.join(root, 'operation');
	fs.mkdirSync(artifacts, { recursive: true });
	fs.mkdirSync(path.join(root, 'src'));
	fs.writeFileSync(path.join(root, 'src/code.ts'), 'export const ready = true;\r\n');
	fs.writeFileSync(path.join(root, 'src/check.spec.ts'), 'assert(ready);\n');
	fs.writeFileSync(path.join(root, 'src/adapter.mjs'), 'frozen bundle\r\n');
	const receipt = qualify(root, 'src/config.json', TREE, H);
	fs.writeFileSync(path.join(root, 'src/dependency.mjs'), 'frozen dependency\n');
	const capabilities = layer === 'browser' ? ['native-browser', 'native-file-picker', 'focus-navigation'] : [];
	const registration = {
		adapterId: `fake-${layer}`, protocolVersion: '1.0.0',
		bundleFiles: [{ path: 'src/adapter.mjs', sha256: hashEvidenceBytes(fs.readFileSync(path.join(root, 'src/adapter.mjs'))) }],
		dependencyFiles: [{ path: 'src/dependency.mjs', sha256: hashEvidenceBytes(fs.readFileSync(path.join(root, 'src/dependency.mjs'))) }],
		configurationFiles: [{ path: 'src/config.json', sha256: hashEvidenceBytes(fs.readFileSync(path.join(root, 'src/config.json'))) }],
		argv: [fs.realpathSync(process.execPath), '--profile', layer],
		executableSha256: hashEvidenceBytes(fs.readFileSync(process.execPath)),
		profiles: [{ profileId: layer, layers: [layer], capabilities }],
		...receipt,
		limits: { timeoutMs: 1000, maxReportBytes: 16384, maxArtifactBytes: 2048, maxArtifacts: 2 },
	};
	const bindingHash = sha256(registration);
	const request = {
		schemaVersion: '1.0.0', operationId: 'op-1',
		binding: {
			runId: '2026-11-01-evidence', approvedSpecHash: H, taskPlanHash: H, qualityPolicyHash: H,
			checkpointId: 'task-1', checkpointKind: 'task', ownerId: 'task-1', candidateRevision: 0,
			baseCommitSha: TREE, treeSha: TREE, revisionSetHash: H, preparationHash: H,
		},
		adapterBindingHash: bindingHash, profileId: layer,
		obligations: [{
			obligationId: 'obligation-1', criterionId: 'AC-01', caseId: 'AC-01.1',
			owner: { kind: 'task', id: 'task-1' }, observableOutcome: 'ready state visible',
			setupAction: 'activate the control', expectedResult: 'the ready state is asserted',
			layer, requiredCapabilities: capabilities, implementationPaths: ['src/code.ts'],
			testCases: [{ file: 'src/check.spec.ts', caseKey: 'ready' }],
			adapterBindingHash: bindingHash, profileId: layer,
		}], artifactDirectory: artifacts,
	};
	const observation = { treeSha: TREE, sourceHash: H, preparationHash: H };
	const qualityPolicy = {
		schemaVersion: '1.0.0', policyId: 'checkpoint-evidence-v1',
		additionalCandidateReviews: 1, followUpDispatches: 1, testRetryPolicy: 'clean-success',
		retrieval: { maxPacketBytes: 24576, maxPacketLines: 1000, maxTotalBytesPerCandidate: 49152, maxTotalLinesPerCandidate: 2000 },
		execution: { maxInvocations: 20, maxTotalDurationMs: 20000 },
		review: { maxLogicalDispatches: 20, maxPhysicalCalls: 20, maxInputTokens: 20000, maxOutputTokens: 20000 },
	};
	request.binding.qualityPolicyHash = sha256(qualityPolicy);
	const context = {
		worktreeDir: root, worktreeRegistryId: 'worktree-1', artifactDirectory: artifacts,
		targetPackage: 'src', frozenAdapterBindingHash: bindingHash, expectedSourceHash: H,
		allowedArgv: [registration.argv],
		authorization: {
			runId: request.binding.runId, approvedSpecHash: H, baseCommitSha: TREE,
			allowedPackages: ['src'], allowedPathPrefixes: ['src'],
			allowedOperations: { runAllowlistedCommands: true }, expiresAt: '2099-01-01T00:00:00Z',
			qualityPlan: { qualityPolicy, adapterBindings: structuredClone([registration]), evidenceObligations: structuredClone(request.obligations) },
		},
		observeSource: async () => ({ ...observation }),
	};
	let durable = null;
	let completion = null;
	const events = [];
	const store = {
		async reserve(record) {
			events.push('reserve');
			if (durable) return { kind: 'existing', invocation: durable, ...(completion ? { completion } : {}) };
			durable = structuredClone(record);
			return { kind: 'reserved' };
		},
		async started(record) { events.push('running'); durable = structuredClone(record); },
		async complete(record) { events.push('complete'); completion = structuredClone(record); durable = completion.invocation; },
	};
	const report = () => ({
		schemaVersion: '1.0.0', operationId: request.operationId, requestHash: sha256(request),
		adapterBindingHash: request.adapterBindingHash, profileId: request.profileId,
		cases: [{
			file: 'src/check.spec.ts', caseKey: 'ready', obligationIds: ['obligation-1'],
			exercisedCapabilities: capabilities, outcome: 'passed',
			attempts: [{ index: 0, outcome: 'passed', durationMs: 3, artifactPaths: [] }],
		}], artifacts: [],
	});
	let spawns = 0;
	const spawn = (command, args, options) => {
		spawns++;
		events.push('spawn');
		assert.equal(command, fs.realpathSync(process.execPath));
		assert.deepEqual(args, ['--profile', layer]);
		assert.equal(options.shell, false);
		assert.equal(options.cwd, root);
		assert.deepEqual(options.env, {});
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = (signal) => { queueMicrotask(() => child.emit('close', null, signal)); return true; };
		child.stdin = new Writable({
			write(chunk, encoding, callback) {
				assert.deepEqual(JSON.parse(chunk.toString()), request);
				callback();
			},
			final(callback) {
				callback();
				queueMicrotask(() => {
					child.stdout.write(JSON.stringify(report()));
					child.emit('close', 0, null);
				});
			},
		});
		return child;
	};
	try {
		await fn({
			root, artifacts, request, registration, context, observation, store, events, report, spawn,
			spawns: () => spawns, durable: () => durable, completion: () => completion,
		});
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
}
