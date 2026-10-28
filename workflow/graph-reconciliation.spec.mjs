import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';
import { createMockGitCli } from '../testing/test-support.mjs';
import {
	makeGraphFixture,
	reachSpecApproved,
	seedSlice4Worktree,
	twoTaskScript,
} from '../testing/graph-fixtures.mjs';

test('Slice 4 reconciliation conflict halts at interrupt and handles escalation response (AC 39)', async () => {
	const surfaces = [
		'apps/services/conditioning/src/feat1.ts',
		'apps/services/assessment/src/feat2.ts',
	];
	const baseCommitSha = 'a'.repeat(40);
	const targetTreeSha = 'b'.repeat(40);
	const commitSha = 'c'.repeat(40);

	let inReconcile = false;
	let reconcileTaskIndex = 0;
	let applyCheckCalls = 0;
	const mockGitCli = createMockGitCli({
		baseCommitSha,
		targetTreeSha,
		commitSha,
		onWorktreeAdd: seedSlice4Worktree,
	});

	// Fail the dry-run apply check on the second task to simulate a patch merge conflict
	const conflictGitCli = (cmd, args = [], opts = {}) => {
		if (cmd === 'git') {
			if (args[0] === 'rev-parse' && typeof args[1] === 'string' && args[1].endsWith('^{tree}')) {
				return `${'e'.repeat(40)}\n`;
			}
			if (args[0] === 'worktree' && args[1] === 'add') {
				const dest = args[3] || args[2];
				if (dest?.includes('integration')) {
					inReconcile = true;
					reconcileTaskIndex = 0;
				}
			}
			if (args[0] === 'diff-tree') {
				if (inReconcile) {
					if (!args.includes('--name-only')) {
						reconcileTaskIndex++;
					}
					if (reconcileTaskIndex <= 1) {
						if (args.includes('--name-only')) {
							return 'apps/services/assessment/src/feat2.ts\n';
						}
						return 'diff --git a/apps/services/assessment/src/feat2.ts b/apps/services/assessment/src/feat2.ts\n--- a/apps/services/assessment/src/feat2.ts\n+++ b/apps/services/assessment/src/feat2.ts\n@@ -0,0 +1 @@\n+assessment\n';
					}
					if (args.includes('--name-only')) {
						return 'apps/services/conditioning/src/feat1.ts\n';
					}
					return 'diff --git a/apps/services/conditioning/src/feat1.ts b/apps/services/conditioning/src/feat1.ts\n--- a/apps/services/conditioning/src/feat1.ts\n+++ b/apps/services/conditioning/src/feat1.ts\n@@ -0,0 +1 @@\n+conditioning\n';
				}
				return 'diff --git a/dummy b/dummy\n';
			}
			if (args[0] === 'apply' && args.includes('--check')) {
				applyCheckCalls++;
				if (applyCheckCalls >= 2) {
					const error = new Error('error: patch failed: apps/services/conditioning/src/feat1.ts:1\nerror: apps/services/conditioning/src/feat1.ts: patch does not apply');
					error.status = 1;
					throw error;
				}
			}
		}
		return mockGitCli(cmd, args, opts);
	};

	const fixture = makeGraphFixture('s4-recon-conflict',  twoTaskScript(surfaces), { profile: 'slice4', 
		gitCli: conflictGitCli,
	});

	try {
		const approved = await reachSpecApproved(fixture);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['apps/services/conditioning', 'apps/services/assessment'],
			allowedPathPrefixes: ['apps/services/conditioning', 'apps/services/assessment'],
			createBranch: true,
			createLocalCommits: true,
		});

		// Authorize executes tasks, then hits reconciliation conflict
		const interrupted = await fixture.runtime.authorize(approved, envelope);
		assert.equal(
			interrupted.state,
			'RECONCILING_INTEGRATION',
			interrupted.lastError
				? `${interrupted.lastError.code}: ${interrupted.lastError.message}`
				: JSON.stringify(interrupted),
		);
		assert.ok(interrupted.pendingInterruptId);

		// Verify pending interrupt in store
		const pendingInterrupt = fixture.store.getPendingInterrupt(fixture.runId);
		assert.ok(pendingInterrupt);
		assert.equal(pendingInterrupt.kind, 'reconciliation_conflict');

		const interruptReq = fixture.artifacts.readJson(pendingInterrupt.requestArtifact);
		assert.ok(interruptReq);
		assert.ok(interruptReq.failingTaskId);
		assert.ok(interruptReq.conflictDetails);

		// Verify reconciliation recorded with RECONCILIATION_CONFLICT status
		const recon = fixture.store.getLatestReconciliation(fixture.runId);
		assert.ok(recon);
		assert.equal(recon.status, 'RECONCILIATION_CONFLICT');
		assert.ok(recon.conflictDetails);

		// Resuming with escalate response transitions to ESCALATED
		const escalateResponse = {
			schemaVersion: '1.0.0',
			interruptId: pendingInterrupt.interruptId,
			stateHash: pendingInterrupt.stateHash,
			action: 'escalate',
			reason: 'Manual merge intervention required for conflicting tasks',
		};
		fixture.store.recordInterruptResponse(
			pendingInterrupt.interruptId,
			fixture.artifacts.writeJson('human-response', escalateResponse),
		);

		const resumed = await fixture.runtime.resume(interrupted, escalateResponse);
		assert.equal(resumed.state, 'ESCALATED');
	} finally {
		fixture.close();
	}
});

test('Slice 4 reconciliation conflict handles cancellation response', async () => {
	const surfaces = [
		'apps/services/conditioning/src/feat1.ts',
		'apps/services/assessment/src/feat2.ts',
	];
	const baseCommitSha = 'a'.repeat(40);
	const targetTreeSha = 'b'.repeat(40);
	const commitSha = 'c'.repeat(40);

	let inReconcile = false;
	let reconcileTaskIndex = 0;
	let applyCheckCalls = 0;
	const mockGitCli = createMockGitCli({
		baseCommitSha,
		targetTreeSha,
		commitSha,
		onWorktreeAdd: seedSlice4Worktree,
	});

	const conflictGitCli = (cmd, args = [], opts = {}) => {
		if (cmd === 'git') {
			if (args[0] === 'rev-parse' && typeof args[1] === 'string' && args[1].endsWith('^{tree}')) {
				return `${'e'.repeat(40)}\n`;
			}
			if (args[0] === 'worktree' && args[1] === 'add') {
				const dest = args[3] || args[2];
				if (dest?.includes('integration')) {
					inReconcile = true;
					reconcileTaskIndex = 0;
				}
			}
			if (args[0] === 'diff-tree') {
				if (inReconcile) {
					if (!args.includes('--name-only')) {
						reconcileTaskIndex++;
					}
					if (reconcileTaskIndex <= 1) {
						if (args.includes('--name-only')) {
							return 'apps/services/assessment/src/feat2.ts\n';
						}
						return 'diff --git a/apps/services/assessment/src/feat2.ts b/apps/services/assessment/src/feat2.ts\n--- a/apps/services/assessment/src/feat2.ts\n+++ b/apps/services/assessment/src/feat2.ts\n@@ -0,0 +1 @@\n+assessment\n';
					}
					if (args.includes('--name-only')) {
						return 'apps/services/conditioning/src/feat1.ts\n';
					}
					return 'diff --git a/apps/services/conditioning/src/feat1.ts b/apps/services/conditioning/src/feat1.ts\n--- a/apps/services/conditioning/src/feat1.ts\n+++ b/apps/services/conditioning/src/feat1.ts\n@@ -0,0 +1 @@\n+conditioning\n';
				}
				return 'diff --git a/dummy b/dummy\n';
			}
			if (args[0] === 'apply' && args.includes('--check')) {
				applyCheckCalls++;
				if (applyCheckCalls >= 2) {
					const error = new Error('patch collision');
					error.status = 1;
					throw error;
				}
			}
		}
		return mockGitCli(cmd, args, opts);
	};

	const fixture = makeGraphFixture('s4-recon-cancel',  twoTaskScript(surfaces), { profile: 'slice4', 
		gitCli: conflictGitCli,
	});

	try {
		const approved = await reachSpecApproved(fixture);
		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['apps/services/conditioning', 'apps/services/assessment'],
			allowedPathPrefixes: ['apps/services/conditioning', 'apps/services/assessment'],
			createBranch: true,
			createLocalCommits: true,
		});

		const interrupted = await fixture.runtime.authorize(approved, envelope);
		assert.equal(interrupted.state, 'RECONCILING_INTEGRATION');
		assert.ok(interrupted.pendingInterruptId);

		const pendingInterrupt = fixture.store.getPendingInterrupt(fixture.runId);
		assert.ok(pendingInterrupt);

		const cancelResponse = {
			schemaVersion: '1.0.0',
			interruptId: pendingInterrupt.interruptId,
			stateHash: pendingInterrupt.stateHash,
			action: 'cancel',
		};
		fixture.store.recordInterruptResponse(
			pendingInterrupt.interruptId,
			fixture.artifacts.writeJson('human-response', cancelResponse),
		);

		const cancelled = await fixture.runtime.resume(interrupted, cancelResponse);
		assert.equal(cancelled.state, 'CANCELLED');
	} finally {
		fixture.close();
	}
});
