import assert from 'node:assert/strict';
import { test } from 'node:test';
import { affectedCorrectionTasks, executeApprovedCorrection } from './correction-rematerialization.ts';

const task = (taskId, sliceId, dependsOn = []) => ({ taskId, sliceId, dependsOn, pathPrefixes: ['src'] });
const plan = {
	tasks: [task('a', 'enable'), task('b', 'enable'), task('c', 'vertical', ['a']),
		task('d', 'vertical', ['c']), task('unrelated', 'other')],
	slices: [{ sliceId: 'enable', kind: 'enabling', dependsOn: [] },
		{ sliceId: 'vertical', kind: 'vertical', dependsOn: ['enable'] },
		{ sliceId: 'other', kind: 'vertical', dependsOn: [] }],
	integrationOrder: ['a', 'b', 'c', 'd', 'unrelated'],
};
const rev = id => ({ taskId: id, executionRevision: 0, parentTreeSha: 'a'.repeat(40),
	targetTreeSha: 'b'.repeat(40), patchHash: 'c'.repeat(64) });

test('@case AC-07.6 correction closure follows slice siblings, not just individual task edges', () => {
	assert.deepEqual(affectedCorrectionTasks(plan, ['b']), ['b', 'c', 'd']);
	assert.deepEqual(affectedCorrectionTasks(plan, ['c']), ['c', 'd']);
	for (const owners of [[], ['missing'], ['a', 'a']]) {
		assert.throws(() => affectedCorrectionTasks(plan, owners), /Correction|Unknown/);
	}
});

test('@case AC-03.7 stages all fresh revisions and commits current selection only after rebuilt verification', async () => {
	const calls = [];
	const ports = {
		phase: () => {},
		materialize: async task => calls.push(`parent:${task.taskId}`),
		edit: async task => calls.push(`edit:${task.taskId}`),
		verifyAndCapture: async (task, old) => ({ ...old, executionRevision: 1 }),
		stage: revision => calls.push(`stage:${revision.taskId}`),
		rebuildAndVerify: async staged => {
			assert.deepEqual([...staged.keys()], ['b', 'c', 'd']);
			calls.push('rebuild');
		},
		completeAtomically: () => calls.push('commit'),
	};
	await executeApprovedCorrection({ plan, owners: ['b'],
		previous: new Map(plan.tasks.map(task => [task.taskId, rev(task.taskId)])), ports });
	assert.deepEqual(calls, ['parent:b', 'edit:b', 'stage:b', 'parent:c', 'stage:c', 'parent:d', 'stage:d', 'rebuild', 'commit']);
});

test('verification timeout leaves staged revisions ineligible and does not commit', async () => {
	let committed = false;
	await assert.rejects(executeApprovedCorrection({
		plan, owners: ['b'], previous: new Map(plan.tasks.map(task => [task.taskId, rev(task.taskId)])),
		ports: { phase: () => {}, materialize: async () => {}, edit: async () => {},
			verifyAndCapture: async () => { throw new Error('timeout'); }, stage: () => {},
			rebuildAndVerify: async () => {}, completeAtomically: () => { committed = true; } },
	}), /timeout/);
	assert.equal(committed, false);
});
