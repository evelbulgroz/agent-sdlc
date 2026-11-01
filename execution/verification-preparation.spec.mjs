import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { writeSyntheticHostProfile } from '../testing/cli-test-support.mjs';
import {
	BUILDS, COMPILE, TASKS, consumerSees, packageRunner, withFixture, writeFile,
} from '../testing/verification-preparation-fixture.mjs';
import { computePreparationPolicyHash, computePreparationSelectionBinding } from '../host/verification-preparation.ts';
import {
	isPreparationEvidenceCurrent,
	prepareForVerification,
	runVerificationPreparation,
} from './verification-preparation.ts';

function prepare(root, execCli, extra = {}) {
	return prepareForVerification({
		execCli, worktreeDir: root, runId: 'run-1', taskId: 'task-1', scope: 'task-1', planTasks: TASKS,
		authorizedPolicyHash: computePreparationPolicyHash({ builds: BUILDS }),
		frozenSelectionHash: computePreparationSelectionBinding({ builds: BUILDS }, TASKS).digest,
		candidateRoots: ['packages/consumer'], ...extra,
	});
}

test('@ac AC-03 @case AC-03.1 consumer observes a source-only upstream change after preparation, not the stale artifact', () => {
	withFixture((root) => {
		writeFile(root, 'packages/base/src/index.mjs', "export const greet = () => 'new';\n");
		assert.equal(consumerSees(root, 'new'), false, 'stale dist must be observable without preparation');
		const calls = [];
		const result = prepare(root, packageRunner(root, calls));
		assert.equal(result.ok, true, result.output);
		assert.deepEqual(calls, ['pnpm --filter @fx/base build', 'pnpm --filter @fx/consumer build']);
		assert.equal(consumerSees(root, 'new'), true);
	});
});

test('@ac AC-03 @case AC-03.2 a source-only repair is rebuilt before repeated targeted verification', () => {
	withFixture((root) => {
		const runner = packageRunner(root);
		writeFile(root, 'packages/base/src/index.mjs', "export const greet = () => 'first';\n");
		assert.equal(prepare(root, runner).ok, true);
		assert.equal(consumerSees(root, 'first'), true);
		writeFile(root, 'packages/base/src/index.mjs', "export const greet = () => 'repaired';\n");
		assert.equal(prepare(root, runner).ok, true);
		assert.equal(consumerSees(root, 'repaired'), true);
	});
});

function failingCase(buildScript, expectedReason, { timeoutMs } = {}) {
	withFixture((root) => {
		writeFile(root, 'packages/base/build.mjs', buildScript);
		const recorded = [];
		const calls = [];
		const result = prepare(root, packageRunner(root, calls), { recordEvidence: (e) => recorded.push(e), ...(timeoutMs ? { timeoutMs } : {}) });
		assert.equal(result.ok, false);
		assert.equal(result.reason, expectedReason);
		assert.deepEqual(calls, ['pnpm --filter @fx/base build'], 'no later build or consumer command runs');
		assert.equal(recorded.length, 1);
		assert.equal(recorded[0].status, 'failed');
		assert.equal(recorded[0].failure.stepId, 'build-base');
		assert.deepEqual(recorded[0].steps[0].argv, ['pnpm', '--filter', '@fx/base', 'build']);
	});
}

test('@ac AC-04 @case AC-04.1 a nonzero build exit stops before consumer commands', () => {
	failingCase("console.error('tsc: error TS2322'); process.exit(2);\n", 'build-failed');
});

test('@ac AC-04 @case AC-04.2 a build timeout is a preparation failure', () => {
	failingCase('setTimeout(() => {}, 10_000);\n', 'timeout', { timeoutMs: 300 });
});

test('@ac AC-04 @case AC-04.3 an interrupted build has no success evidence', () => {
	failingCase("process.kill(process.pid, 'SIGKILL');\n", 'interrupted');
});

test('@ac AC-04 @case AC-04.4 a successful exit with a missing declared output fails', () => {
	withFixture((root) => {
		fs.rmSync(path.join(root, 'packages/base/dist'), { recursive: true });
		writeFile(root, 'packages/base/build.mjs', '// exits 0 without output\n');
		const result = prepare(root, packageRunner(root));
		assert.equal(result.reason, 'missing-output');
		assert.deepEqual(result.evidence.failure.paths, ['dist']);
		assert.equal(result.evidence.steps[0].exitCode, 0);
		assert.equal(result.evidence.steps[0].outputsVerified, false);
	});
});

test('@ac AC-04 @case AC-04.5 an undeclared source modification by a build fails', () => {
	for (const target of ['src/extra.mjs', '../consumer/src/index.mjs']) {
		withFixture((root) => {
			writeFile(root, 'packages/base/build.mjs', `${COMPILE}fs.writeFileSync(${JSON.stringify(target)}, 'x');\n`);
			const result = prepare(root, packageRunner(root));
			assert.equal(result.reason, 'source-modified', target);
			assert.equal(result.evidence.failure.paths.length, 1);
		});
	}
});

test('@ac AC-04 @case AC-04.6 a candidate mutation invalidates earlier preparation evidence', () => {
	withFixture((root) => {
		const result = prepare(root, packageRunner(root));
		const steps = computePreparationSelectionBinding({ builds: BUILDS }, TASKS).tasks['task-1'].steps;
		assert.equal(isPreparationEvidenceCurrent(result.evidence, steps, ['packages/consumer']), true);
		writeFile(root, 'packages/base/dist/index.mjs', 'export const greet = () => "regenerated";\n');
		assert.equal(isPreparationEvidenceCurrent(result.evidence, steps, ['packages/consumer']), true, 'output writes do not invalidate');
		writeFile(root, 'packages/consumer/src/index.mjs', '// edited after preparation\n');
		assert.equal(isPreparationEvidenceCurrent(result.evidence, steps, ['packages/consumer']), false);
		assert.equal(isPreparationEvidenceCurrent(null, steps), false);
	});
});

test('@ac AC-05 @case AC-05.2 every invocation rebuilds; existing dist and prior success evidence never skip builds', () => {
	withFixture((root) => {
		const calls = [];
		const first = prepare(root, packageRunner(root, calls));
		const second = prepare(root, packageRunner(root, calls));
		assert.equal(calls.length, 4);
		assert.equal(first.evidence.status, 'passed');
		assert.equal(second.evidence.candidateDigest, first.evidence.candidateDigest);
	});
});

test('@ac AC-05 @case AC-05.3 evidence identifies policy, selection and candidate binding', () => {
	withFixture((root) => {
		const { evidence } = prepare(root, packageRunner(root));
		const binding = computePreparationSelectionBinding({ builds: BUILDS }, TASKS);
		assert.equal(evidence.preparationPolicyHash, computePreparationPolicyHash({ builds: BUILDS }));
		assert.equal(evidence.selectionHash, binding.tasks['task-1'].selectionHash);
		assert.match(evidence.candidateDigest, /^[0-9a-f]{64}$/);
		assert.deepEqual([evidence.runId, evidence.taskId, evidence.worktreeDir], ['run-1', 'task-1', root]);
		assert.deepEqual(evidence.steps.map((s) => s.id), ['build-base', 'build-consumer']);
		assert.equal(JSON.stringify(evidence).includes('PATH='), false, 'no environment data in evidence');
	});
});

test('@ac AC-05 @case AC-05.4 a host without preparation runs no new commands', () => {
	withFixture((root) => {
		const calls = [];
		const result = prepare(root, packageRunner(root, calls), { authorizedPolicyHash: undefined, frozenSelectionHash: undefined });
		assert.deepEqual([result.ok, result.evidence, calls.length], [true, null, 0]);
		assert.deepEqual(runVerificationPreparation({ execCli: () => assert.fail('no exec'), worktreeDir: root, runId: 'r', taskId: 't', steps: [], preparationPolicyHash: null, selectionHash: null }).evidence, null);
	}, { builds: null });
});

test('@ac AC-05 @case AC-05.5 an effective worktree policy differing from the approved one stops before any command', () => {
	withFixture((root) => {
		const calls = [];
		writeSyntheticHostProfile(root, { verificationPreparation: { builds: [{ ...BUILDS[0], outputPathPrefixes: ['lib'] }, BUILDS[1]] } });
		assert.throws(() => prepare(root, packageRunner(root, calls)), (error) => error.code === 'AUTHORIZATION_INVALID');
		assert.throws(() => prepare(root, packageRunner(root, calls), { frozenSelectionHash: 'f'.repeat(64) }), (error) => error.code === 'AUTHORIZATION_INVALID');
		assert.equal(calls.length, 0);
	});
});
