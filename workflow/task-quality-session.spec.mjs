import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { taskQualityFixture as fixture } from '../testing/task-quality-fixture.ts';

test('enabling task proof persists and reuses an exact receipt without running verification twice', async t => {
	const f = fixture(t);
	await f.session.hooks.verifyTask(f.candidate, f.worktreeDir);
	assert.equal(f.commandCount(), 1);
	assert.equal(f.store.quality.getCurrentTaskRevision(f.runId, 'enable-task').status, 'completed');
	await f.session.hooks.verifyTask(f.candidate, f.worktreeDir);
	assert.equal(f.commandCount(), 1);
	assert.equal(f.store.quality.getBudget(f.runId).counters.executionInvocations, 1);
	const closure = await f.session.prepareSlice('enable', {
		...f.plan, tasks: [{ ...f.candidate, status: 'completed' }, f.plan.tasks[1]],
	});
	assert.equal(closure.status, 'verified');
	assert.equal(closure.binding.treeSha, f.candidate.targetTreeSha);
	assert.equal(closure.receiptHashes.length, 1);
	assert.equal(f.store.quality.getClosure(f.runId, closure.binding.checkpointId, 0).status, 'verified');
});

test('@ac AC-01 @case AC-01.1 @case AC-01.2 task checkpoint scores the recorded report and does not spawn', async t => {
	const f = fixture(t, { recordedReport: true });
	fs.writeFileSync(path.join(f.worktreeDir, 'src/task-report.xml'),
		'<testsuite><testcase name="@ac AC-01 @case AC-01.1 ready"/></testsuite>\n');
	fs.writeFileSync(path.join(f.worktreeDir, 'src/run.mjs'),
		'import fs from "node:fs"; fs.writeFileSync(new URL("./spawned.txt", import.meta.url), "1");\n');
	await f.session.hooks.verifyTask(f.candidate, f.worktreeDir);
	const vertical = {
		...f.plan.tasks[1], parentTreeSha: f.tree, targetTreeSha: f.tree, patchHash: f.candidate.patchHash,
		verificationCommand: ['pnpm', 'run', 'test:unit', 'src/task-report.xml'],
	};
	await f.session.hooks.verifyTask(vertical, f.worktreeDir);
	assert.equal(fs.existsSync(path.join(f.worktreeDir, 'src/spawned.txt')), false);
	assert.equal(f.commandCount(), 2);
	assert.equal(f.store.quality.getCurrentTaskRevision(f.runId, 'vertical-task').status, 'completed');
});

test('interrupted task verification cannot execute again without its completed receipt', async t => {
	const f = fixture(t);
	f.store.quality.reserveBudget(f.runId, {
		operationId: `verification-enable-task-r0-${f.candidate.targetTreeSha}`, kind: 'execution',
		checkpointId: 'task:enable-task', candidateRevision: 0, status: 'reserved',
	});
	await assert.rejects(f.session.hooks.verifyTask(f.candidate, f.worktreeDir), /no complete receipt/);
	assert.equal(f.commandCount(), 0);
	assert.equal(f.store.quality.getCurrentTaskRevision(f.runId, 'enable-task'), null);
});
