import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '../policy/contracts/primitives.ts';
import { qualityParentRevisionHash } from './quality-checkpoints.ts';

test('same-slice parent identity includes verified enabling siblings and selected local revisions', () => {
	const plan = {
		slices: [
			{ sliceId: 'enable', kind: 'enabling', dependsOn: [] },
			{ sliceId: 'vertical', kind: 'vertical', dependsOn: ['enable'] },
		],
		integrationOrder: ['enable-a', 'enable-b', 'local-a', 'local-b'],
		tasks: [
			{ taskId: 'enable-a', sliceId: 'enable', dependsOn: [] },
			{ taskId: 'enable-b', sliceId: 'enable', dependsOn: [] },
			{ taskId: 'local-a', sliceId: 'vertical', dependsOn: ['enable-a'] },
			{ taskId: 'local-b', sliceId: 'vertical', dependsOn: ['local-a'] },
		],
	};
	const revisions = [
		{ taskId: 'enable-a', executionRevision: 0, patchHash: 'a', status: 'completed' },
		{ taskId: 'enable-b', executionRevision: 1, patchHash: 'b', status: 'completed' },
		{ taskId: 'local-a', executionRevision: 0, patchHash: 'c', status: 'completed' },
	];
	const expected = sha256([
		{ taskId: 'enable-a', executionRevision: 0, patchHash: 'a' },
		{ taskId: 'enable-b', executionRevision: 1, patchHash: 'b' },
		{ taskId: 'local-a', executionRevision: 0, patchHash: 'c' },
	]);
	assert.equal(qualityParentRevisionHash(plan, 'local-b', revisions), expected);
	assert.notEqual(qualityParentRevisionHash(plan, 'local-b',
		revisions.map(revision => revision.taskId === 'enable-b' ? { ...revision, executionRevision: 2 } : revision)), expected);
	assert.equal(qualityParentRevisionHash(plan, 'enable-a', []), sha256([]));
	assert.throws(() => qualityParentRevisionHash(plan, 'local-b', []), /Missing eligible parent/);
	assert.throws(() => qualityParentRevisionHash(plan, 'local-b',
		revisions.map(revision => ({ ...revision, status: 'verifying' }))), /Missing eligible parent/);
	assert.throws(() => qualityParentRevisionHash(plan, 'unknown', revisions), /requires a slice/);
});
