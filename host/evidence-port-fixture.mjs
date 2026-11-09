import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../policy/contracts/primitives.ts';
import { hashEvidenceBytes } from './evidence-files.ts';
import { CommandRegistrationSchema } from '../policy/contracts/quality-evidence-schema.ts';
import { commandBindingHash, recordPins } from './command-evidence.ts';

export const H = 'a'.repeat(64);
export const TREE = 'b'.repeat(40);

export async function fixture(fn, layer = 'unit') {
	const root = path.resolve(`.evidence-fixture-${crypto.randomUUID()}`);
	const artifacts = path.join(root, 'operation');
	fs.mkdirSync(artifacts, { recursive: true });
	fs.mkdirSync(path.join(root, 'src'));
	fs.writeFileSync(path.join(root, 'src/code.ts'), 'export const ready = true;\r\n');
	fs.writeFileSync(path.join(root, 'src/check.spec.ts'), 'assert(ready);\n');
	fs.writeFileSync(path.join(root, 'src/dependency.mjs'), 'frozen dependency\n');
	fs.writeFileSync(path.join(root, 'src/config.json'), '{}\n');
	const capabilities = layer === 'browser' ? ['native-browser', 'native-file-picker', 'focus-navigation'] : [];
	const executable = { path: fs.realpathSync(process.execPath), sha256: hashEvidenceBytes(fs.readFileSync(process.execPath)) };
	const pins = recordPins(root, 'src', [{ file: 'dependency.mjs' }, { file: 'config.json' }]);
	const argv = [executable.path, '--profile', layer];
	const registration = CommandRegistrationSchema.parse({
		kind: 'command', adapterId: `fake-${layer}`, protocolVersion: '1.0.0', argv, cwd: 'src', reportFormat: 'junit',
		retries: 0, executable, pins, commandSha256: commandBindingHash(argv, executable.sha256, pins),
		profiles: [{ profileId: layer, layers: [layer], capabilities }],
		limits: { timeoutMs: 1000, maxReportBytes: 16384, maxArtifactBytes: 2048, maxArtifacts: 2 },
	});
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
	const passedCases = () => [{ identity: 'AC-01.1', outcome: 'passed', message: '', attempts: 1 }];
	const reportBytes = Buffer.from('<testsuites/>');
	const behavior = { run: async () => ({ exitCode: 0, cases: passedCases(), reportBytes }) };
	let runs = 0;
	const runCommand = async (...args) => {
		runs++;
		events.push('run');
		return behavior.run(...args);
	};
	const spawn = Object.assign(() => assert.fail('command evidence must not spawn an adapter'), { runCommand });
	try {
		await fn({
			root, artifacts, request, registration, context, observation, store, events, behavior, spawn,
			passedCases, reportBytes, runs: () => runs, durable: () => durable, completion: () => completion,
		});
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
}
