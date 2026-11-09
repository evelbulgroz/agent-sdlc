import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { computePreparationPolicyHash, computePreparationSelectionBinding } from '../host/verification-preparation.ts';
import { BUILDS, TASKS, packageRunner, withFixture, writeFile } from '../testing/verification-preparation-fixture.ts';
import { executeTool } from './tools.ts';
import { taskPreparationHooks } from './verification-preparation.ts';

const VERIFY = "import { greet } from '../base/dist/index.mjs';\nconsole.log('greet=' + greet());\n";
const TEST_ARGS = ['--filter', '@fx/consumer', 'test'];

/** Model-invoked `pnpm --filter @fx/consumer test` really runs the consumer against compiled base output. */
function harness(root, { prepared = true } = {}) {
	const calls = [];
	const events = [];
	const builds = packageRunner(root, []);
	const execCli = (cmd, args, options) => {
		calls.push([cmd, ...args].join(' '));
		if (args[2] === 'build') return builds(cmd, args, options);
		return execFileSync('node', ['verify.mjs'], { ...options, cwd: path.join(root, 'packages/consumer') });
	};
	const hooks = taskPreparationHooks({
		runId: '2026-11-01-prep-explore',
		task: { taskId: 'task-1', pathPrefixes: ['packages/consumer'] },
		taskPlan: { tasks: TASKS },
		authorization: prepared ? { preparationPolicyHash: computePreparationPolicyHash({ builds: BUILDS }) } : null,
		snapshot: { runtimeRevision: 2, ...(prepared ? { preparationSelectionHash: computePreparationSelectionBinding({ builds: BUILDS }, TASKS).digest } : {}) },
		worktreeDir: root,
		execCli,
		artifactStore: { writeJson: () => 'f'.repeat(64) },
		runtimeStore: { appendEvent: (event) => events.push(event) },
	});
	const run = (args = TEST_ARGS) =>
		executeTool({
			toolName: 'run_allowlisted_command',
			parameters: { command: 'pnpm', args },
			worktreeDir: root,
			allowedPackages: ['packages/consumer'],
			execCli,
			prepareCommand: hooks.prepareExploratory,
		});
	const buildCount = () => calls.filter((call) => call.endsWith(' build')).length;
	return { calls, events, run, buildCount };
}

function explorationFixture(fn, options) {
	return withFixture((root) => {
		writeFile(root, 'packages/consumer/verify.mjs', VERIFY);
		writeFile(root, 'packages/base/src/index.mjs', "export const greet = () => 'new';\n");
		return fn(root);
	}, options);
}

test('@ac AC-03 @case AC-03.8 a model command rebuilds first, then only when upstream source is stale', () => {
	explorationFixture((root) => {
		const h = harness(root);
		const first = h.run();
		assert.equal(first.exitCode, 0, first.stderr);
		assert.match(first.stdout, /greet=new/);
		assert.deepEqual(h.calls, ['pnpm --filter @fx/base build', 'pnpm --filter @fx/consumer build', 'pnpm --filter @fx/consumer test']);

		assert.match(h.run().stdout, /greet=new/);
		assert.equal(h.buildCount(), 2, 'no rebuild while the candidate digest is unchanged');

		writeFile(root, 'packages/base/src/index.mjs', "export const greet = () => 'edited';\n");
		assert.match(h.run().stdout, /greet=edited/);
		assert.equal(h.buildCount(), 4, 'a stale candidate triggers a rebuild');
		assert.deepEqual([...new Set(h.events.map((event) => event.payload.purpose))], ['exploratory']);
	});
});

test('@ac AC-03 @case AC-03.8 a failed exploratory build is non-terminal command output and is retried next time', () => {
	explorationFixture((root) => {
		writeFile(root, 'packages/base/build.mjs', "console.error('TS2322 in base'); process.exit(2);\n");
		const h = harness(root);
		const result = h.run();
		assert.equal(result.exitCode, 1);
		assert.match(result.stdout, /Prerequisite build failed \(build-failed\); this command did not run/);
		assert.match(result.stdout, /TS2322 in base/);
		assert.deepEqual(h.calls, ['pnpm --filter @fx/base build']);
		h.run();
		assert.equal(h.calls.filter((call) => call === 'pnpm --filter @fx/base build').length, 2);
		assert.equal(h.events[0].payload.status, 'failed');
	});
});

test('@ac AC-03 @case AC-03.8 commands rejected by the allowlist never trigger builds', () => {
	explorationFixture((root) => {
		const h = harness(root);
		assert.throws(() => h.run(['--filter', '@fx/consumer', 'publish']), /not allowlisted/);
		assert.deepEqual(h.calls, []);
	});
});

test('model commands on a host without preparation run unchanged', () => {
	explorationFixture((root) => {
		const h = harness(root, { prepared: false });
		assert.match(h.run().stdout, /greet=old/);
		h.run();
		assert.deepEqual(h.calls, ['pnpm --filter @fx/consumer test', 'pnpm --filter @fx/consumer test']);
		assert.equal(h.events.length, 0);
	}, { builds: null });
});
