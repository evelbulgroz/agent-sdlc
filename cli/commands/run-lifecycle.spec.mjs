import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { runCli } from '../cli.ts';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import { RuntimeStore } from '../../persistence/runtime-store.ts';
import { FakeModelGovernor } from '../../testing/fake-model-governor.mjs';
import { completeProposal, grammaticalAcceptance } from '../../testing/test-support.mjs';
import { slug, cleanupRun, writeResponse } from '../../testing/cli-test-support.mjs';

test('CLI start, status, list, answer, export, and exact approval lifecycle', async () => {
	const testSlug = slug('lifecycle');
	const governor = new FakeModelGovernor([completeProposal()]);
	let runId;
	try {
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Build a durable specification workflow'],
			{ rootDir: REPOSITORY_ROOT, governor },
		);
		assert.equal(started.exitCode, 2);
		assert.equal(started.result.state, 'WAITING_FOR_ANSWERS');
		runId = started.result.runId;
		assert.match(started.human, /interrupt:/);
		const decisionsPath = path.join(REPOSITORY_ROOT, 'docs/specs/runs', runId, 'decisions.md');
		assert.ok(fs.existsSync(decisionsPath), 'decisions.md must be projected with status.json');
		assert.match(fs.readFileSync(decisionsPath, 'utf8'), /Repository Standard Auto-Decisions/);
		const status = await runCli(['status', '--run', runId, '--json'], {
			rootDir: REPOSITORY_ROOT,
			governor,
		});
		assert.equal(status.exitCode, 2);
		assert.equal(status.result.pendingInterrupt.request.questions.length, 3);
		const listed = await runCli(['list', '--json'], {
			rootDir: REPOSITORY_ROOT,
		});
		assert.ok(listed.result.runs.some((run) => run.runId === runId));
		const pending = status.result.pendingInterrupt;
		const answer = {
			schemaVersion: '1.0.0',
			interruptId: pending.interruptId,
			stateHash: pending.request.stateHash,
			answers: [
				{ questionId: 'acceptance', value: grammaticalAcceptance('Approved spec exists') },
				{ questionId: 'failure', value: 'Stale responses fail' },
				{ questionId: 'verification', value: 'Targeted tests pass' },
			],
		};
		const answerFile = writeResponse(runId, 'answer', answer);
		const answered = await runCli(
			['answer', '--run', runId, '--interrupt', pending.interruptId, '--response-file', answerFile],
			{ rootDir: REPOSITORY_ROOT, governor },
		);
		assert.equal(answered.exitCode, 2);
		assert.equal(answered.result.state, 'WAITING_FOR_APPROVAL');
		const approvalPending = answered.result.pendingInterrupt;
		const approval = {
			schemaVersion: '1.0.0',
			interruptId: approvalPending.interruptId,
			stateHash: approvalPending.request.stateHash,
			action: 'approve',
			approvalHash: approvalPending.request.approval.approvalHash,
			draftHash: approvalPending.request.draftHash,
			changes: [],
		};
		const approvalFile = writeResponse(runId, 'approval', approval);
		const approved = await runCli(
			[
				'answer',
				'--run',
				runId,
				'--interrupt',
				approvalPending.interruptId,
				'--response-file',
				approvalFile,
				'--json',
			],
			{ rootDir: REPOSITORY_ROOT, governor },
		);
		assert.equal(approved.exitCode, 2);
		assert.equal(approved.result.state, 'SPEC_APPROVED');
		const exported = await runCli(['export', '--run', runId, '--json'], {
			rootDir: REPOSITORY_ROOT,
			governor,
		});
		assert.equal(exported.exitCode, 2);
		assert.ok(fs.existsSync(exported.result.destination));
		const refused = await runCli(['export', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor,
		});
		assert.equal(refused.exitCode, 64);
		const overwritten = await runCli(['export', '--run', runId, '--overwrite'], {
			rootDir: REPOSITORY_ROOT,
			governor,
		});
		assert.equal(overwritten.exitCode, 2);
	} finally {
		if (runId) cleanupRun(runId);
	}
});

test('CLI stdin answer, durable answer-record window, resume, and cancellation', async () => {
	const testSlug = slug('resume');
	const governor = new FakeModelGovernor([completeProposal()]);
	let runId;
	try {
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Build resumable workflow'],
			{ rootDir: REPOSITORY_ROOT, governor },
		);
		runId = started.result.runId;
		const pending = started.result.pendingInterrupt;
		const response = {
			schemaVersion: '1.0.0',
			interruptId: pending.interruptId,
			stateHash: pending.request.stateHash,
			answers: [
				{ questionId: 'acceptance', value: grammaticalAcceptance('Resume works') },
				{ questionId: 'failure', value: 'Crash is idempotent' },
				{ questionId: 'verification', value: 'Recovery test passes' },
			],
		};
		const recorded = await runCli(
			['answer', '--run', runId, '--interrupt', pending.interruptId, '--stdin'],
			{
				rootDir: REPOSITORY_ROOT,
				governor,
				continueAfterAnswerRecord: false,
				streams: {
					stdin: Readable.from([JSON.stringify(response)]),
					stdout: new Writable({
						write(_chunk, _encoding, callback) {
							callback();
						},
					}),
					stderr: new Writable({
						write(_chunk, _encoding, callback) {
							callback();
						},
					}),
				},
			},
		);
		assert.equal(recorded.result.responseRecorded, true);
		const resumed = await runCli(['resume', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor,
		});
		assert.equal(resumed.result.state, 'WAITING_FOR_APPROVAL');
		const cancelled = await runCli(['cancel', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor,
		});
		assert.equal(cancelled.exitCode, 4);
		assert.equal(cancelled.result.state, 'CANCELLED');
		const repeated = await runCli(['cancel', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor,
		});
		assert.equal(repeated.result.state, 'CANCELLED');
	} finally {
		if (runId) cleanupRun(runId);
	}
});

test('CLI rejects conflicting, missing, empty, unknown, and fake-selection inputs', async () => {
	for (const args of [
		['start', '--goal', 'x', '--goal-file', 'goal.txt'],
		['start', '--goal', ''],
		['answer', '--run', '2026-09-04-missing', '--interrupt', 'x'],
		['status'],
		['status', '--run', '../escape'],
		['start', '--goal', 'x', '--fake'],
	]) {
		const outcome = await runCli(args, { rootDir: REPOSITORY_ROOT });
		assert.equal(outcome.exitCode, 64);
		assert.equal(outcome.result.ok, false);
	}
});

test('CLI accepts pnpm run separator before the command', async () => {
	const outcome = await runCli(['--', 'list', '--json'], {
		rootDir: REPOSITORY_ROOT,
	});
	assert.equal(outcome.exitCode, 0);
	assert.equal(outcome.result.ok, true);
});

test('invalid approval hashes and revisions leave the interrupt pending for correction', async () => {
	const testSlug = slug('approval-correction');
	const governor = new FakeModelGovernor([completeProposal()]);
	let runId;
	try {
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Keep invalid approvals correctable'],
			{ rootDir: REPOSITORY_ROOT, governor },
		);
		runId = started.result.runId;
		const question = started.result.pendingInterrupt;
		const answer = {
			schemaVersion: '1.0.0',
			interruptId: question.interruptId,
			stateHash: question.request.stateHash,
			answers: [
				{ questionId: 'acceptance', value: grammaticalAcceptance('Correction remains possible') },
				{ questionId: 'failure', value: 'Invalid approval stays pending' },
				{ questionId: 'verification', value: 'Inspect interrupt status' },
			],
		};
		const waiting = await runCli(
			[
				'answer',
				'--run',
				runId,
				'--interrupt',
				question.interruptId,
				'--response-file',
				writeResponse(runId, 'questions', answer),
			],
			{ rootDir: REPOSITORY_ROOT, governor },
		);
		const approval = waiting.result.pendingInterrupt;
		const invalidResponses = [
			{
				schemaVersion: '1.0.0',
				interruptId: approval.interruptId,
				stateHash: approval.request.stateHash,
				action: 'approve',
				approvalHash: 'f'.repeat(64),
				draftHash: approval.request.draftHash,
				changes: [],
			},
			{
				schemaVersion: '1.0.0',
				interruptId: approval.interruptId,
				stateHash: approval.request.stateHash,
				action: 'revise',
				approvalHash: null,
				draftHash: null,
				changes: [
					{ field: 'assumptions', operation: 'append', value: 'same' },
					{ field: 'assumptions', operation: 'append', value: 'same' },
				],
			},
		];
		for (const [index, response] of invalidResponses.entries()) {
			const rejected = await runCli(
				[
					'answer',
					'--run',
					runId,
					'--interrupt',
					approval.interruptId,
					'--response-file',
					writeResponse(runId, `invalid-${index}`, response),
				],
				{ rootDir: REPOSITORY_ROOT, governor },
			);
			assert.equal(rejected.exitCode, 64);
			const store = new RuntimeStore(
				path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
			);
			try {
				assert.equal(store.getInterrupt(approval.interruptId).status, 'PENDING');
				assert.equal(store.getRun(runId).state, 'WAITING_FOR_APPROVAL');
			} finally {
				store.close();
			}
		}
		const valid = {
			schemaVersion: '1.0.0',
			interruptId: approval.interruptId,
			stateHash: approval.request.stateHash,
			action: 'approve',
			approvalHash: approval.request.approval.approvalHash,
			draftHash: approval.request.draftHash,
			changes: [],
		};
		const approved = await runCli(
			[
				'answer',
				'--run',
				runId,
				'--interrupt',
				approval.interruptId,
				'--response-file',
				writeResponse(runId, 'valid-approval', valid),
			],
			{ rootDir: REPOSITORY_ROOT, governor },
		);
		assert.equal(approved.result.state, 'SPEC_APPROVED');
	} finally {
		if (runId) cleanupRun(runId);
	}
});

test('CLI allows cancellation from SPEC_APPROVED and WAITING_FOR_AUTHORIZATION', async () => {
	const testSlug = slug('cancel-spec-approved');
	const baseCommitSha = 'a'.repeat(40);
	const gitCli = (cmd, args = [], opts = {}) => {
		if (cmd === 'git' && args[0] === 'rev-parse') return `${baseCommitSha}\n`;
		return '';
	};
	const governor = new FakeModelGovernor([completeProposal()]);

	let runId;
	try {
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Test cancel from approved'],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli },
		);
		runId = started.result.runId;

		const pending = started.result.pendingInterrupt;
		const answer = {
			schemaVersion: '1.0.0',
			interruptId: pending.interruptId,
			stateHash: pending.request.stateHash,
			answers: [
				{ questionId: 'acceptance', value: grammaticalAcceptance('Approved spec exists') },
				{ questionId: 'failure', value: 'Stale responses fail' },
				{ questionId: 'verification', value: 'Targeted tests pass' },
			],
		};
		const answered = await runCli(
			['answer', '--run', runId, '--interrupt', pending.interruptId, '--response-file', writeResponse(runId, 'ans', answer)],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli },
		);

		const approvalPending = answered.result.pendingInterrupt;
		const approval = {
			schemaVersion: '1.0.0',
			interruptId: approvalPending.interruptId,
			stateHash: approvalPending.request.stateHash,
			action: 'approve',
			approvalHash: approvalPending.request.approval.approvalHash,
			draftHash: approvalPending.request.draftHash,
			changes: [],
		};
		const approved = await runCli(
			['answer', '--run', runId, '--interrupt', approvalPending.interruptId, '--response-file', writeResponse(runId, 'appr', approval)],
			{ rootDir: REPOSITORY_ROOT, governor, gitCli },
		);
		assert.equal(approved.result.state, 'SPEC_APPROVED');

		// Cancel from SPEC_APPROVED succeeds
		const cancelled = await runCli(['cancel', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor,
			gitCli,
		});
		assert.equal(cancelled.exitCode, 4);
		assert.equal(cancelled.result.state, 'CANCELLED');
	} finally {
		if (runId) cleanupRun(runId);
	}
});
