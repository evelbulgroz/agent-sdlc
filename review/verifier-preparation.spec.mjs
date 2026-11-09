import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { computePreparationPolicyHash, computePreparationSelectionBinding } from '../host/verification-preparation.ts';
import { finalPreparationHook } from '../execution/verification-preparation.ts';
import { BUILDS, packageRunner, withFixture, writeFile } from '../testing/verification-preparation-fixture.ts';
import { executeCommittedPreflightVerifier, executePreflightVerifier } from './verifier.ts';

const RUN_ID = '2026-11-01-prep-final';
const BASE_SHA = '1'.repeat(40);
const COMMIT_SHA = '3'.repeat(40);
const TREE_SHA = '4'.repeat(40);
const PLAN_TASKS = [
	{ taskId: 'task-0', targetPackage: 'packages/base', pathPrefixes: ['packages/base/src'] },
	{ taskId: 'task-1', targetPackage: 'packages/consumer', pathPrefixes: ['packages/consumer'] },
];
const VERIFY = "import { greet } from '../base/dist/index.mjs';\nif (greet() !== 'integrated') { console.error('saw ' + greet()); process.exit(1); }\n";

/** Host verify really runs the consumer check against compiled base output, then writes the preflight result. */
function harness(root, headSha) {
	const calls = [];
	const events = [];
	const builds = packageRunner(root, []);
	const execCli = (cmd, args, options) => {
		calls.push([cmd, ...args].join(' '));
		if (args[0] === '--filter') return builds(cmd, args, options);
		execFileSync('node', ['packages/consumer/verify.mjs'], { cwd: root, stdio: 'pipe' });
		writeFile(root, 'tools/.agent-preflight-last.json', JSON.stringify({ status: 'OK', canonical: true, base: BASE_SHA, gitHeadSha: headSha }));
		return '';
	};
	const prepare = finalPreparationHook({
		runId: RUN_ID, runtimeRevision: 7, worktreeDir: root, execCli, planTasks: PLAN_TASKS,
		authorizedPolicyHash: computePreparationPolicyHash({ builds: BUILDS }),
		frozenSelectionHash: computePreparationSelectionBinding({ builds: BUILDS }, PLAN_TASKS).digest,
		artifactStore: { writeJson: () => 'b'.repeat(64) },
		runtimeStore: { appendEvent: (event) => events.push(event) },
	});
	return { calls, events, execCli, prepare };
}

function integrationFixture(fn) {
	return withFixture((root) => {
		writeFile(root, 'packages/consumer/verify.mjs', VERIFY);
		writeFile(root, 'packages/base/src/index.mjs', "export const greet = () => 'integrated';\n");
		return fn(root);
	});
}

test('@ac AC-03 @case AC-03.6 reconciled integration preflight runs the union builds before host verify and observes them', async () => {
	await integrationFixture(async (root) => {
		const h = harness(root, BASE_SHA);
		const result = await executePreflightVerifier({
			runId: RUN_ID, worktreeDir: root, baseCommitSha: BASE_SHA, targetTreeSha: TREE_SHA, execCli: h.execCli, prepare: h.prepare,
		});
		assert.equal(result.status, 'PASS', JSON.stringify(result.failurePacket ?? null));
		assert.deepEqual(h.calls, [
			'pnpm --filter @fx/base build',
			'pnpm --filter @fx/consumer build',
			`pnpm run agent:verify -- --base ${BASE_SHA}`,
		]);
		assert.equal(h.events[0].payload.taskId, 'final');
		assert.equal(h.events[0].payload.status, 'passed');
	});
});

test('@ac AC-03 @case AC-03.7 committed-tree verification rebuilds after the clean-tree check and observes the build', async () => {
	await integrationFixture(async (root) => {
		const h = harness(root, COMMIT_SHA);
		const gitCalls = [];
		const result = await executeCommittedPreflightVerifier({
			runId: RUN_ID, worktreeDir: root, baseCommitSha: BASE_SHA, commitSha: COMMIT_SHA, targetTreeSha: TREE_SHA,
			execCli: h.execCli, prepare: h.prepare,
			gitCli: (_cmd, args) => {
				gitCalls.push(args.join(' '));
				if (args[0] === 'status') return '';
				return args[1] === 'HEAD' ? `${COMMIT_SHA}\n` : `${TREE_SHA}\n`;
			},
		});
		assert.equal(result.status, 'PASS', JSON.stringify(result.failurePacket ?? null));
		assert.equal(gitCalls[0], 'status --porcelain');
		assert.equal(h.calls.length, 3);
		assert.equal(h.calls[2], `pnpm run agent:verify -- --base ${BASE_SHA}`);
	});
});

test('@ac AC-04 @case AC-04.1 a failed final preparation returns FAIL without running the host verify command', async () => {
	await integrationFixture(async (root) => {
		writeFile(root, 'packages/base/build.mjs', "console.error('broken build'); process.exit(4);\n");
		const h = harness(root, BASE_SHA);
		const result = await executePreflightVerifier({
			runId: RUN_ID, worktreeDir: root, baseCommitSha: BASE_SHA, targetTreeSha: TREE_SHA, execCli: h.execCli, prepare: h.prepare,
		});
		assert.equal(result.status, 'FAIL');
		assert.deepEqual(h.calls, ['pnpm --filter @fx/base build']);
		assert.match(result.failurePacket.failedCommand, /verification-preparation:build-base:build-failed/);
		assert.equal(h.events[0].payload.status, 'failed');
		assert.equal(fs.existsSync(path.join(root, 'tools/.agent-preflight-last.json')), false);
	});
});

test('final verification without a preparation hook keeps the previous host verify behavior', async () => {
	await integrationFixture(async (root) => {
		writeFile(root, 'packages/base/src/index.mjs', "export const greet = () => 'old';\n");
		writeFile(root, 'packages/consumer/verify.mjs', VERIFY.replace("'integrated'", "'old'"));
		const h = harness(root, BASE_SHA);
		const result = await executePreflightVerifier({
			runId: RUN_ID, worktreeDir: root, baseCommitSha: BASE_SHA, targetTreeSha: TREE_SHA, execCli: h.execCli,
		});
		assert.equal(result.status, 'PASS');
		assert.deepEqual(h.calls, [`pnpm run agent:verify -- --base ${BASE_SHA}`]);
	});
});
