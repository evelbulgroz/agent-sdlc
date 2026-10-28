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
import {
	cleanupRun,
	startWaitingForApproval,
	waitForBoundary,
} from '../testing/recovery-fixtures.mjs';
import {
	completeProposal,
	grammaticalAcceptance,
	trackTestRun,
} from '../testing/test-support.mjs';

test('named graph and projection crash boundaries resume without duplicate effects', async (t) => {
	const boundaries = [
		['completeness-transition-recorded', 1],
		['model-request-transition-recorded', 1],
		['model-operation-result-recorded', 1],
		['model-completed-transition-recorded', 1],
		['model-patch-transition-recorded', 1],
		['completeness-transition-recorded', 2],
		['questions-transition-recorded', 1],
		['projection-reserved', 1],
		['projection-event-recorded', 1],
		['projection-intent-published', 1],
		['projection-status-published', 1],
		['projection-outbox-published', 1],
	];
	for (const [boundary, occurrence] of boundaries) {
		await t.test(`${boundary}-${occurrence}`, async () => {
			const testSlug = `sdlc-boundary-${trackTestRun(crypto.randomUUID().slice(0, 8))}`;
			const runId = `${new Date().toISOString().slice(0, 10)}-${testSlug}`;
			try {
				const child = fork(
					path.join(REPOSITORY_ROOT, 'testing/crash-fixture-runner.mjs'),
					[
						'--root',
						REPOSITORY_ROOT,
						'--mode',
						'start',
						'--slug',
						testSlug,
						'--boundary',
						boundary,
						'--occurrence',
						String(occurrence),
					],
					{ cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
				);
				const marker = await waitForBoundary(child);
				assert.equal(marker.name, boundary);
				assert.ok(child.pid);
				child.kill('SIGTERM');
				await new Promise((resolve) => child.once('exit', resolve));
				const governor = new FakeModelGovernor([completeProposal()]);
				const resumed = await runCli(['resume', '--run', runId], {
					rootDir: REPOSITORY_ROOT,
					governor,
				});
				assert.equal(resumed.result.state, 'WAITING_FOR_ANSWERS');
				const store = new RuntimeStore(
					path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
				);
				try {
					const events = store.listEvents(runId);
					assert.equal(new Set(events.map((event) => event.eventId)).size, events.length);
					assert.equal(store.getRun(runId).modelOperations.length, 1);
					const projections = events.filter((event) => event.eventType === 'PROJECTION_WRITTEN');
					assert.equal(
						new Set(projections.map((event) => event.runtimeRevision)).size,
						projections.length,
					);
				} finally {
					store.close();
				}
				if (boundary === 'questions-transition-recorded') {
					const pending = resumed.result.pendingInterrupt;
					const response = {
						schemaVersion: '1.0.0',
						interruptId: pending.interruptId,
						stateHash: pending.request.stateHash,
						answers: [
							{ questionId: 'acceptance', value: grammaticalAcceptance('Recovery is usable') },
							{ questionId: 'failure', value: 'No duplicate effects' },
							{ questionId: 'verification', value: 'Resume then answer' },
						],
					};
					const responseFile = path.join(
						REPOSITORY_ROOT,
						'tools/.agent-sdlc',
						runId,
						'post-crash-answer.json',
					);
					fs.writeFileSync(responseFile, JSON.stringify(response), {
						mode: 0o600,
					});
					const answered = await runCli(
						[
							'answer',
							'--run',
							runId,
							'--interrupt',
							pending.interruptId,
							'--response-file',
							responseFile,
						],
						{ rootDir: REPOSITORY_ROOT, governor },
					);
					assert.equal(answered.result.state, 'WAITING_FOR_APPROVAL');
				}
			} finally {
				cleanupRun(runId);
			}
		});
	}
});

test('blocked, revision, rejection, cancellation, and operator-cancel boundaries recover', async (t) => {
	await t.test('model-blocked-transition-recorded', async () => {
		const testSlug = `sdlc-blocked-boundary-${trackTestRun(crypto.randomUUID().slice(0, 8))}`;
		const runId = `${new Date().toISOString().slice(0, 10)}-${testSlug}`;
		try {
			const child = fork(
				path.join(REPOSITORY_ROOT, 'testing/crash-fixture-runner.mjs'),
				[
					'--root',
					REPOSITORY_ROOT,
					'--mode',
					'start',
					'--slug',
					testSlug,
					'--governor-error',
					'GOVERNOR_ROUTES_EXHAUSTED',
					'--boundary',
					'model-blocked-transition-recorded',
				],
				{ cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
			);
			assert.equal((await waitForBoundary(child)).name, 'model-blocked-transition-recorded');
			assert.ok(child.pid);
			child.kill('SIGTERM');
			await new Promise((resolve) => child.once('exit', resolve));
			const status = await runCli(['status', '--run', runId], {
				rootDir: REPOSITORY_ROOT,
				governor: new FakeModelGovernor([]),
			});
			assert.equal(status.result.state, 'BLOCKED');
			const resumed = await runCli(['resume', '--run', runId], {
				rootDir: REPOSITORY_ROOT,
				governor: new FakeModelGovernor([completeProposal()]),
			});
			assert.equal(resumed.result.state, 'WAITING_FOR_ANSWERS');
			const store = new RuntimeStore(
				path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
			);
			try {
				assert.equal(
					store.listEvents(runId).filter((event) => event.eventType === 'RUN_BLOCKED').length,
					1,
				);
				assert.equal(new Set(store.getRun(runId).modelOperations).size, 2);
			} finally {
				store.close();
			}
		} finally {
			cleanupRun(runId);
		}
	});

	for (const [action, boundary, expected] of [
		['revise', 'approval-revision-transition-recorded', 'WAITING_FOR_APPROVAL'],
		['reject', 'approval-terminal-transition-recorded', 'SPEC_REJECTED'],
		['cancel', 'approval-terminal-transition-recorded', 'CANCELLED'],
	]) {
		await t.test(`${action}-${boundary}`, async () => {
			const { runId, governor, pending } = await startWaitingForApproval(`${action}-boundary`);
			try {
				const response = {
					schemaVersion: '1.0.0',
					interruptId: pending.interruptId,
					stateHash: pending.request.stateHash,
					action,
					approvalHash: action === 'revise' ? null : pending.request.approval.approvalHash,
					draftHash: action === 'revise' ? null : pending.request.draftHash,
					changes:
						action === 'revise'
							? [
									{
										field: 'assumptions',
										operation: 'append',
										value: 'Reconsidered',
									},
								]
							: [],
				};
				const responseFile = path.join(
					REPOSITORY_ROOT,
					'tools/.agent-sdlc',
					runId,
					`${action}-boundary.json`,
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
				assert.equal(resumed.result.state, expected);
				const store = new RuntimeStore(
					path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
				);
				try {
					const eventType =
						action === 'revise'
							? 'DRAFT_REVISED'
							: action === 'reject'
								? 'SPEC_REJECTED'
								: 'RUN_CANCELLED';
					assert.equal(
						store.listEvents(runId).filter((event) => event.eventType === eventType).length,
						action === 'revise' ? 2 : 1,
					);
				} finally {
					store.close();
				}
			} finally {
				cleanupRun(runId);
			}
		});
	}

	await t.test('cancel-transition-recorded', async () => {
		const testSlug = `sdlc-operator-cancel-${trackTestRun(crypto.randomUUID().slice(0, 8))}`;
		const governor = new FakeModelGovernor([completeProposal()]);
		let runId;
		try {
			const started = await runCli(
				['start', '--slug', testSlug, '--goal', 'Recover operator cancellation'],
				{ rootDir: REPOSITORY_ROOT, governor },
			);
			runId = started.result.runId;
			const child = fork(
				path.join(REPOSITORY_ROOT, 'testing/crash-fixture-runner.mjs'),
				[
					'--root',
					REPOSITORY_ROOT,
					'--mode',
					'cancel',
					'--run',
					runId,
					'--boundary',
					'cancel-transition-recorded',
				],
				{ cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
			);
			assert.equal((await waitForBoundary(child)).name, 'cancel-transition-recorded');
			assert.ok(child.pid);
			child.kill('SIGTERM');
			await new Promise((resolve) => child.once('exit', resolve));
			const resumed = await runCli(['resume', '--run', runId], {
				rootDir: REPOSITORY_ROOT,
				governor,
			});
			assert.equal(resumed.result.state, 'CANCELLED');
			const store = new RuntimeStore(
				path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
			);
			try {
				assert.equal(store.getRun(runId).pendingInterruptId, null);
				assert.equal(
					store.getInterrupt(started.result.pendingInterrupt.interruptId).status,
					'RESOLVED',
				);
				assert.equal(
					store.listEvents(runId).filter((event) => event.eventType === 'RUN_CANCELLED').length,
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

test('projection drift fails closed with actionable status', async () => {
	const testSlug = `sdlc-drift-${trackTestRun(crypto.randomUUID().slice(0, 8))}`;
	const governor = new FakeModelGovernor([completeProposal()]);
	let runId;
	try {
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Detect projection drift'],
			{ rootDir: REPOSITORY_ROOT, governor },
		);
		runId = started.result.runId;
		const statusPath = path.join(REPOSITORY_ROOT, 'docs/specs/runs', runId, 'status.json');
		const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
		status.activeOwner = 'manual-edit';
		fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
		const result = await runCli(['status', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor,
		});
		assert.equal(result.exitCode, 70);
		assert.equal(result.result.error.code, 'PROJECTION_DRIFT');
	} finally {
		if (runId) cleanupRun(runId);
	}
});
