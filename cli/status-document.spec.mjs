import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { formatPullRequestBody } from '../adapters/github-pr.ts';
import { buildStatusDocument, mapToSchemaV1TaskStatus } from './status-document.ts';

const INPUT = {
	state: {
		runId: 'run-1',
		state: 'PLANNING_TASKS',
		runtimeRevision: 1,
		semanticRepairsCount: 0,
		draftHash: 'draft',
		pendingInterruptId: null,
		updatedAt: '2026-10-22T00:00:00.000Z',
	},
	reservation: {
		projectionRevision: 1,
		updatedAt: '2026-10-22T00:00:00.000Z',
		git: { branch: 'main', headSha: 'abc', worktreePath: null, dirty: false },
		stateHash: 'state',
	},
	auth: null,
	taskPlan: null,
	continuation: { action: 'resume', reason: 'INFRASTRUCTURE_RETRY' },
	hostInvocation: { argv: ['pnpm', 'run', 'agent:sdlc', '--', 'resume'] },
	rootDir: '/tmp/repo',
	runDir: '/tmp/repo/run',
	eventLogHash: 'event',
};

test('@ac AC-04 @case AC-04.4 the status document builder is pure and stable', () => {
	const originalRead = fs.readFileSync;
	const originalExists = fs.existsSync;
	fs.readFileSync = () => {
		throw new Error('status document builder read the file system');
	};
	fs.existsSync = () => {
		throw new Error('status document builder read the file system');
	};
	try {
		const first = buildStatusDocument(INPUT);
		const second = buildStatusDocument(INPUT);
		assert.equal(first.orchestration.projectionHash, second.orchestration.projectionHash);
		assert.equal(typeof first.orchestration.projectionHash, 'string');
		assert.equal(first.tasks.length, 0);
	} finally {
		fs.readFileSync = originalRead;
		fs.existsSync = originalExists;
	}
});

test('an unlisted task status stays pending', () => {
	assert.equal(mapToSchemaV1TaskStatus('not-a-status'), 'pending');
	assert.equal(mapToSchemaV1TaskStatus(undefined), 'pending');
	assert.equal(mapToSchemaV1TaskStatus('failed'), 'blocked');
});

test('@ac AC-02 @case AC-02.1 buildStatusDocument in READY_FOR_GIT_APPROVAL with exit-code-only verify projects lastCommand npm test and resultFile null without reading fs, and formatPullRequestBody defaults verifyCommand to npm test when omitted', () => {
	const originalRead = fs.readFileSync;
	const originalExists = fs.existsSync;
	fs.readFileSync = () => {
		throw new Error('status document builder read the file system');
	};
	fs.existsSync = () => {
		throw new Error('status document builder read the file system');
	};
	try {
		const status = buildStatusDocument({
			...INPUT,
			state: {
				...INPUT.state,
				state: 'READY_FOR_GIT_APPROVAL',
			},
			verify: { argv: ['npm', 'test'] },
		});
		assert.equal(status.verification.lastCommand, 'npm test');
		assert.equal(status.verification.preflight.resultFile, null);
	} finally {
		fs.readFileSync = originalRead;
		fs.existsSync = originalExists;
	}

	const prBody = formatPullRequestBody({
		spec: { goal: 'Verify default PR command' },
		profile: {
			schemaVersion: '1.3.0',
			profileId: 'minimal',
			repositoryId: 'minimal',
			adapter: 'script',
			stateDir: '.agent-sdlc',
			reviewDir: '.agent-sdlc/reviews',
			specDraftDir: '.agent-sdlc/specs/drafts',
		},
	});
	assert.match(prBody, /Ran `npm test`/);
});

test('@ac AC-02 @case AC-02.2 buildStatusDocument in READY_FOR_GIT_APPROVAL with receipt-backed verify and baseCommitSha substitutes baseSha in lastCommand and populates resultFile from verify.resultPath', () => {
	const status = buildStatusDocument({
		...INPUT,
		state: {
			...INPUT.state,
			state: 'READY_FOR_GIT_APPROVAL',
		},
		auth: { baseCommitSha: 'abc1234' },
		verify: {
			argv: ['pnpm', 'run', 'agent:verify', '--', '--base', '{baseSha}'],
			resultPath: 'tools/.agent-preflight-last.json',
		},
	});
	assert.equal(
		status.verification.lastCommand,
		'pnpm run agent:verify -- --base abc1234',
	);
	assert.equal(
		status.verification.preflight.resultFile,
		'tools/.agent-preflight-last.json',
	);
});
