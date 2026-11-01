import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { computePreparationPolicyHash, computePreparationSelectionBinding } from '../host/verification-preparation.ts';
import { hydrateWorktree } from '../workflow/hydration.ts';
import { BUILDS, TASKS, packageRunner, withFixture, writeFile } from '../testing/verification-preparation-fixture.mjs';
import { runVerification } from './minimal-verification.ts';
import { taskPreparationHook } from './verification-preparation.ts';

const VERIFY = "import { greet } from '../base/dist/index.mjs';\nif (greet() !== process.argv[2]) { console.error('saw ' + greet()); process.exit(1); }\n";

function harness(root) {
	const calls = [];
	const events = [];
	const artifacts = [];
	const builds = packageRunner(root, []);
	const execCli = (cmd, args, options) => {
		calls.push([cmd, ...args].join(' '));
		return cmd === 'pnpm' ? builds(cmd, args, options) : execFileSync(cmd, args, options);
	};
	const hook = taskPreparationHook({
		runId: '2026-11-01-prep-run',
		task: { taskId: 'task-1', pathPrefixes: ['packages/consumer'] },
		taskPlan: { tasks: TASKS },
		authorization: { preparationPolicyHash: computePreparationPolicyHash({ builds: BUILDS }) },
		snapshot: { runtimeRevision: 3, preparationSelectionHash: computePreparationSelectionBinding({ builds: BUILDS }, TASKS).digest },
		worktreeDir: root,
		execCli,
		artifactStore: { writeJson: (kind, payload) => { artifacts.push({ kind, payload }); return `${'a'.repeat(63)}${artifacts.length}`; } },
		runtimeStore: { appendEvent: (event) => events.push(event) },
	});
	const verify = (expected, extra = {}) =>
		runVerification({
			execCli,
			runtimeStore: null,
			clock: Date.now,
			attempt: 1,
			input: {
				runId: '2026-11-01-prep-run', taskId: 'task-1', worktreeDir: root,
				verificationCommands: [['node', 'packages/consumer/verify.mjs', expected]],
				prepareVerification: hook, ...extra,
			},
		});
	return { calls, events, artifacts, verify, execCli };
}

function withConsumerFixture(fn) {
	return withFixture((root) => {
		writeFile(root, 'packages/consumer/verify.mjs', VERIFY);
		writeFile(root, 'packages/base/src/index.mjs', "export const greet = () => 'new';\n");
		return fn(root);
	});
}

test('@ac AC-03 @case AC-03.4 full declared verification runs only after the prerequisite builds', () => {
	withConsumerFixture((root) => {
		const h = harness(root);
		const result = h.verify('new');
		assert.equal(result.ok, true, result.output);
		assert.deepEqual(h.calls, ['pnpm --filter @fx/base build', 'pnpm --filter @fx/consumer build', 'node packages/consumer/verify.mjs new']);
	});
});

test('@ac AC-03 @case AC-03.5 acceptance-evidence verification observes the rebuilt upstream', () => {
	withConsumerFixture((root) => {
		const h = harness(root);
		const evidenceCommand = ['node', 'packages/consumer/verify.mjs', 'new'];
		const result = h.verify('new', { verificationCommands: [], acceptanceEvidenceCommand: evidenceCommand });
		assert.equal(result.ok, true, result.output);
		assert.equal(result.evidence.exitCode, 0);
		assert.equal(h.calls.indexOf('node packages/consumer/verify.mjs new'), 2);
	});
});

test('@ac AC-03 @case AC-03.2 repeated verification after a source-only repair rebuilds and observes the repair', () => {
	withConsumerFixture((root) => {
		const h = harness(root);
		assert.equal(h.verify('new').ok, true);
		writeFile(root, 'packages/base/src/index.mjs', "export const greet = () => 'repaired';\n");
		assert.equal(h.verify('repaired').ok, true);
		assert.equal(h.calls.filter((call) => call === 'pnpm --filter @fx/base build').length, 2);
	});
});

test('@ac AC-03 @case AC-03.3 a resumed worktree with a matching hydration marker still rebuilds before verification', async () => {
	await withConsumerFixture(async (root) => {
		const installs = [];
		const runner = (cmd, args) => { installs.push([cmd, ...args].join(' ')); return ''; };
		fs.mkdirSync(path.join(root, 'node_modules'));
		const hydration = { worktreeDir: root, allowedPackages: ['packages/consumer'], metadataDir: path.join(root, '.meta'), runner };
		await hydrateWorktree(hydration);
		const resumed = await hydrateWorktree(hydration);
		assert.equal(resumed.status, 'CACHED');
		const installCount = installs.length;
		const h = harness(root);
		assert.equal(h.verify('new').ok, true);
		assert.equal(h.calls.filter((call) => call.startsWith('pnpm --filter')).length, 2);
		assert.equal(installs.length, installCount, 'preparation does not reinstall');
	});
});

test('@ac AC-04 @case AC-04.1 failed preparation blocks consumer commands and yields no passing evidence', () => {
	withConsumerFixture((root) => {
		writeFile(root, 'packages/base/build.mjs', 'process.exit(3);\n');
		const h = harness(root);
		const result = h.verify('new', { acceptanceEvidenceCommand: ['node', 'packages/consumer/verify.mjs', 'new'] });
		assert.deepEqual([result.ok, result.reason, result.terminal, result.evidence], [false, 'preparation-build-failed', false, null]);
		assert.deepEqual(h.calls, ['pnpm --filter @fx/base build']);
		assert.match(result.output, /consumer verification did not run/);
	});
});

test('@ac AC-05 @case AC-05.3 task preparation evidence is persisted as an artifact and a VERIFICATION_PREPARED event', () => {
	withConsumerFixture((root) => {
		const h = harness(root);
		h.verify('new');
		assert.equal(h.artifacts.length, 1);
		assert.equal(h.artifacts[0].kind, 'verification-preparation');
		assert.equal(h.events.length, 1);
		const [event] = h.events;
		assert.equal(event.eventType, 'VERIFICATION_PREPARED');
		assert.equal(event.runtimeRevision, 3);
		assert.equal(event.payload.status, 'passed');
		assert.equal(event.payload.purpose, 'verification');
		assert.equal(event.payload.taskId, 'task-1');
		assert.match(event.payload.evidenceArtifact, /^a{63}1$/);
		assert.equal(event.payload.selectionHash, computePreparationSelectionBinding({ builds: BUILDS }, TASKS).tasks['task-1'].selectionHash);
	});
});

test('verification without a preparation hook keeps the previous command behavior', () => {
	withConsumerFixture((root) => {
		const h = harness(root);
		const result = h.verify('old', { prepareVerification: undefined });
		assert.equal(result.ok, true, 'stale dist is what an unconfigured host observes');
		assert.deepEqual(h.calls, ['node packages/consumer/verify.mjs old']);
	});
});
