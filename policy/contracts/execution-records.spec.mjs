import assert from 'node:assert/strict';
import test from 'node:test';
import { validateGeneration, validateGitCommitRecord, validatePullRequestRecord, validateToolExecution } from './execution-records.ts';

test('generation and tool execution contracts validate strictly', () => {
	// Generation
	const validGen = {
		schemaVersion: '1.0.0',
		runId: '2026-09-04-gen-test',
		generation: 0,
		baseCommitSha: 'a'.repeat(40),
		targetTreeSha: 'b'.repeat(40),
		scopeFingerprints: { 'services/billing': 'c'.repeat(64) },
		taskOwnedPaths: ['services/billing/**'],
		materializedAt: new Date().toISOString(),
	};
	const parsedGen = validateGeneration(validGen);
	assert.equal(parsedGen.generation, 0);
	assert.throws(
		() => validateGeneration({ ...validGen, generation: -1 }),
		/non-negative integer/,
	);
	assert.throws(
		() => validateGeneration({ ...validGen, targetTreeSha: 'invalid' }),
		/40-character hex tree SHA/,
	);

	// Tool execution
	const validToolExec = {
		schemaVersion: '1.0.0',
		executionId: 'exec-1',
		runId: '2026-09-04-tool-test',
		roleId: 'implementer',
		generation: 0,
		stepIndex: 1,
		toolName: 'write_file',
		inputHash: 'd'.repeat(64),
		outputArtifact: 'e'.repeat(64),
		exitCode: 0,
		createdAt: new Date().toISOString(),
	};
	const parsedTool = validateToolExecution(validToolExec);
	assert.equal(parsedTool.toolName, 'write_file');
	assert.throws(
		() => validateToolExecution({ ...validToolExec, toolName: 'rm_rf' }),
		/not an allowlisted tool/,
	);
});

test('git commit record contract validates strictly and fails closed', () => {
	const validCommit = {
		schemaVersion: '1.0.0',
		runId: '2026-09-04-commit-test',
		targetBranch: 'agent-sdlc/2026-09-04-commit-test',
		commitSha: 'a'.repeat(40),
		treeSha: 'b'.repeat(40),
		parentSha: 'c'.repeat(40),
		message: 'feat: example commit\n\nDecisions:\n- default\n\nRemaining:\n- none\n\nTried:\n- none',
		authorName: 'sdlc-agent',
		authorEmail: 'agent@sdlc.local',
		committedAt: new Date().toISOString(),
	};
	const parsed = validateGitCommitRecord(validCommit);
	assert.equal(parsed.commitSha, 'a'.repeat(40));
	assert.equal(parsed.targetBranch, 'agent-sdlc/2026-09-04-commit-test');

	assert.throws(() => validateGitCommitRecord(null), /must be an object/);
	assert.throws(() => validateGitCommitRecord({ ...validCommit, commitSha: 'invalid' }), /40-character hex/);
	assert.throws(() => validateGitCommitRecord({ ...validCommit, treeSha: 'invalid' }), /40-character hex/);
	assert.throws(() => validateGitCommitRecord({ ...validCommit, parentSha: 'invalid' }), /40-character hex/);
	assert.throws(() => validateGitCommitRecord({ ...validCommit, message: '' }), /non-empty/);
	assert.throws(() => validateGitCommitRecord({ ...validCommit, authorName: '' }), /non-empty/);
	assert.throws(() => validateGitCommitRecord({ ...validCommit, schemaVersion: '2.0.0' }), /Unsupported/);
});

test('pull request record contract validates strictly and covers shadow paths', () => {
	const valid = {
		schemaVersion: '1.0.0',
		runId: '2026-09-08-pr-test',
		prUrl: 'https://github.com/evelbulgroz/agent-sdlc/pull/42',
		prNumber: 42,
		draft: true,
		branchName: 'agent-sdlc/2026-09-08-pr-test',
		baseBranch: 'main',
		createdAt: new Date().toISOString(),
	};

	// 1. Happy path
	const record = validatePullRequestRecord(valid);
	assert.equal(record.prNumber, 42);
	assert.equal(record.draft, true);
	assert.equal(record.prUrl, 'https://github.com/evelbulgroz/agent-sdlc/pull/42');

	// 2. Nil / null input path
	assert.throws(() => validatePullRequestRecord(null), /must be an object/);
	assert.throws(() => validatePullRequestRecord(undefined), /must be an object/);

	// 3. Empty / zero-length payload path
	assert.throws(() => validatePullRequestRecord({ ...valid, prUrl: '' }), /non-empty string/);
	assert.throws(() => validatePullRequestRecord({ ...valid, branchName: '' }), /non-empty string/);
	assert.throws(() => validatePullRequestRecord({ ...valid, prNumber: 0 }), /must be a positive integer/);

	// 4. Invalid URL / type / timestamp
	assert.throws(() => validatePullRequestRecord({ ...valid, prUrl: 'ftp://invalid' }), /valid HTTP or HTTPS URL/);
	assert.throws(() => validatePullRequestRecord({ ...valid, draft: 'true' }), /must be a boolean/);
	assert.throws(() => validatePullRequestRecord({ ...valid, createdAt: 'not-a-date' }), /must be an ISO timestamp/);
	assert.throws(() => validatePullRequestRecord({ ...valid, extraField: true }), /unknown field/);
});
