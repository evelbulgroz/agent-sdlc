import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FakeModelGovernor } from '../fake-model-governor.mjs';
import { makeFixture } from '../test-support.mjs';
import { TaskExecutor } from '../../execution/task-executor.ts';
import { projectTasks } from '../../cli/status-document.ts';

const BASE = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const BLOCKED_SUMMARY = 'Blocked: the invariant and AC-02 contradict each other. Which rule wins?';

function refusalPlan(runId) {
	return {
		schemaVersion: '1.0.0',
		runId,
		planPolicyHash: '1'.repeat(64),
		baseCommitSha: BASE,
		isParallel: false,
		tasks: [
			{
				taskId: 'task-0',
				title: 'Implement billing',
				targetPackage: 'services/billing',
				pathPrefixes: ['services/billing'],
				dependsOn: [],
				status: 'pending',
				integrationOrder: 0,
				worktreeSubdir: 'worktree',
				baseCommitSha: BASE,
				parentTreeSha: null,
				targetTreeSha: null,
				patchHash: null,
				failurePacketArtifact: null,
				repairCount: 0,
				parentCommitSha: null,
			},
		],
		integrationOrder: ['task-0'],
		createdAt: new Date().toISOString(),
	};
}

// S4: the implementer reports it is blocked on every attempt. The run fails closed
// with TASK_EXECUTION_FAILED and the summary reaches the status projection.
test('@ac AC-03 @case AC-03.S4 a refusing implementer fails closed and its summary reaches the status projection', async () => {
	const fixture = makeFixture('qual-s4-refusal', []);
	try {
		fixture.runtime.initialize({ runId: fixture.runId, goal: 'Refusal scenario' });
		const taskPlan = refusalPlan(fixture.runId);
		fixture.store.saveTaskPlan(taskPlan);
		const governor = new FakeModelGovernor(
			Array.from({ length: 6 }, () => ({ action: { kind: 'complete', summary: BLOCKED_SUMMARY } })),
		);
		const executor = new TaskExecutor({
			governor,
			runtimeStore: fixture.store,
			artifactStore: fixture.artifacts,
			roleRegistry: fixture.registry,
			gitCli: (_cmd, args) => {
				if (args[0] === 'rev-parse' && args[1] === 'HEAD') return `${BASE}\n`;
				if (args[0] === 'rev-parse') return `${TREE}\n`;
				if (args[0] === 'worktree' && args[1] === 'add') {
					const pkgDir = path.join(args[3], 'services/billing');
					fs.mkdirSync(pkgDir, { recursive: true });
					fs.writeFileSync(
						path.join(pkgDir, 'package.json'),
						JSON.stringify({ name: '@fixture/billing-service', scripts: { test: 'node --test' } }),
					);
					return '';
				}
				if (args[0] === 'diff') return 'diff --git a/services/billing/src/code.ts';
				if (args[0] === 'diff-index') return 'services/billing/src/code.ts\n';
				if (args[0] === 'diff-tree') return 'diff --git a/code.ts\n';
				if (args[0] === 'write-tree') return `${TREE}\n`;
				return '';
			},
			execCli: (_cmd, args) => {
				if (args?.[0] === '--filter' && args?.[2] === 'test') {
					const err = new Error('contradiction');
					err.status = 1;
					err.stdout = 'AssertionError: invariant contradicts AC-02';
					err.stderr = '';
					throw err;
				}
				return '';
			},
			runTaskTests: true,
		});
		let failure = null;
		await assert.rejects(
			() =>
				executor.executeTaskPlan({
					taskPlan,
					authorization: {
						allowedPackages: ['services/billing'],
						allowedPathPrefixes: ['services/billing'],
						maxSemanticRepairs: 2,
					},
					snapshot: { taskPlanFrozen: true },
				}),
			(err) => {
				assert.equal(err.code, 'TASK_EXECUTION_FAILED');
				assert.equal(err.metadata?.lastSummary, BLOCKED_SUMMARY);
				failure = err;
				return true;
			},
		);
		const [projected] = projectTasks(
			{ ...taskPlan, tasks: taskPlan.tasks.map((task) => ({ ...task, status: 'failed' })) },
			{ lastError: { code: failure.code, message: failure.message, metadata: failure.metadata } },
		);
		assert.equal(projected.failureMetadata?.lastSummary, BLOCKED_SUMMARY);
	} finally {
		fixture.close();
	}
});
