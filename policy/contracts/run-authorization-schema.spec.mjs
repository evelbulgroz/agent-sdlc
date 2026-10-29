import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRunAuthorization } from './run-authorization-schema.ts';

test('run authorization contracts validate permissions, path boundaries, and immutability', () => {
	const validAuth = {
		schemaVersion: '1.0.0',
		runId: '2026-09-04-auth-test',
		approvedSpecHash: 'a'.repeat(64),
		approvedPlanPolicyHash: 'b'.repeat(64),
		repositoryId: 'agent-sdlc',
		baseCommitSha: 'c'.repeat(40),
		allowedPackages: ['services/billing'],
		allowedPathPrefixes: ['services/billing/src/'],
		allowedOperations: {
			editIsolatedWorktree: true,
			runAllowlistedCommands: true,
			createDetachedWorktree: true,
			createBranch: false,
			createLocalCommits: false,
			push: false,
		},
		maxSemanticRepairs: 2,
		modelUsageProfile: 'agent-sdlc-default',
		expiresAt: new Date(Date.now() + 86400000).toISOString(),
		approvedAt: new Date().toISOString(),
		approvalMethod: 'cli_prompt',
	};

	const parsed = validateRunAuthorization(validAuth);
	assert.equal(parsed.runId, '2026-09-04-auth-test');
	assert.equal(parsed.maxSemanticRepairs, 2);
	assert.equal(parsed.allowedOperations.createBranch, false);

	// Slice 3 allows authorized local git operations with coupling rules
	const authorizedBranchOnly = validateRunAuthorization({
		...validAuth,
		allowedOperations: { ...validAuth.allowedOperations, createBranch: true },
	});
	assert.equal(authorizedBranchOnly.allowedOperations.createBranch, true);
	assert.equal(authorizedBranchOnly.targetBranch, `agent-sdlc/${validAuth.runId}`);

	const authorizedBoth = validateRunAuthorization({
		...validAuth,
		allowedOperations: {
			...validAuth.allowedOperations,
			createBranch: true,
			createLocalCommits: true,
		},
		targetBranch: 'feature/test-branch',
	});
	assert.equal(authorizedBoth.allowedOperations.createLocalCommits, true);
	assert.equal(authorizedBoth.targetBranch, 'feature/test-branch');

	// createLocalCommits without createBranch must throw
	assert.throws(
		() =>
			validateRunAuthorization({
				...validAuth,
				allowedOperations: { ...validAuth.allowedOperations, createLocalCommits: true },
			}),
		/createLocalCommits requires createBranch: true/,
	);

	// targetBranch without createBranch must throw
	assert.throws(
		() =>
			validateRunAuthorization({
				...validAuth,
				targetBranch: 'feature/bad',
			}),
		/targetBranch requires allowedOperations.createBranch: true/,
	);

	// Invalid targetBranch must throw
	assert.throws(
		() =>
			validateRunAuthorization({
				...validAuth,
				allowedOperations: { ...validAuth.allowedOperations, createBranch: true },
				targetBranch: '../escaping',
			}),
		/not a valid branch name/,
	);

	// Remote operations merge and deploy remain strictly forbidden
	for (const remoteOp of ['merge', 'deploy']) {
		assert.throws(
			() =>
				validateRunAuthorization({
					...validAuth,
					allowedOperations: { ...validAuth.allowedOperations, [remoteOp]: true },
				}),
			/is forbidden/,
		);
	}

	// push requires createLocalCommits
	assert.throws(
		() =>
			validateRunAuthorization({
				...validAuth,
				allowedOperations: {
					...validAuth.allowedOperations,
					createBranch: true,
					push: true,
				},
			}),
		/push requires createLocalCommits: true/,
	);

	// openPullRequest requires push
	assert.throws(
		() =>
			validateRunAuthorization({
				...validAuth,
				allowedOperations: {
					...validAuth.allowedOperations,
					createBranch: true,
					createLocalCommits: true,
					openPullRequest: true,
				},
			}),
		/openPullRequest requires push: true/,
	);

	// authorized push and openPullRequest when prerequisites are met
	const authorizedPr = validateRunAuthorization({
		...validAuth,
		allowedOperations: {
			...validAuth.allowedOperations,
			createBranch: true,
			createLocalCommits: true,
			push: true,
			openPullRequest: true,
		},
	});
	assert.equal(authorizedPr.allowedOperations.push, true);
	assert.equal(authorizedPr.allowedOperations.openPullRequest, true);

	// Invalid commit SHA
	assert.throws(
		() => validateRunAuthorization({ ...validAuth, baseCommitSha: 'short-sha' }),
		/40-character hex commit SHA/,
	);

	// Invalid maxSemanticRepairs (> 2)
	assert.throws(
		() => validateRunAuthorization({ ...validAuth, maxSemanticRepairs: 3 }),
		/between 0 and 2/,
	);

	// Empty allowed packages or path prefixes
	assert.throws(
		() => validateRunAuthorization({ ...validAuth, allowedPackages: [] }),
		/must be an array with at most/,
	);
	assert.throws(
		() => validateRunAuthorization({ ...validAuth, allowedPathPrefixes: [] }),
		/must be an array with at most/,
	);

	// Unsupported schema version
	assert.throws(
		() => validateRunAuthorization({ ...validAuth, schemaVersion: '2.0.0' }),
		/Unsupported runAuthorization schemaVersion/,
	);
});
