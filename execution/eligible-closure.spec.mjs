import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertEligiblePredecessors, eligibleParentTasks, sliceClosureTasks, materializeClosureTree } from './eligible-closure.ts';

const task = (taskId, sliceId, dependsOn = []) => ({ taskId, sliceId, dependsOn, pathPrefixes: ['src'] });
const plan = {
	slices: [
		{ sliceId: 'enable', kind: 'enabling', dependsOn: [] },
		{ sliceId: 'reviewed', kind: 'vertical', dependsOn: [] },
		{ sliceId: 'vertical', kind: 'vertical', dependsOn: ['enable', 'reviewed'] },
		{ sliceId: 'other', kind: 'activation', dependsOn: [] },
	],
	tasks: [
		task('enable-a', 'enable'), task('enable-b', 'enable'),
		task('reviewed-a', 'reviewed'), task('first', 'vertical', ['enable-a', 'reviewed-a']),
		task('later', 'vertical', ['first']), task('unrelated', 'other'),
	],
	integrationOrder: ['enable-a', 'enable-b', 'reviewed-a', 'first', 'later', 'unrelated'],
};

test('@case AC-03.3 @case AC-03.6 same-slice parent includes enabling siblings and local deltas', () => {
	assert.deepEqual(eligibleParentTasks(plan, 'first').map(t => t.taskId),
		['enable-a', 'enable-b', 'reviewed-a']);
	assert.deepEqual(eligibleParentTasks(plan, 'later').map(t => t.taskId),
		['enable-a', 'enable-b', 'reviewed-a', 'first']);
	assert.deepEqual(sliceClosureTasks(plan, 'vertical').map(t => t.taskId),
		['enable-a', 'enable-b', 'reviewed-a', 'first', 'later']);
});

test('@case AC-03.2 verified enabling and accepted reviewed predecessors both gate release', () => {
	assert.doesNotThrow(() => assertEligiblePredecessors(plan, 'vertical',
		id => id === 'enable' ? 'verified' : 'accepted'));
	for (const status of [null, '', 'reviewing', 'accepted']) {
		assert.throws(() => assertEligiblePredecessors(plan, 'vertical',
			id => id === 'enable' ? status : 'accepted'), /eligible verified/);
	}
	assert.throws(() => assertEligiblePredecessors(plan, 'vertical', () => 'verified'), /eligible accepted/);
});

test('rejects missing tasks, empty integration order and cyclic closure', () => {
	assert.throws(() => eligibleParentTasks(plan, 'missing'), /requires a slice/);
	assert.throws(() => eligibleParentTasks({ ...plan, integrationOrder: [] }, 'later'), /omits/);
	assert.throws(() => eligibleParentTasks({ ...plan, tasks: null }, 'later'));
	assert.throws(() => sliceClosureTasks({
		...plan, slices: [{ sliceId: 'enable', kind: 'enabling', dependsOn: ['enable'] }],
	}, 'enable'), /Cycle/);
});

test('@case AC-03.7 real task deltas preserve enabling siblings, local edits and corrections once', t => {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-closure-'));
	t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
	const git = (args, options = {}) => execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', ...options });
	git(['init', '--quiet']);
	git(['read-tree', '--empty']);
	const base = git(['write-tree']).trim();
	const delta = (taskId, parent, file, text) => {
		git(['read-tree', parent]);
		const blob = git(['hash-object', '-w', '--stdin'], { input: text }).trim();
		git(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`]);
		const target = git(['write-tree']).trim();
		const patch = git(['diff-tree', '-r', '-p', '--binary', parent, target]);
		return { taskId, parentTreeSha: parent, targetTreeSha: target,
			patchHash: crypto.createHash('sha256').update(patch).digest('hex'),
			status: 'completed', pathPrefixes: [file] };
	};
	const a = delta('a', base, 'a.txt', 'first\n');
	const b = delta('b', base, 'b.txt', 'sibling\n');
	const enabling = materializeClosureTree({ baseTreeSha: base, tasks: [a, b], rootDir, gitCli: execFileSync });
	assert.equal(git(['show', `${enabling}:b.txt`]), 'sibling\n');
	const c = delta('c', enabling, 'c.txt', 'local\n');
	const laterParent = materializeClosureTree({ baseTreeSha: base, tasks: [a, b, c], rootDir, gitCli: execFileSync });
	assert.equal(git(['show', `${laterParent}:a.txt`]), 'first\n');
	assert.equal(git(['show', `${laterParent}:c.txt`]), 'local\n');
	const corrected = delta('a', base, 'a.txt', 'corrected\n');
	const newEnabling = materializeClosureTree({ baseTreeSha: base, tasks: [corrected, b], rootDir, gitCli: execFileSync });
	const newC = delta('c', newEnabling, 'c.txt', 'local\n');
	const final = materializeClosureTree({ baseTreeSha: base, tasks: [corrected, b, newC], rootDir, gitCli: execFileSync });
	assert.equal(git(['show', `${final}:a.txt`]), 'corrected\n');
	assert.equal(git(['show', `${final}:b.txt`]), 'sibling\n');
	assert.equal(git(['show', `${final}:c.txt`]), 'local\n');
	assert.throws(() => materializeClosureTree({ baseTreeSha: base,
		tasks: [{ ...a, patchHash: '0'.repeat(64) }], rootDir, gitCli: execFileSync }), /hash mismatch/);
	assert.throws(() => materializeClosureTree({ baseTreeSha: base,
		tasks: [{ ...a, pathPrefixes: [] }], rootDir, gitCli: execFileSync }), /escapes/);
});
