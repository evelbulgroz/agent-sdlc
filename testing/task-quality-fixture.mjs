import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { ArtifactStore } from '../persistence/artifacts.ts';
import { RuntimeStore } from '../persistence/runtime-store.ts';
import { liveRunRoot } from '../persistence/run-paths.ts';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';
import { attachApprovedQualityPlan } from '../policy/quality-planning.ts';
import { hashTaskPlanProjection } from '../policy/contracts/dag-schema.ts';
import { sha256 } from '../policy/contracts.ts';
import { RoleRegistry } from '../roles/role-registry.ts';
import { createTaskQualitySession } from '../workflow/task-quality-session.ts';
import { initialize, policy, H, TIME } from './quality-test-support.mjs';
import { FakeModelGovernor } from './fake-model-governor.mjs';
import { createMockExecCli } from './test-support.mjs';

export function taskQualityFixture(t, { withConsumer = false, overlappingConsumer = false } = {}) {
	const fixtureParent = path.resolve('tools/.agent-sdlc/test-fixtures');
	fs.mkdirSync(fixtureParent, { recursive: true });
	const rootDir = fs.mkdtempSync(path.join(fixtureParent, 'sdlc-task-quality-'));
	const git = args => execFileSync('git', args, { cwd: rootDir, encoding: 'utf8' }).trim();
	git(['init', '--quiet']);
	git(['config', 'user.name', 'Fixture']);
	git(['config', 'user.email', 'fixture@example.invalid']);
	fs.mkdirSync(path.join(rootDir, '.agents'));
	fs.writeFileSync(path.join(rootDir, '.agents/sdlc-host.json'), JSON.stringify({
		schemaVersion: '1.4.0', profileId: 'quality-fixture', repositoryId: 'fixture/repo', adapter: 'default',
	}));
	const runId = `2026-11-01-quality-proof-${crypto.randomUUID().slice(0, 8)}`;
	const runtimeDir = path.join(liveRunRoot(rootDir), runId);
	fs.writeFileSync(path.join(rootDir, '.gitignore'),
		`${path.relative(rootDir, liveRunRoot(rootDir))}/\nnode_modules/\ntools/.agent-preflight-last.json\n`);
	fs.mkdirSync(path.join(rootDir, 'src'));
	fs.writeFileSync(path.join(rootDir, 'src/a.ts'), 'export const value = 1;\n');
	fs.writeFileSync(path.join(rootDir, 'src/adapter.mjs'), 'fixture protocol adapter\n');
	git(['add', '.']);
	git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
	const base = git(['rev-parse', 'HEAD']), tree = git(['rev-parse', 'HEAD^{tree}']);
	const worktreeDir = path.join(runtimeDir, 'worktrees', 'enable-task');
	git(['worktree', 'add', '--quiet', '--detach', worktreeDir, base]);
	const store = new RuntimeStore(path.join(runtimeDir, 'runtime.sqlite'));
	t.after(() => { store.close(); fs.rmSync(rootDir, { recursive: true, force: true }); });
	const artifacts = new ArtifactStore({ artifactsDir: path.join(runtimeDir, 'artifacts'), runtimeStore: store });
	const frozenPolicy = { ...policy, execution: { maxInvocations: 100, maxTotalDurationMs: 100000 },
		review: { ...policy.review, maxLogicalDispatches: 16, maxInputTokens: 100_000 } };
	initialize({ store, runId }, frozenPolicy);
	const adapter = { adapterId: 'fixture-unit', protocolVersion: '1.0.0',
		bundleFiles: [{ path: 'src/adapter.mjs',
			sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(rootDir, 'src/adapter.mjs'))).digest('hex') }],
		dependencyFiles: [], configurationFiles: [], argv: [fs.realpathSync(process.execPath)],
		executableSha256: crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),
		profiles: [{ profileId: 'unit', layers: ['unit'], capabilities: [] }], qualificationArtifactHash: H,
		limits: { timeoutMs: 1000, maxReportBytes: 10000, maxArtifactBytes: 1000, maxArtifacts: 1 } };
	const obligation = (id, taskId, stem, criterionId) => ({
		obligationId: id, criterionId, caseId: `${criterionId}.1`, owner: { kind: 'task', id: taskId },
		observableOutcome: `${stem} is visible`, setupAction: `Read ${stem}`, expectedResult: `${stem} equals expected`,
		layer: 'unit', requiredCapabilities: [], implementationPaths: [`src/${stem}.ts`],
		testCases: [{ file: `src/${stem}.spec.mjs`, caseKey: id }], adapterBindingHash: sha256(adapter), profileId: 'unit',
	});
	const qualityPlan = { qualityPolicy: frozenPolicy, adapterBindings: [adapter],
		evidenceObligations: [obligation('visible', 'vertical-task', 'a', 'AC-01'),
			...(withConsumer ? [obligation('consumer', 'consumer-task', 'b', 'AC-02')] : [])] };
	const task = (taskId, sliceId, dependsOn, index, criteria, authoredPaths) => ({
		taskId, sliceId, dependsOn, title: taskId, targetPackage: 'src', pathPrefixes: ['src'],
		status: 'pending', integrationOrder: index, worktreeSubdir: `worktrees/${taskId}`, baseCommitSha: base,
		parentTreeSha: null, targetTreeSha: null, parentCommitSha: null, patchHash: null,
		failurePacketArtifact: null, repairCount: 0, authoredPaths, generatedOutputs: [], acceptanceCriteria: criteria,
		verificationCommand: ['pnpm', '--filter', 'src', 'run', 'test'],
	});
	const criteria = ['AC-01: Value is visible. Given a value. Then it is visible. Cases: AC-01.1: Read value.',
		...(withConsumer ? ['AC-02: Consumer is visible. Given a consumer. Then it is visible. Cases: AC-02.1: Read consumer.'] : [])];
	const plan = attachApprovedQualityPlan({
		schemaVersion: '1.0.0', runId, planPolicyHash: H, baseCommitSha: base,
		slices: [
			{ sliceId: 'enable', kind: 'enabling', goal: 'Prepare value', acceptanceCriteria: [], dependsOn: [] },
			{ sliceId: 'vertical', kind: 'vertical', goal: 'Expose value', acceptanceCriteria: ['AC-01'], dependsOn: ['enable'] },
			...(withConsumer ? [{ sliceId: 'consumer', kind: 'activation', goal: 'Consume value',
				acceptanceCriteria: ['AC-02'], dependsOn: ['vertical'] }] : []),
		],
		tasks: [task('enable-task', 'enable', [], 0, [], ['src/a.ts']),
			task('vertical-task', 'vertical', ['enable-task'], 1, ['AC-01'], ['src/a.ts', 'src/a.spec.mjs']),
			...(withConsumer ? [task('consumer-task', 'consumer', ['vertical-task'], 2, ['AC-02'],
				['src/b.ts', 'src/b.spec.mjs', 'src/b.bin', ...(overlappingConsumer ? ['src/a.ts'] : [])])] : [])],
		integrationOrder: ['enable-task', 'vertical-task', ...(withConsumer ? ['consumer-task'] : [])],
		isParallel: false, createdAt: TIME,
	}, qualityPlan, criteria);
	const auth = createDefaultAuthorizationEnvelope({ runId, approvedSpecHash: H, repositoryId: 'fixture/repo',
			baseCommitSha: base, allowedPackages: ['src'], allowedPathPrefixes: ['src'], rootDir, qualityPlan, now: new Date(TIME) });
	store.saveTaskPlan(plan, auth.approvedPlanPolicyHash);
	const snapshot = { ...store.getRun(runId), approvedSpecHash: H,
			approvedPlanPolicyHash: auth.approvedPlanPolicyHash, taskPlanHash: hashTaskPlanProjection(plan),
			taskPlanFrozen: true, draftArtifact: artifacts.writeJson('fixture-spec', { goal: 'Visible values', acceptanceCriteria: criteria }) };
	store.getAuthorization = () => auth;
	let commands = 0;
	const verify = createMockExecCli({ baseCommitSha: base, gitCli: execFileSync, requireAcceptanceCitation: false });
	const runtime = { rootDir, runtimeStore: store, artifactStore: artifacts, registry: new RoleRegistry({ rootDir }),
		governor: new FakeModelGovernor(), now: () => new Date(TIME), onBoundary: async () => {},
		gitCli: execFileSync, execCli: (...args) => { commands++; return verify(...args); },
		evidenceSpawn: passingEvidenceSpawn, transition: (current, options) => ({
			...current, ...options.updates, state: options.to, runtimeRevision: current.runtimeRevision + 1,
		}) };
	const candidate = { ...plan.tasks[0], parentTreeSha: tree, targetTreeSha: tree,
		patchHash: crypto.createHash('sha256').update('').digest('hex') };
	return { rootDir, runId, store, artifacts, plan, snapshot, runtime, auth, base, tree, worktreeDir, candidate,
		session: createTaskQualitySession(runtime, snapshot, plan), commandCount: () => commands };
}

function passingEvidenceSpawn() {
	const child = new EventEmitter();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = signal => { queueMicrotask(() => child.emit('close', null, signal)); return true; };
	let input = '';
	child.stdin = new Writable({
		write(chunk, _, callback) { input += chunk.toString(); callback(); },
		final(callback) {
			const request = JSON.parse(input);
			callback();
			queueMicrotask(() => {
				child.stdout.write(JSON.stringify({
					schemaVersion: '1.0.0', operationId: request.operationId, requestHash: sha256(request),
					adapterBindingHash: request.adapterBindingHash, profileId: request.profileId,
					cases: request.obligations.flatMap(obligation => obligation.testCases.map(testCase => ({
						...testCase, obligationIds: [obligation.obligationId], exercisedCapabilities: [],
						outcome: 'passed', attempts: [{ index: 0, outcome: 'passed', durationMs: 1, artifactPaths: [] }],
					}))), artifacts: [],
				}));
				child.emit('close', 0, null);
			});
		},
	});
	return child;
}
