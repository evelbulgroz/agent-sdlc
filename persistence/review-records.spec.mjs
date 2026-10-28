import assert from 'node:assert/strict';
import test from 'node:test';

import { createReviewRecords } from './review-records.ts';
import { makeFixture } from '../testing/test-support.mjs';

test('runtime store persists and retrieves git commits, critic reviews, and optional role executions', () => {
	const fixture = makeFixture('store-v4', []);
	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Slice 3 store test',
		});

		// 1. Git commit record
		assert.equal(fixture.store.getGitCommit(fixture.runId), null);
		const commit = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			targetBranch: `agent-sdlc/${fixture.runId}`,
			commitSha: '1'.repeat(40),
			treeSha: '2'.repeat(40),
			parentSha: '3'.repeat(40),
			message: 'feat(agent-sdlc): commit test\n\nDecisions:\n- none\n\nRemaining:\n- none\n\nTried:\n- none',
			authorName: 'fitnessapp-agent',
			authorEmail: 'agent@fitnessapp.local',
			committedAt: new Date().toISOString(),
		};
		fixture.store.saveGitCommit(commit);
		const retrievedCommit = fixture.store.getGitCommit(fixture.runId);
		assert.equal(retrievedCommit.commitSha, '1'.repeat(40));
		assert.equal(retrievedCommit.targetBranch, `agent-sdlc/${fixture.runId}`);
		assert.equal(retrievedCommit.authorName, 'fitnessapp-agent');

		// 1b. Pull request record
		assert.equal(fixture.store.getPullRequest(fixture.runId), null);
		const pr = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			prUrl: 'https://github.com/evelbulgroz/fitness-app/pull/99',
			prNumber: 99,
			draft: true,
			branchName: `agent-sdlc/${fixture.runId}`,
			baseBranch: 'main',
			createdAt: new Date().toISOString(),
		};
		fixture.store.savePullRequest(pr);
		const retrievedPr = fixture.store.getPullRequest(fixture.runId);
		assert.equal(retrievedPr.prNumber, 99);
		assert.equal(retrievedPr.draft, true);
		assert.equal(retrievedPr.prUrl, 'https://github.com/evelbulgroz/fitness-app/pull/99');
		assert.equal(retrievedPr.branchName, `agent-sdlc/${fixture.runId}`);
		assert.equal(fixture.store.listCriticReviews(fixture.runId).length, 0);
		const review0Code = {
			schemaVersion: '1.0.0',
			reviewId: 'rev-0-code',
			runId: fixture.runId,
			generation: 0,
			phase: 'code',
			reviewerVendor: 'openai',
			reviewerModel: 'gpt-4o',
			manifestPath: `tools/.review/${fixture.runId}/manifest-0.json`,
			artifactHash: 'a'.repeat(64),
			attemptKey: `code:0:${'a'.repeat(64)}`,
			findingsCount: 1,
			hasP1: true,
			reviewedAt: new Date().toISOString(),
		};
		const review0Qa = {
			schemaVersion: '1.0.0',
			reviewId: 'rev-0-qa',
			runId: fixture.runId,
			generation: 0,
			phase: 'qa',
			reviewerVendor: 'openai',
			reviewerModel: 'gpt-4o',
			manifestPath: `tools/.review/${fixture.runId}/manifest-0.json`,
			artifactHash: 'b'.repeat(64),
			attemptKey: `qa:${'d'.repeat(64)}`,
			findingsCount: 0,
			hasP1: false,
			reviewedAt: new Date().toISOString(),
		};
		fixture.store.saveCriticReview(review0Code);
		fixture.store.saveCriticReview(review0Qa);

		const allReviews = fixture.store.listCriticReviews(fixture.runId);
		assert.equal(allReviews.length, 2);
		const gen0Reviews = fixture.store.listCriticReviews(fixture.runId, 0);
		assert.equal(gen0Reviews.length, 2);
		const gen1Reviews = fixture.store.listCriticReviews(fixture.runId, 1);
		assert.equal(gen1Reviews.length, 0);

		const specRound1 = {
			schemaVersion: '1.0.0',
			reviewId: 'rev-spec-1',
			runId: fixture.runId,
			generation: 0,
			phase: 'spec',
			reviewerVendor: 'openai',
			reviewerModel: 'gpt-4o',
			manifestPath: `tools/.review/${fixture.runId}/manifest-spec.json`,
			artifactHash: '1'.repeat(64),
			attemptKey: 'spec:0',
			findingsCount: 1,
			hasP1: true,
			reviewedAt: new Date().toISOString(),
		};
		const specRound2 = {
			...specRound1,
			reviewId: 'rev-spec-2',
			artifactHash: '2'.repeat(64),
			findingsCount: 0,
			hasP1: false,
		};
		fixture.store.saveCriticReview(specRound1);
		fixture.store.saveCriticReview(specRound2);
		const specReviews = fixture.store
			.listCriticReviews(fixture.runId)
			.filter((review) => review.phase === 'spec');
		assert.equal(specReviews.length, 2);
		assert.equal(specReviews[0].artifactHash, '1'.repeat(64));
		assert.equal(specReviews[1].attemptKey, 'spec:0');

		// 3. Optional role executions
		assert.equal(fixture.store.listOptionalRoleExecutions(fixture.runId).length, 0);
		const roleExecutionCleaner = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			roleId: 'cleaner',
			insertionPoint: 'post_implement',
			generation: 0,
			status: 'modified',
			summary: 'Removed 2 unused imports',
			executedAt: new Date(Date.now() - 5000).toISOString(),
		};
		const roleExecutionArchitect = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			roleId: 'architect',
			insertionPoint: 'pre_review',
			generation: 0,
			status: 'passed',
			summary: 'Architecture rules verified clean',
			executedAt: new Date().toISOString(),
		};
		fixture.store.saveOptionalRoleExecution(roleExecutionCleaner);
		fixture.store.saveOptionalRoleExecution(roleExecutionArchitect);

		const allRoleExecutions = fixture.store.listOptionalRoleExecutions(fixture.runId);
		assert.equal(allRoleExecutions.length, 2);
		const gen0RoleExecutions = fixture.store.listOptionalRoleExecutions(fixture.runId, 0);
		assert.equal(gen0RoleExecutions.length, 2);
		assert.equal(gen0RoleExecutions[0].roleId, 'cleaner');
		assert.equal(gen0RoleExecutions[1].roleId, 'architect');
	} finally {
		fixture.close();
	}
});

function recordContext(store) {
	return Object.freeze({
		database: store.database,
		transaction: (operation) => store.transaction(operation),
		assertOpen: () => store.assertOpen(),
	});
}

test('review records list no critic reviews for a new run', () => {
	const fixture = makeFixture('review-direct');
	try {
		fixture.runtime.initialize({ runId: fixture.runId, goal: 'direct reviews' });
		const records = createReviewRecords(recordContext(fixture.store));
		assert.deepEqual(records.listCriticReviews(fixture.runId), []);
		assert.deepEqual(records.listCriticReviews(fixture.runId, 0), []);
		assert.deepEqual(records.listOptionalRoleExecutions(fixture.runId), []);
	} finally {
		fixture.close();
	}
});
