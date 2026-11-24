import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseArguments } from './arguments.ts';
import { runCli } from './cli.ts';
import { startRun } from './commands/start.ts';
import { shellStart } from './shell-driver.ts';
import { createRuntimeDirectory } from '../persistence/run-paths.ts';
import { RuntimeStore } from '../persistence/runtime-store.ts';
import { createEvent } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { makeTempDir, writeGoalFile, SILENT_STREAMS, spyOnRunCli } from '../testing/shell-driver-support.ts';
import {
	checkoutRecordedPriorTask,
	loadPriorTaskCheckout,
	omitCompletedAuthoredPaths,
	priorTaskFlags,
	writePriorTaskHandoff,
} from '../workflow/prior-task-tree.ts';

const H = 'a'.repeat(64);
const TIME = '2026-11-23T12:00:00.000Z';
const PRIOR_ID = '2026-11-23-halted-prior';
const NEXT_ID = '2026-11-23-replacement';

function git(cwd, args) {
	return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prior-task-'));
	fs.mkdirSync(path.join(root, 'docs/specs/runs'), { recursive: true });
	return root;
}

function openStore(root, runId) {
	const runtimeDir = createRuntimeDirectory(runId, root);
	return new RuntimeStore(path.join(runtimeDir, 'runtime.sqlite'));
}

function connect(root, runId) {
	return new RuntimeStore(path.join(root, '.agent-sdlc', runId, 'runtime.sqlite'));
}

function initialState(runId) {
	return {
		schemaVersion: '1.0.0', runId, threadId: 'thread-a', runtimeRevision: 0,
		state: 'INITIALIZING', goalArtifact: H, draftArtifact: null, draftHash: null,
		taskManifestArtifact: null, taskManifestHash: null,
		completeness: { complete: false, missingFields: [], ambiguousFields: [] },
		pendingInterruptId: null, approvedSpecHash: null, modelOperations: [],
		workflowHash: H, roleHash: H, promptPolicyHash: H, capabilitySetHash: H, evaluatorSetHash: H,
		completenessHash: null, activeModelOperationId: null, activeProposalArtifact: null,
		interviewRound: 0, specApprovalAttempt: 0, specCriticRepairPending: false, taskPlanFrozen: false,
		createdAt: TIME, updatedAt: TIME,
	};
}

function initialize(store, runId) {
	const state = initialState(runId);
	store.initializeRun(state, createEvent({
		eventType: 'RUN_INITIALIZED', runId, runtimeRevision: 0, state, causalId: 'initialize',
		input: { goalArtifact: H }, output: { draftArtifact: null },
		payload: { goalArtifact: H }, now: new Date(TIME),
	}));
	return state;
}

function transition(store, current, patch) {
	const next = { ...current, ...patch, runtimeRevision: current.runtimeRevision + 1, updatedAt: TIME };
	store.saveTransition(current.runtimeRevision, next, createEvent({
		eventType: 'RUN_BLOCKED', runId: next.runId, runtimeRevision: next.runtimeRevision, state: next,
		causalId: `${next.runId}:${next.runtimeRevision}`,
		payload: { reason: patch.blockedReason ?? patch.state }, now: new Date(TIME),
	}));
	return next;
}

function savePlan(store, runId, task) {
	store.saveTaskPlan({
		schemaVersion: '1.0.0', runId, planPolicyHash: '1'.repeat(64),
		baseCommitSha: 'b'.repeat(40),
		tasks: [{
			taskId: 'done-task', title: 'Completed import', targetPackage: '.',
			pathPrefixes: ['src'], dependsOn: [], status: 'pending', integrationOrder: 0,
			worktreeSubdir: 'worktrees/done-task', baseCommitSha: 'b'.repeat(40),
			authoredPaths: ['src/done.ts'], targetTreeSha: null, ...task,
		}],
		integrationOrder: ['done-task'], isParallel: false, createdAt: TIME,
	});
}

function eventIds(root, runId) {
	const store = new RuntimeStore(path.join(root, '.agent-sdlc', runId, 'runtime.sqlite'));
	try {
		return store.listEvents(runId).map((event) => event.eventId);
	} finally {
		store.close();
	}
}

function rejectCode(message) {
	return (error) => error instanceof SdlcError && error.code === 'INVALID_INPUT' && message.test(error.message);
}

test('prior flags are accepted only as a pair', () => {
	assert.equal(priorTaskFlags(null, undefined), null);
	assert.equal(priorTaskFlags('  ', ''), null);
	assert.deepEqual(priorTaskFlags(` ${PRIOR_ID} `, ' done-task '), { priorRunId: PRIOR_ID, priorTaskId: 'done-task' });
	assert.throws(() => priorTaskFlags(PRIOR_ID, null), rejectCode(/required together/));
	assert.throws(() => priorTaskFlags(null, 'done-task'), rejectCode(/required together/));
	const parsed = parseArguments(['start', '--prior-run', PRIOR_ID, '--prior-task', 'done-task', '--goal-file', 'goal.md']);
	assert.equal(parsed.values.get('--prior-run'), PRIOR_ID);
	assert.throws(() => parseArguments(['status', '--run', PRIOR_ID, '--prior-task', 'done-task']), /not valid for status/);
});

test('shell start rejects one prior flag before the engine', async () => {
	const spy = spyOnRunCli();
	await assert.rejects(
		() => shellStart({
			goalFile: 'goal.md', priorRun: PRIOR_ID, rootDir: REPOSITORY_ROOT,
			streams: SILENT_STREAMS, runCliFn: spy,
		}),
		rejectCode(/required together/),
	);
	assert.deepEqual(spy.calls, []);
});

test('shell start forwards both prior flags on the confirmed start argv', async () => {
	const dir = makeTempDir('prior-forward');
	const goalFile = writeGoalFile(dir);
	const brief = await shellStart({
		goalFile, rootDir: REPOSITORY_ROOT, streams: SILENT_STREAMS, runCliFn: spyOnRunCli(),
	});
	const responseFile = path.join(dir, 'confirm.json');
	fs.writeFileSync(responseFile, JSON.stringify({ confirm: true, briefHash: brief.briefHash }));
	const seen = [];
	async function fakeRunCliFn(args) {
		if (args[0] === 'check-spec') return runCli(args, { rootDir: REPOSITORY_ROOT });
		if (args[0] === 'start') {
			seen.push(args);
			return {
				exitCode: 2,
				result: {
					ok: true, command: 'start', runId: '2026-01-01-fake-run', state: 'WAITING_FOR_ANSWERS',
					continuation: { action: 'answer', reason: 'QUESTIONS_PENDING' },
				},
				human: 'start',
			};
		}
		throw new Error(`unexpected engine command ${args[0]}`);
	}
	await shellStart({
		goalFile, slug: 'prior-forward', responseFile, priorRun: PRIOR_ID, priorTask: 'done-task',
		rootDir: REPOSITORY_ROOT, streams: SILENT_STREAMS, runCliFn: fakeRunCliFn,
	});
	assert.equal(seen.length, 1);
	assert.equal(seen[0][seen[0].indexOf('--prior-run') + 1], PRIOR_ID);
	assert.equal(seen[0][seen[0].indexOf('--prior-task') + 1], 'done-task');
	fs.rmSync(dir, { recursive: true, force: true });
});

test('a retryable prior run is rejected before the replacement directory exists', async (t) => {
	const root = makeRoot();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const store = openStore(root, PRIOR_ID);
	const initial = initialize(store, PRIOR_ID);
	transition(store, initial, { state: 'BLOCKED', blockedReason: 'HYDRATION_FAILED' });
	store.close();
	const parsed = parseArguments([
		'start', '--prior-run', PRIOR_ID, '--prior-task', 'done-task', '--slug', 'no-worktree',
	]);
	await assert.rejects(
		() => startRun(parsed, { rootDir: root, streams: SILENT_STREAMS }),
		rejectCode(/retry is still allowed/),
	);
	assert.deepEqual(fs.readdirSync(path.join(root, 'docs/specs/runs')), []);
	assert.deepEqual(fs.readdirSync(path.join(root, '.agent-sdlc')), [PRIOR_ID]);
});

test('prior checkout rejects a missing run, an open run, and a task that did not pass', async (t) => {
	const root = makeRoot();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	assert.throws(
		() => loadPriorTaskCheckout({ rootDir: root, priorRunId: PRIOR_ID, priorTaskId: 'done-task' }),
		rejectCode(new RegExp(`Prior run '${PRIOR_ID}' was not found`)),
	);
	const store = openStore(root, PRIOR_ID);
	const initial = initialize(store, PRIOR_ID);
	assert.throws(
		() => loadPriorTaskCheckout({ rootDir: root, priorRunId: PRIOR_ID, priorTaskId: 'done-task' }),
		rejectCode(/not halted/),
	);
	transition(store, initial, { state: 'ESCALATED' });
	savePlan(store, PRIOR_ID, { status: 'pending' });
	store.close();
	const before = eventIds(root, PRIOR_ID);
	assert.throws(
		() => loadPriorTaskCheckout({ rootDir: root, priorRunId: PRIOR_ID, priorTaskId: 'missing-task' }),
		rejectCode(/was not found/),
	);
	assert.throws(
		() => loadPriorTaskCheckout({ rootDir: root, priorRunId: PRIOR_ID, priorTaskId: 'done-task' }),
		rejectCode(/verification did not pass/),
	);
	assert.deepEqual(eventIds(root, PRIOR_ID), before);
	assert.equal(fs.existsSync(path.join(root, 'worktrees')), false);
});

test('@ac AC-02: the replacement worktree checks out the completed authored paths', async (t) => {
	const root = makeRoot();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	git(root, ['init']);
	git(root, ['config', 'user.email', 'fixture@example.com']);
	git(root, ['config', 'user.name', 'Fixture Host']);
	fs.mkdirSync(path.join(root, 'src'));
	fs.writeFileSync(path.join(root, 'src/done.ts'), 'prior-bytes\n');
	fs.writeFileSync(path.join(root, 'src/page.ts'), 'base-page\n');
	git(root, ['add', '.']);
	git(root, ['commit', '-m', 'completed']);
	const priorTree = git(root, ['rev-parse', 'HEAD^{tree}']);
	const priorCommit = git(root, ['rev-parse', 'HEAD']);
	fs.writeFileSync(path.join(root, 'src/done.ts'), 'next-done\n');
	fs.writeFileSync(path.join(root, 'src/page.ts'), 'next-page\n');
	git(root, ['add', '.']);
	git(root, ['commit', '-m', 'replacement base']);
	const nextCommit = git(root, ['rev-parse', 'HEAD']);

	const store = openStore(root, PRIOR_ID);
	const initial = initialize(store, PRIOR_ID);
	transition(store, initial, { state: 'ESCALATED' });
	savePlan(store, PRIOR_ID, { status: 'completed', targetTreeSha: priorCommit });
	store.close();
	assert.throws(
		() => loadPriorTaskCheckout({ rootDir: root, priorRunId: PRIOR_ID, priorTaskId: 'done-task' }),
		rejectCode(/not a tree/),
	);
	const again = connect(root, PRIOR_ID);
	again.saveTaskPlan({
		schemaVersion: '1.0.0', runId: PRIOR_ID, planPolicyHash: '1'.repeat(64),
		baseCommitSha: 'b'.repeat(40),
		tasks: [{
			taskId: 'done-task', title: 'Completed import', targetPackage: '.',
			pathPrefixes: ['src'], dependsOn: [], status: 'completed', integrationOrder: 0,
			worktreeSubdir: 'worktrees/done-task', baseCommitSha: 'b'.repeat(40),
			authoredPaths: ['src/done.ts'], targetTreeSha: null,
		}],
		integrationOrder: ['done-task'], isParallel: false, createdAt: TIME,
	});
	again.close();
	assert.throws(
		() => loadPriorTaskCheckout({ rootDir: root, priorRunId: PRIOR_ID, priorTaskId: 'done-task' }),
		rejectCode(/targetTreeSha is missing/),
	);

	const ready = connect(root, PRIOR_ID);
	ready.saveTaskPlan({
		schemaVersion: '1.0.0', runId: PRIOR_ID, planPolicyHash: '1'.repeat(64),
		baseCommitSha: priorCommit,
		tasks: [{
			taskId: 'done-task', title: 'Completed import', targetPackage: '.',
			pathPrefixes: ['src'], dependsOn: [], status: 'completed', integrationOrder: 0,
			worktreeSubdir: 'worktrees/done-task', baseCommitSha: priorCommit,
			authoredPaths: ['../outside.ts'], targetTreeSha: priorTree,
		}],
		integrationOrder: ['done-task'], isParallel: false, createdAt: TIME,
	});
	ready.close();
	assert.throws(
		() => loadPriorTaskCheckout({ rootDir: root, priorRunId: PRIOR_ID, priorTaskId: 'done-task' }),
		rejectCode(/not repository-relative/),
	);

	const recorded = connect(root, PRIOR_ID);
	recorded.saveTaskPlan({
		schemaVersion: '1.0.0', runId: PRIOR_ID, planPolicyHash: '1'.repeat(64),
		baseCommitSha: priorCommit,
		tasks: [{
			taskId: 'done-task', title: 'Completed import', targetPackage: '.',
			pathPrefixes: ['src'], dependsOn: [], status: 'completed', integrationOrder: 0,
			worktreeSubdir: 'worktrees/done-task', baseCommitSha: priorCommit,
			authoredPaths: ['src/done.ts'], targetTreeSha: priorTree,
		}],
		integrationOrder: ['done-task'], isParallel: false, createdAt: TIME,
	});
	recorded.close();
	const before = eventIds(root, PRIOR_ID);
	const checkout = loadPriorTaskCheckout({ rootDir: root, priorRunId: PRIOR_ID, priorTaskId: 'done-task' });
	assert.deepEqual(eventIds(root, PRIOR_ID), before);
	assert.equal(checkout.targetTreeSha, priorTree);
	assert.deepEqual(checkout.authoredPaths, ['src/done.ts']);

	createRuntimeDirectory(NEXT_ID, root);
	writePriorTaskHandoff(root, NEXT_ID, checkout);
	const worktree = path.join(root, 'replacement-worktree');
	git(root, ['worktree', 'add', '--detach', worktree, nextCommit]);
	checkoutRecordedPriorTask({ rootDir: root, runId: NEXT_ID, worktreeDir: worktree, gitCli: execFileSync });

	await t.test('@case AC-02.1: path bytes match the recorded tree', () => {
		assert.equal(fs.readFileSync(path.join(worktree, 'src/done.ts'), 'utf8'), 'prior-bytes\n');
		assert.equal(git(worktree, ['rev-parse', 'HEAD']), nextCommit);
	});
	await t.test('@case AC-02.2: a path outside the completed authored set stays at the new base commit', () => {
		assert.equal(fs.readFileSync(path.join(worktree, 'src/page.ts'), 'utf8'), 'next-page\n');
	});
});

test('checkout skips a missing or empty handoff and rejects a path outside the worktree', (t) => {
	const root = makeRoot();
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	git(root, ['init']);
	git(root, ['config', 'user.email', 'fixture@example.com']);
	git(root, ['config', 'user.name', 'Fixture Host']);
	fs.writeFileSync(path.join(root, 'keep.ts'), 'stay\n');
	git(root, ['add', '.']);
	git(root, ['commit', '-m', 'base']);
	const calls = [];
	const gitCli = (...args) => {
		calls.push(args[1]);
		return '';
	};
	checkoutRecordedPriorTask({ rootDir: root, runId: NEXT_ID, worktreeDir: root, gitCli });
	createRuntimeDirectory(NEXT_ID, root);
	writePriorTaskHandoff(root, NEXT_ID, {
		priorRunId: PRIOR_ID, priorTaskId: 'done-task', targetTreeSha: 'c'.repeat(40), authoredPaths: [],
	});
	checkoutRecordedPriorTask({ rootDir: root, runId: NEXT_ID, worktreeDir: root, gitCli });
	assert.deepEqual(calls, []);
	fs.writeFileSync(path.join(root, '.agent-sdlc', NEXT_ID, 'prior-task.json'), `${JSON.stringify({
		priorRunId: PRIOR_ID, priorTaskId: 'done-task', targetTreeSha: 'c'.repeat(40), authoredPaths: ['../outside.ts'],
	})}\n`);
	assert.throws(
		() => checkoutRecordedPriorTask({ rootDir: root, runId: NEXT_ID, worktreeDir: root, gitCli }),
		rejectCode(/not a recorded tree checkout/),
	);
	assert.deepEqual(calls, []);
});

test('replacement authored paths omit the completed paths', () => {
	const manifest = {
		tasks: [{
			taskId: 'page-task', authoredPaths: ['src/done.ts', 'src/legacy/old.ts', 'src/page.ts'],
			pathPrefixes: ['src'],
		}],
	};
	assert.equal(omitCompletedAuthoredPaths(null, ['src/done.ts']), null);
	assert.equal(omitCompletedAuthoredPaths(manifest, []), manifest);
	const omitted = omitCompletedAuthoredPaths(manifest, ['src/done.ts', 'src/legacy']);
	assert.deepEqual(omitted.tasks[0].authoredPaths, ['src/page.ts']);
	assert.deepEqual(omitted.tasks[0].pathPrefixes, ['src']);
	assert.throws(
		() => omitCompletedAuthoredPaths({ tasks: [{ taskId: 'page-task', authoredPaths: ['src/done.ts'] }] }, ['src/done.ts']),
		rejectCode(/no authored paths outside the completed task/),
	);
	const parent = omitCompletedAuthoredPaths({
		tasks: [{
			taskId: 'page-task', authoredPaths: ['src', 'src/page.ts', 'src/done.ts.bak', 'src/done'],
			generatedOutputs: ['src', 'src/page.ts'], pathPrefixes: ['src'],
		}],
	}, ['src/done.ts']);
	assert.deepEqual(parent.tasks[0].authoredPaths, ['src/page.ts', 'src/done.ts.bak', 'src/done']);
	assert.deepEqual(parent.tasks[0].generatedOutputs, ['src/page.ts']);
	assert.deepEqual(parent.tasks[0].pathPrefixes, ['src']);
	assert.throws(
		() => omitCompletedAuthoredPaths({ tasks: [{ taskId: 'page-task', authoredPaths: ['src'] }] }, ['src/done.ts']),
		rejectCode(/no authored paths outside the completed task/),
	);
});
