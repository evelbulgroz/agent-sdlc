import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { policy as basePolicy } from '../testing/quality-test-support.mjs';
import { TaskPlanV2Schema, hashTaskPlanProjection, sha256 } from '../policy/contracts.ts';
import { adapterBindingHash } from '../policy/contracts/quality-schema.ts';
import { REPOSITORY_ROOT } from './run-paths.ts';
import { buildUnlandedPatch } from './run-archive-patch.ts';
import { commandRegistrationFixture } from '../testing/command-registration-fixture.mjs';

function git(cwd, args, input) {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		input,
		stdio: ['pipe', 'pipe', 'pipe'],
	}).trim();
}

function task(taskId, sliceId, integrationOrder, dependsOn = []) {
	return {
		taskId,
		sliceId,
		title: taskId,
		targetPackage: 'src',
		pathPrefixes: ['src'],
		authoredPaths: ['src/a.txt', 'src/b.txt'],
		generatedOutputs: [],
		dependsOn,
		integrationOrder,
		acceptanceCriteria: [`AC-0${integrationOrder + 1}`],
		verificationCommand: ['pnpm', 'run', 'test'],
		generatorCommand: null,
		deliveryLayers: ['application'],
		dependencyMutations: [],
		shadowPaths: { unhappy: 'error', timeout: 'timeout', empty: 'empty', boundary: 'edge' },
	};
}

test('quality archive reconstructs one patch from current selected task deltas, not checkpoint or task worktrees', () => {
	const fixtureParent = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures');
	fs.mkdirSync(fixtureParent, { recursive: true });
	const rootDir = fs.mkdtempSync(path.join(fixtureParent, 'archive-quality-'));
	const runId = `2026-11-02-quality-archive-${crypto.randomUUID().slice(0, 8)}`;
	const runDir = path.join(rootDir, 'run');
	fs.mkdirSync(path.join(runDir, 'worktrees', 'integration'), { recursive: true });
	let database;
	try {
		git(rootDir, ['init', '-b', 'main']);
		git(rootDir, ['config', 'user.name', 'Archive fixture']);
		git(rootDir, ['config', 'user.email', 'archive@example.invalid']);
		fs.writeFileSync(path.join(rootDir, '.gitignore'), 'run/\n');
		fs.mkdirSync(path.join(rootDir, 'src'));
		fs.writeFileSync(path.join(rootDir, 'src/a.txt'), Buffer.from([0x61, 0xe9, 0x0a]));
		fs.writeFileSync(path.join(rootDir, 'src/b.txt'), Buffer.from([0, 0xff, 0x0a]));
		git(rootDir, ['add', '.']);
		git(rootDir, ['commit', '--quiet', '-m', 'base']);
		const baseCommitSha = git(rootDir, ['rev-parse', 'HEAD']);
		const baseTreeSha = git(rootDir, ['rev-parse', 'HEAD^{tree}']);
		git(rootDir, ['checkout', '-b', 'selected-quality-revisions']);
		fs.writeFileSync(path.join(rootDir, 'src/a.txt'), Buffer.from([0x61, 0xe8, 0x0a]));
		git(rootDir, ['add', '.']);
		git(rootDir, ['commit', '--quiet', '-m', 'selected task one']);
		const firstTreeSha = git(rootDir, ['rev-parse', 'HEAD^{tree}']);
		fs.writeFileSync(path.join(rootDir, 'src/b.txt'), Buffer.from([0, 0xfe, 0x0a]));
		git(rootDir, ['add', '.']);
		git(rootDir, ['commit', '--quiet', '-m', 'selected task two']);
		const finalTreeSha = git(rootDir, ['rev-parse', 'HEAD^{tree}']);
		git(rootDir, ['checkout', 'main']);

		const adapter = commandRegistrationFixture({ adapterId: 'archive-unit', limits: { timeoutMs: 1_000, maxReportBytes: 10_000, maxArtifactBytes: 1_000, maxArtifacts: 1 } });
		const obligations = [1, 2].map(index => ({
			obligationId: `obligation-${index}`,
			criterionId: `AC-0${index}`,
			caseId: null,
			owner: { kind: 'slice', id: `slice-${index}` },
			observableOutcome: `Task ${index} is visible.`,
			setupAction: `Read task ${index}.`,
			expectedResult: `Task ${index} is displayed.`,
			layer: 'unit',
			requiredCapabilities: [],
			implementationPaths: ['src'],
			testCases: [{ file: `src/task-${index}.spec.mjs`, caseKey: `task-${index}` }],
			adapterBindingHash: adapterBindingHash(adapter),
			profileId: 'unit',
		}));
		const qualityPolicy = {
			...basePolicy,
			review: { ...basePolicy.review, maxLogicalDispatches: 12 },
		};
		const plan = TaskPlanV2Schema.parse({
			schemaVersion: '2.0.0',
			runId,
			planPolicyHash: 'a'.repeat(64),
			baseCommitSha,
			slices: [1, 2].map(index => ({
				sliceId: `slice-${index}`,
				kind: 'vertical',
				goal: `Deliver task ${index}.`,
				acceptanceCriteria: [`AC-0${index}`],
				dependsOn: index === 1 ? [] : ['slice-1'],
			})),
			tasks: [task('task-one', 'slice-1', 0), task('task-two', 'slice-2', 1, ['task-one'])],
			integrationOrder: ['task-one', 'task-two'],
			isParallel: false,
			createdAt: '2026-11-02T09:00:00.000Z',
			qualityPolicy,
			qualityPolicyHash: sha256(qualityPolicy),
			adapterBindings: [adapter],
			evidenceObligations: obligations,
		});
		const planHash = hashTaskPlanProjection(plan);
		const patchHash = (parent, target) => crypto.createHash('sha256')
			.update(execFileSync('git', ['diff-tree', '-p', '--binary', parent, target], {
				cwd: rootDir,
			}))
			.digest('hex');
		const revisions = [
			{
				schemaVersion: '1.0.0', runId, taskPlanHash: planHash, taskId: 'task-one',
				executionRevision: 0, correctionId: null, parentTreeSha: baseTreeSha,
				targetTreeSha: firstTreeSha, patchHash: patchHash(baseTreeSha, firstTreeSha),
				parentRevisionSetHash: sha256([]), status: 'completed', receiptHashes: ['1'.repeat(64)],
			},
			{
				schemaVersion: '1.0.0', runId, taskPlanHash: planHash, taskId: 'task-two',
				executionRevision: 1, correctionId: null, parentTreeSha: firstTreeSha,
				targetTreeSha: finalTreeSha, patchHash: patchHash(firstTreeSha, finalTreeSha),
				parentRevisionSetHash: null, status: 'completed', receiptHashes: ['3'.repeat(64)],
			},
		];
		revisions[1].parentRevisionSetHash = sha256([{
			taskId: 'task-one', executionRevision: 0, patchHash: revisions[0].patchHash,
		}]);
		const databasePath = path.join(runDir, 'runtime.sqlite');
		database = new DatabaseSync(databasePath);
		database.exec(`CREATE TABLE quality_records (
			run_id TEXT,kind TEXT,record_id TEXT,record_json TEXT,status TEXT);
			CREATE TABLE quality_current_revisions (
				run_id TEXT,task_id TEXT,execution_revision INTEGER,eligible INTEGER);`);
		const saveRecord = database.prepare(
			'INSERT INTO quality_records (run_id,kind,record_id,record_json,status) VALUES (?,?,?,?,?)',
		);
		saveRecord.run(runId, 'task-plan', runId, JSON.stringify(plan), null);
		saveRecord.run(runId, 'worktree', 'final-candidate', JSON.stringify({
			runId, registryId: 'final-candidate', kind: 'final', ownerId: null,
			relativePath: 'worktrees/integration', bindingHash: '4'.repeat(64), sourceHash: '5'.repeat(64),
		}), null);
		for (const revision of revisions) {
			saveRecord.run(runId, 'revision', `${revision.taskId}:${revision.executionRevision}`, JSON.stringify(revision), null);
			database.prepare('INSERT INTO quality_current_revisions VALUES (?,?,?,1)')
				.run(runId, revision.taskId, revision.executionRevision);
		}
		database.close();
		database = null;

		fs.writeFileSync(path.join(runDir, 'worktrees', 'integration', 'stale.txt'), 'stale final worktree\n');
		const runRecord = {
			runId,
			runDir,
			baseCommitSha,
			dagTasks: [
				{ task_id: 'task-one', base_commit_sha: baseCommitSha, target_tree_sha: firstTreeSha },
				{ task_id: 'task-two', base_commit_sha: firstTreeSha, target_tree_sha: finalTreeSha },
			],
		};
		const patch = buildUnlandedPatch(runRecord, { rootDir, targetTreeSha: finalTreeSha, gitCli: execFileSync });
		assert.ok(Buffer.isBuffer(patch));
		assert.match(patch.toString(), /GIT binary patch/);
		assert.deepEqual(buildUnlandedPatch(runRecord, { rootDir, targetTreeSha: null, gitCli: execFileSync }), patch);
		assert.throws(() => buildUnlandedPatch(runRecord, {
			rootDir, targetTreeSha: baseTreeSha, gitCli: execFileSync,
		}), /do not reconstruct recorded final tree/);
		assert.throws(() => buildUnlandedPatch({ ...runRecord, targetTreeSha: baseTreeSha }, {
			rootDir, targetTreeSha: null, gitCli: execFileSync,
		}), /do not reconstruct recorded final tree/);
		git(rootDir, ['apply', '--check', '-'], patch);
		git(rootDir, ['apply', '-'], patch);
		git(rootDir, ['add', '-A']);
		assert.equal(git(rootDir, ['write-tree']), finalTreeSha);
		database = new DatabaseSync(databasePath);
		const finalClosure = {
			schemaVersion: '1.0.0', binding: {
				runId, approvedSpecHash: 'a'.repeat(64), taskPlanHash: planHash,
				qualityPolicyHash: plan.qualityPolicyHash, checkpointId: 'final-authoritative',
				checkpointKind: 'final', ownerId: null, candidateRevision: 1,
				baseCommitSha, treeSha: baseTreeSha, revisionSetHash: 'b'.repeat(64), preparationHash: 'c'.repeat(64),
			}, selectedRevisions: revisions.map(({ taskId, executionRevision, patchHash }) =>
				({ taskId, executionRevision, patchHash })),
			registryId: 'final-candidate', status: 'accepted', receiptHashes: ['d'.repeat(64)], reviewOperationIds: [],
		};
		database.prepare('INSERT INTO quality_records VALUES (?,?,?,?,?)')
			.run(runId, 'closure', 'final-authoritative:1', JSON.stringify(finalClosure), 'accepted');
		assert.throws(() => buildUnlandedPatch(runRecord, {
			rootDir, targetTreeSha: null, gitCli: execFileSync,
		}), /do not reconstruct recorded final tree/);
		finalClosure.binding.treeSha = finalTreeSha;
		database.prepare("UPDATE quality_records SET record_json=? WHERE kind='closure'")
			.run(JSON.stringify(finalClosure));
		assert.deepEqual(buildUnlandedPatch(runRecord, { rootDir, targetTreeSha: null, gitCli: execFileSync }), patch);
		database.prepare("UPDATE quality_records SET record_json=? WHERE kind='revision' AND record_id=?")
			.run(JSON.stringify({ ...revisions[1], parentRevisionSetHash: 'f'.repeat(64) }), 'task-two:1');
		assert.throws(() => buildUnlandedPatch(runRecord, {
			rootDir, targetTreeSha: null, gitCli: execFileSync,
		}), /stale parent provenance/);
	} finally {
		database?.close();
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});
