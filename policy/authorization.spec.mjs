import '../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createDefaultAuthorizationEnvelope,
	deriveScopeFromDraft,
	validateAuthorizationEnvelope,
} from './authorization.ts';
import {
	createAuthorizationInterrupt,
	validatePendingResponse,
} from '../cli/hitl.ts';

test('createDefaultAuthorizationEnvelope creates valid, bounded default envelopes', () => {
	const runId = '2026-09-04-auth-envelope-test';
	const approvedSpecHash = 'a'.repeat(64);
	const baseCommitSha = 'b'.repeat(40);
	const allowedPackages = ['apps/services/conditioning'];
	const allowedPathPrefixes = ['apps/services/conditioning/src/'];

	const envelope = createDefaultAuthorizationEnvelope({
		runId,
		approvedSpecHash,
		baseCommitSha,
		allowedPackages,
		allowedPathPrefixes,
	});

	assert.equal(envelope.runId, runId);
	assert.equal(envelope.approvedSpecHash, approvedSpecHash);
	assert.equal(envelope.baseCommitSha, baseCommitSha);
	assert.equal(envelope.allowedOperations.editIsolatedWorktree, true);
	assert.equal(envelope.allowedOperations.createBranch, false);
	assert.equal(envelope.allowedOperations.createLocalCommits, false);
	assert.equal(envelope.allowedOperations.push, false);
	assert.equal(envelope.allowedOperations.openPullRequest, false);
	assert.equal(envelope.maxSemanticRepairs, 2);
	assert.ok(Date.parse(envelope.expiresAt) > Date.now());

	// Can authorize push and openPullRequest when prerequisites (createBranch, createLocalCommits) are met
	const prEnvelope = createDefaultAuthorizationEnvelope({
		runId,
		approvedSpecHash,
		baseCommitSha,
		allowedPackages,
		allowedPathPrefixes,
		createBranch: true,
		createLocalCommits: true,
		push: true,
		openPullRequest: true,
	});
	assert.equal(prEnvelope.allowedOperations.createBranch, true);
	assert.equal(prEnvelope.allowedOperations.createLocalCommits, true);
	assert.equal(prEnvelope.allowedOperations.push, true);
	assert.equal(prEnvelope.allowedOperations.openPullRequest, true);
});

test('validateAuthorizationEnvelope enforces SHA equality, expiration, and path containment', () => {
	const runId = '2026-09-04-auth-val-test';
	const specHash = '1'.repeat(64);
	const commitSha = '2'.repeat(40);
	const now = new Date('2026-09-04T12:00:00.000Z');

	const valid = createDefaultAuthorizationEnvelope({
		runId,
		approvedSpecHash: specHash,
		baseCommitSha: commitSha,
		allowedPackages: ['apps/services/conditioning'],
		allowedPathPrefixes: ['apps/services/conditioning/src/'],
		now,
	});

	test('authorization binds the separate task manifest hash', () => {
		const manifestHash = '3'.repeat(64);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: '2026-09-04-auth-manifest-test',
			approvedSpecHash: '1'.repeat(64),
			taskManifestHash: manifestHash,
			baseCommitSha: '2'.repeat(40),
			allowedPackages: ['tools'],
			allowedPathPrefixes: ['tools/agent-sdlc'],
		});
		assert.equal(envelope.taskManifestHash, manifestHash);
		assert.equal(
			validateAuthorizationEnvelope(envelope, {
				currentSpecHash: envelope.approvedSpecHash,
				currentTaskManifestHash: manifestHash,
			}).taskManifestHash,
			manifestHash,
		);
		assert.throws(
			() =>
				validateAuthorizationEnvelope(envelope, {
					currentSpecHash: envelope.approvedSpecHash,
					currentTaskManifestHash: '4'.repeat(64),
				}),
			(error) =>
				error.code === 'AUTHORIZATION_INVALID' &&
				/Task manifest hash mismatch/.test(error.message),
		);
	});

	// Valid with matching context
	const parsed = validateAuthorizationEnvelope(valid, {
		currentBaseCommitSha: commitSha,
		currentSpecHash: specHash,
		now,
	});
	assert.equal(parsed.runId, runId);

	// Mismatched base commit SHA fails closed
	assert.throws(
		() =>
			validateAuthorizationEnvelope(valid, {
				currentBaseCommitSha: '3'.repeat(40),
				currentSpecHash: specHash,
				now,
			}),
		(error) =>
			error.code === 'AUTHORIZATION_INVALID' &&
			/Base commit SHA mismatch/.test(error.message),
	);

	// Mismatched spec hash fails closed
	assert.throws(
		() =>
			validateAuthorizationEnvelope(valid, {
				currentBaseCommitSha: commitSha,
				currentSpecHash: '4'.repeat(64),
				now,
			}),
		(error) =>
			error.code === 'AUTHORIZATION_INVALID' &&
			/Approved spec hash mismatch/.test(error.message),
	);

	// Expired envelope fails closed
	const expiredNow = new Date('2026-09-06T12:00:00.000Z');
	assert.throws(
		() =>
			validateAuthorizationEnvelope(valid, {
				currentBaseCommitSha: commitSha,
				currentSpecHash: specHash,
				now: expiredNow,
			}),
		(error) =>
			error.code === 'AUTHORIZATION_EXPIRED' &&
			/has expired/.test(error.message),
	);

	// Path containment: prefix traversal is rejected
	assert.throws(
		() =>
			validateAuthorizationEnvelope(
				{
					...valid,
					allowedPathPrefixes: ['apps/services/conditioning/../../etc/'],
				},
				{ now },
			),
		(error) =>
			error.code === 'PATH_CONTAINMENT_VIOLATION' &&
			/traversal characters/.test(error.message),
	);

	// Path containment: prefix outside allowedPackages is rejected
	assert.throws(
		() =>
			validateAuthorizationEnvelope(
				{
					...valid,
					allowedPackages: ['apps/services/conditioning'],
					allowedPathPrefixes: ['apps/services/user/src/'],
				},
				{ now },
			),
		(error) =>
			error.code === 'PATH_CONTAINMENT_VIOLATION' &&
			/outside allowedPackages/.test(error.message),
	);

	const lockfileScoped = createDefaultAuthorizationEnvelope({
		runId,
		approvedSpecHash: specHash,
		baseCommitSha: commitSha,
		allowedPackages: ['packages/ddd-base'],
		allowedPathPrefixes: ['packages/ddd-base/package.json', 'pnpm-lock.yaml'],
		now,
	});
	assert.deepEqual(
		validateAuthorizationEnvelope(lockfileScoped, { now }).allowedPathPrefixes,
		['packages/ddd-base/package.json', 'pnpm-lock.yaml'],
	);

	assert.throws(
		() =>
			validateAuthorizationEnvelope(
				{
					...lockfileScoped,
					allowedPathPrefixes: ['package.json'],
				},
				{ now },
			),
		(error) =>
			error.code === 'PATH_CONTAINMENT_VIOLATION' &&
			/outside allowedPackages/.test(error.message),
	);

	assert.throws(
		() =>
			validateAuthorizationEnvelope(
				{
					...lockfileScoped,
					allowedPathPrefixes: ['pnpm-lock.yaml/other'],
				},
				{ now },
			),
		(error) =>
			error.code === 'PATH_CONTAINMENT_VIOLATION' &&
			/outside allowedPackages/.test(error.message),
	);
});

test('HITL authorization interrupt creates payload and validates affirmative human response', () => {
	const runId = '2026-09-04-hitl-auth-test';
	const specHash = 'a'.repeat(64);
	const commitSha = 'b'.repeat(40);
	const envelope = createDefaultAuthorizationEnvelope({
		runId,
		approvedSpecHash: specHash,
		baseCommitSha: commitSha,
		allowedPackages: ['apps/services/conditioning'],
		allowedPathPrefixes: ['apps/services/conditioning/src/'],
	});

	const interrupt = createAuthorizationInterrupt({
		runId,
		runtimeRevision: 5,
		approvedSpecHash: specHash,
		baseCommitSha: commitSha,
		candidateEnvelope: envelope,
	});

	assert.equal(interrupt.payload.kind, 'authorization');
	assert.ok(interrupt.interruptId);
	assert.ok(interrupt.stateHash);

	// Valid response passes
	const pendingState = {
		runId,
		runtimeRevision: 5,
		state: 'WAITING_FOR_AUTHORIZATION',
	};
	const validResponse = {
		interruptId: interrupt.interruptId,
		stateHash: interrupt.stateHash,
		envelope,
	};
	const result = validatePendingResponse({
		state: pendingState,
		interrupt: {
			kind: 'authorization',
			interruptId: interrupt.interruptId,
			stateHash: interrupt.stateHash,
		},
		request: interrupt.payload,
		response: validResponse,
		draft: null,
	});
	assert.equal(result.response.runId, runId);

	// Stale interrupt ID throws
	assert.throws(
		() =>
			validatePendingResponse({
				state: pendingState,
				interrupt: {
					kind: 'authorization',
					interruptId: interrupt.interruptId,
					stateHash: interrupt.stateHash,
				},
				request: interrupt.payload,
				response: { ...validResponse, interruptId: 'wrong-interrupt' },
				draft: null,
			}),
		(error) => error.code === 'STALE_RESPONSE',
	);
});

test('@ac AC-01 @case AC-01.1 deriveScopeFromDraft includes packages implied by touchedSurfaces beyond owningContext', () => {
	const draft = {
		owningContext: 'apps/services/conditioning',
		touchedSurfaces: [
			'apps/services/conditioning/src/conditioning/domain/conditioning-log.entity.ts',
			'apps/frontends/example-pwa-frontend/src/ui/SessionMetadata.tsx',
			'docs/specs/artifacts/conditioning-log-property-rule-matrix.md',
		],
	};

	const { allowedPackages, allowedPathPrefixes } = deriveScopeFromDraft(draft);

	assert.deepEqual(
		[...allowedPackages].sort(),
		['apps/frontends/example-pwa-frontend', 'apps/services/conditioning', 'docs'],
	);
	assert.deepEqual(allowedPathPrefixes, [
		'apps/services/conditioning/src/conditioning/domain/conditioning-log.entity.ts',
		'apps/frontends/example-pwa-frontend/src/ui/SessionMetadata.tsx',
		'docs/specs/artifacts/conditioning-log-property-rule-matrix.md',
	]);
});

test('@ac AC-01 @case AC-01.2 deriveScopeFromDraft falls back to owningContext package when touchedSurfaces is empty', () => {
	const draft = { owningContext: 'apps/services/conditioning', touchedSurfaces: [] };

	const { allowedPackages, allowedPathPrefixes } = deriveScopeFromDraft(draft);

	assert.deepEqual(allowedPackages, ['apps/services/conditioning']);
	assert.deepEqual(allowedPathPrefixes, ['apps/services/conditioning']);
});

test('@ac AC-01 @case AC-01.3 deriveScopeFromDraft incorporates taskManifest pathPrefixes and targetPackage', () => {
	const draft = {
		owningContext: 'apps/frontends/example-pwa-frontend',
		touchedSurfaces: [
			'apps/frontends/example-pwa-frontend/src/domain/summary.ts',
		],
	};
	const taskManifest = {
		tasks: [
			{
				taskId: 'task-1',
				targetPackage: 'apps/frontends/example-pwa-frontend',
				pathPrefixes: [
					'apps/frontends/example-pwa-frontend/src/domain',
					'apps/frontends/example-pwa-frontend/src/ui',
				],
			},
		],
	};

	const { allowedPackages, allowedPathPrefixes } = deriveScopeFromDraft(draft, taskManifest);

	assert.deepEqual(allowedPackages, ['apps/frontends/example-pwa-frontend']);
	assert.deepEqual(allowedPathPrefixes, [
		'apps/frontends/example-pwa-frontend/src/domain/summary.ts',
		'apps/frontends/example-pwa-frontend/src/domain',
		'apps/frontends/example-pwa-frontend/src/ui',
	]);
});

test('deriveScopeFromDraft remains the sole authorization scope deriver for a cross-package touched surface', () => {
	const draft = {
		owningContext: 'apps/services/conditioning',
		touchedSurfaces: ['apps/frontends/example-pwa-frontend/src/ui/SessionDetailPage.tsx'],
	};

	const { allowedPackages, allowedPathPrefixes } = deriveScopeFromDraft(draft);

	assert.deepEqual(
		[...allowedPackages].sort(),
		['apps/frontends/example-pwa-frontend', 'apps/services/conditioning'],
	);
	assert.deepEqual(allowedPathPrefixes, [
		'apps/frontends/example-pwa-frontend/src/ui/SessionDetailPage.tsx',
	]);
});

test('@ac AC-01 deriveScopeFromDraft with no touched surfaces and no owning context yields empty lists', () => {
	assert.deepEqual(deriveScopeFromDraft({}), {
		allowedPackages: [],
		allowedPathPrefixes: [],
	});
	assert.deepEqual(deriveScopeFromDraft(null), {
		allowedPackages: [],
		allowedPathPrefixes: [],
	});
});
