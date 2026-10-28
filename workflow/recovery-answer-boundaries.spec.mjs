import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import test from 'node:test';
import { runCli } from '../cli/cli.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { RuntimeStore } from '../persistence/runtime-store.ts';
import { FakeModelGovernor } from '../testing/fake-model-governor.mjs';
import { cleanupRun, waitForBoundary } from '../testing/recovery-fixtures.mjs';
import {
	completeProposal,
	grammaticalAcceptance,
	trackTestRun,
} from '../testing/test-support.mjs';

test('answer-record crash window resumes once without duplicate event or model operation', async () => {
	const testSlug = `sdlc-recovery-${trackTestRun(crypto.randomUUID().slice(0, 8))}`;
	const governor = new FakeModelGovernor([completeProposal()]);
	let runId;
	try {
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Recover after answer persistence'],
			{ rootDir: REPOSITORY_ROOT, governor },
		);
		runId = started.result.runId;
		const pending = started.result.pendingInterrupt;
		const response = {
			schemaVersion: '1.0.0',
			interruptId: pending.interruptId,
			stateHash: pending.request.stateHash,
			answers: [
				{ questionId: 'acceptance', value: grammaticalAcceptance('Resume exactly once') },
				{ questionId: 'failure', value: 'No duplicate event' },
				{ questionId: 'verification', value: 'Inspect persisted records' },
			],
		};
		const responseFile = path.join(
			REPOSITORY_ROOT,
			'tools/.agent-sdlc',
			runId,
			'crash-response.json',
		);
		fs.writeFileSync(responseFile, JSON.stringify(response), { mode: 0o600 });
		const child = fork(
			path.join(REPOSITORY_ROOT, 'testing/crash-fixture-runner.mjs'),
			[
				'--root',
				REPOSITORY_ROOT,
				'--mode',
				'answer',
				'--run',
				runId,
				'--interrupt',
				pending.interruptId,
				'--response-file',
				responseFile,
				'--boundary',
				'answer-response-recorded',
			],
			{ cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
		);
		const marker = await waitForBoundary(child);
		assert.equal(marker.name, 'answer-response-recorded');
		assert.ok(child.pid);
		child.kill('SIGTERM');
		await new Promise((resolve) => child.once('exit', resolve));
		const resumed = await runCli(['resume', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor,
		});
		assert.equal(resumed.result.state, 'WAITING_FOR_APPROVAL');
		const store = new RuntimeStore(
			path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
		);
		try {
			const events = store.listEvents(runId);
			assert.equal(events.filter((event) => event.eventType === 'ANSWERS_ACCEPTED').length, 1);
			assert.equal(new Set(events.map((event) => event.eventId)).size, events.length);
			assert.equal(store.getRun(runId).modelOperations.length, 1);
		} finally {
			store.close();
		}
	} finally {
		if (runId) cleanupRun(runId);
	}
});

test('named answer and approval crash boundaries resume exactly once', async (t) => {
	for (const boundary of [
		'answers-transition-recorded',
		'completeness-transition-recorded',
		'approval-request-transition-recorded',
	]) {
		await t.test(boundary, async () => {
			const testSlug = `sdlc-answer-boundary-${trackTestRun(crypto.randomUUID().slice(0, 8))}`;
			const governor = new FakeModelGovernor([completeProposal()]);
			let runId;
			try {
				const started = await runCli(
					['start', '--slug', testSlug, '--goal', 'Recover answer processing'],
					{ rootDir: REPOSITORY_ROOT, governor },
				);
				runId = started.result.runId;
				const pending = started.result.pendingInterrupt;
				const response = {
					schemaVersion: '1.0.0',
					interruptId: pending.interruptId,
					stateHash: pending.request.stateHash,
					answers: [
						{ questionId: 'acceptance', value: grammaticalAcceptance('Answer resumes once') },
						{ questionId: 'failure', value: 'No duplicated answer event' },
						{ questionId: 'verification', value: 'Inspect event IDs' },
					],
				};
				const responseFile = path.join(
					REPOSITORY_ROOT,
					'tools/.agent-sdlc',
					runId,
					'boundary-answer.json',
				);
				fs.writeFileSync(responseFile, JSON.stringify(response), {
					mode: 0o600,
				});
				const child = fork(
					path.join(REPOSITORY_ROOT, 'testing/crash-fixture-runner.mjs'),
					[
						'--root',
						REPOSITORY_ROOT,
						'--mode',
						'answer',
						'--run',
						runId,
						'--interrupt',
						pending.interruptId,
						'--response-file',
						responseFile,
						'--boundary',
						boundary,
					],
					{ cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
				);
				assert.equal((await waitForBoundary(child)).name, boundary);
				assert.ok(child.pid);
				child.kill('SIGTERM');
				await new Promise((resolve) => child.once('exit', resolve));
				const resumed = await runCli(['resume', '--run', runId], {
					rootDir: REPOSITORY_ROOT,
					governor,
				});
				assert.equal(resumed.result.state, 'WAITING_FOR_APPROVAL');
				const store = new RuntimeStore(
					path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
				);
				try {
					const events = store.listEvents(runId);
					assert.equal(events.filter((event) => event.eventType === 'ANSWERS_ACCEPTED').length, 1);
					assert.equal(new Set(events.map((event) => event.eventId)).size, events.length);
				} finally {
					store.close();
				}
			} finally {
				if (runId) cleanupRun(runId);
			}
		});
	}

	await t.test('approval-transition-recorded', async () => {
		const testSlug = `sdlc-approval-boundary-${trackTestRun(crypto.randomUUID().slice(0, 8))}`;
		const governor = new FakeModelGovernor([completeProposal()]);
		let runId;
		try {
			const started = await runCli(
				['start', '--slug', testSlug, '--goal', 'Recover approval processing'],
				{ rootDir: REPOSITORY_ROOT, governor },
			);
			runId = started.result.runId;
			const questions = started.result.pendingInterrupt;
			const answers = {
				schemaVersion: '1.0.0',
				interruptId: questions.interruptId,
				stateHash: questions.request.stateHash,
				answers: [
					{ questionId: 'acceptance', value: grammaticalAcceptance('Approval resumes once') },
					{ questionId: 'failure', value: 'No duplicate approval' },
					{ questionId: 'verification', value: 'Inspect approval events' },
				],
			};
			const answerFile = path.join(
				REPOSITORY_ROOT,
				'tools/.agent-sdlc',
				runId,
				'approval-setup-answer.json',
			);
			fs.writeFileSync(answerFile, JSON.stringify(answers), { mode: 0o600 });
			const waiting = await runCli(
				[
					'answer',
					'--run',
					runId,
					'--interrupt',
					questions.interruptId,
					'--response-file',
					answerFile,
				],
				{ rootDir: REPOSITORY_ROOT, governor },
			);
			const pending = waiting.result.pendingInterrupt;
			const approval = {
				schemaVersion: '1.0.0',
				interruptId: pending.interruptId,
				stateHash: pending.request.stateHash,
				action: 'approve',
				approvalHash: pending.request.approval.approvalHash,
				draftHash: pending.request.draftHash,
				changes: [],
			};
			const approvalFile = path.join(
				REPOSITORY_ROOT,
				'tools/.agent-sdlc',
				runId,
				'boundary-approval.json',
			);
			fs.writeFileSync(approvalFile, JSON.stringify(approval), { mode: 0o600 });
			const child = fork(
				path.join(REPOSITORY_ROOT, 'testing/crash-fixture-runner.mjs'),
				[
					'--root',
					REPOSITORY_ROOT,
					'--mode',
					'answer',
					'--run',
					runId,
					'--interrupt',
					pending.interruptId,
					'--response-file',
					approvalFile,
					'--boundary',
					'approval-transition-recorded',
				],
				{ cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
			);
			assert.equal((await waitForBoundary(child)).name, 'approval-transition-recorded');
			assert.ok(child.pid);
			child.kill('SIGTERM');
			await new Promise((resolve) => child.once('exit', resolve));
			const resumed = await runCli(['resume', '--run', runId], {
				rootDir: REPOSITORY_ROOT,
				governor,
			});
			assert.equal(resumed.result.state, 'WAITING_FOR_AUTHORIZATION');
			assert.equal(resumed.exitCode, 2);
			const store = new RuntimeStore(
				path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
			);
			try {
				assert.equal(
					store.listEvents(runId).filter((event) => event.eventType === 'SPEC_APPROVED').length,
					1,
				);
			} finally {
				store.close();
			}
		} finally {
			if (runId) cleanupRun(runId);
		}
	});
});
