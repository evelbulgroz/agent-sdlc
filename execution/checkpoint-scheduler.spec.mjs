import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskExecutor } from './task-executor.ts';

function fixture() {
	const slices = [
		{ sliceId: 'enable', kind: 'enabling', dependsOn: [] },
		{ sliceId: 'vertical', kind: 'vertical', dependsOn: ['enable'] },
		{ sliceId: 'activation', kind: 'activation', dependsOn: ['vertical'] },
	];
	const task = (taskId, sliceId, dependsOn = []) => ({
		taskId, sliceId, dependsOn, status: 'pending', baseCommitSha: 'a'.repeat(40),
		targetPackage: 'pkg', pathPrefixes: ['src'],
	});
	const plan = {
		runId: '2026-11-01-sdlc-fixture', slices,
		tasks: [task('enable-a', 'enable'), task('enable-b', 'enable'),
			task('vertical-a', 'vertical', ['enable-a']),
			task('vertical-b', 'vertical', ['vertical-a']),
			task('activate', 'activation', ['vertical-b'])],
		integrationOrder: ['enable-a', 'enable-b', 'vertical-a', 'vertical-b', 'activate'],
	};
	const statuses = new Map();
	const calls = [];
	const completed = new Map();
	const executor = new TaskExecutor({
		governor: {}, runtimeStore: { listTasks: () => [...completed.values()] },
		artifactStore: {}, roleRegistry: {}, runMaxPhysicalCalls: 50,
	});
	executor.executeTask = async ({ task }) => {
		calls.push(task.taskId);
		task.status = 'completed';
		completed.set(task.taskId, { ...task });
		return task;
	};
	const quality = {
		plan, closureStatus: id => statuses.get(id) ?? null,
		verifyEnabling: async id => { calls.push(`verified:${id}`); statuses.set(id, 'verified'); },
		verifyTask: async () => {},
	};
	return { plan, statuses, calls, executor, quality };
}

test('@case AC-03.2 @case AC-09.5 yields slice reviews before releasing vertical and activation dependents', async () => {
	const f = fixture();
	const opts = { taskPlan: f.plan, snapshot: { taskPlanFrozen: true }, quality: f.quality };
	const first = await f.executor.executeTaskPlan(opts);
	assert.equal(first.status, 'CHECKPOINT_REQUIRED');
	assert.equal(first.sliceId, 'vertical');
	assert.deepEqual(f.calls, ['enable-a', 'enable-b', 'verified:enable', 'vertical-a', 'vertical-b']);
	const replay = await f.executor.executeTaskPlan(opts);
	assert.equal(replay.sliceId, 'vertical');
	assert.equal(f.calls.includes('activate'), false);
	f.statuses.set('vertical', 'accepted');
	const second = await f.executor.executeTaskPlan(opts);
	assert.equal(second.sliceId, 'activation');
	assert.equal(f.calls.at(-1), 'activate');
	f.statuses.set('activation', 'accepted');
	assert.equal((await f.executor.executeTaskPlan(opts)).status, 'COMPLETED');
});

test('enabling verification error and missing freeze prevent release', async () => {
	const f = fixture();
	f.quality.verifyEnabling = async () => { throw new Error('verification timeout'); };
	await assert.rejects(f.executor.executeTaskPlan({
		taskPlan: f.plan, snapshot: { taskPlanFrozen: true }, quality: f.quality,
	}), /verification timeout/);
	assert.equal(f.calls.includes('vertical-a'), false);
	await assert.rejects(f.executor.executeTaskPlan({ taskPlan: f.plan, snapshot: null }), /taskPlanFrozen/);
});

test('selected corrected revisions cannot be overwritten by stale DAG runtime rows', async () => {
	const f = fixture();
	for (const task of f.plan.tasks) Object.assign(task, {
		status: 'completed', parentTreeSha: 'b'.repeat(40),
		targetTreeSha: 'c'.repeat(40), patchHash: 'd'.repeat(64),
	});
	f.executor.runtimeStore.listTasks = () => f.plan.tasks.map(task => ({
		...task, parentTreeSha: '1'.repeat(40), targetTreeSha: '2'.repeat(40), patchHash: '3'.repeat(64),
	}));
	f.statuses.set('enable', 'verified');
	f.statuses.set('vertical', 'accepted');
	f.statuses.set('activation', 'accepted');
	const result = await f.executor.executeTaskPlan({
		taskPlan: f.plan, snapshot: { taskPlanFrozen: true }, quality: f.quality,
	});
	assert.equal(result.status, 'COMPLETED');
	assert.equal(result.tasks[0].parentTreeSha, 'b'.repeat(40));
	assert.equal(result.tasks[0].targetTreeSha, 'c'.repeat(40));
	assert.equal(result.tasks[0].patchHash, 'd'.repeat(64));
	assert.deepEqual(f.calls, []);
});
