import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ArtifactStore } from '../persistence/artifacts.ts';
import { RuntimeStore } from '../persistence/runtime-store.ts';
import { liveRunRoot } from '../persistence/run-paths.ts';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';
import { attachApprovedQualityPlan } from '../policy/quality-planning.ts';
import { hashTaskPlanProjection } from '../policy/contracts/dag-schema.ts';
import { sha256 } from '../policy/contracts.ts';
import { RoleExecutor } from '../roles/role-executor.ts';
import { RoleRegistry } from '../roles/role-registry.ts';
import { createTaskQualitySession } from '../workflow/task-quality-session.ts';
import { initialize, policy, H, TIME } from './quality-test-support.ts';
import { FakeModelGovernor } from './fake-model-governor.ts';
import { createMockExecCli } from './test-support-cli.ts';
import type { TestContext } from 'node:test';
import type { DagTask } from '../policy/contracts/dag-schema.ts';
import type { RuntimeState } from '../policy/contracts.ts';
import type { GitCliFn } from '../workflow/git-manager.ts';
import type { WorkflowTransitionOptions } from '../workflow/node-helpers.ts';
import type { CommandRegistration, EvidenceRequest } from '../policy/contracts/quality-evidence-schema.ts';
import { CommandRegistrationSchema } from '../policy/contracts/quality-evidence-schema.ts';
import { commandBindingHash } from '../host/command-evidence.ts';

export function taskQualityFixture(
	t: TestContext, { withConsumer = false, overlappingConsumer = false }: { withConsumer?: boolean; overlappingConsumer?: boolean } = {},
) {
	const fixtureParent = path.resolve('tools/.agent-sdlc/test-fixtures');
	fs.mkdirSync(fixtureParent, { recursive: true });
	const rootDir = fs.mkdtempSync(path.join(fixtureParent, 'sdlc-task-quality-'));
	const git = (args: string[]): string => execFileSync('git', args, { cwd: rootDir, encoding: 'utf8' }).trim();
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
	initialize({ store, runId, runtimeDir, artifacts, close() {} }, frozenPolicy);
	const executable = { path: fs.realpathSync(process.execPath),
		sha256: crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex') };
	const adapterArgv = [executable.path, 'run.mjs'];
	const adapter = CommandRegistrationSchema.parse({ kind: 'command', adapterId: 'fixture-unit', protocolVersion: '1.0.0',
		argv: adapterArgv, cwd: 'src', reportFormat: 'junit', retries: 0, executable, pins: [],
		commandSha256: commandBindingHash(adapterArgv, executable.sha256, [], []),
		profiles: [{ profileId: 'unit', layers: ['unit'], capabilities: [] }],
		limits: { timeoutMs: 1000, maxReportBytes: 10000, maxArtifactBytes: 1000, maxArtifacts: 1 } });
	const obligation = (id: string, taskId: string, stem: string, criterionId: string) => ({
		obligationId: id, criterionId, caseId: `${criterionId}.1`, owner: { kind: 'task' as const, id: taskId },
		observableOutcome: `${stem} is visible`, setupAction: `Read ${stem}`, expectedResult: `${stem} equals expected`,
		layer: 'unit' as const, requiredCapabilities: [], implementationPaths: [`src/${stem}.ts`],
		testCases: [{ file: `src/${stem}.spec.mjs`, caseKey: id }], adapterBindingHash: sha256(adapter), profileId: 'unit',
	});
	const qualityPlan = { qualityPolicy: frozenPolicy, adapterBindings: [adapter],
		evidenceObligations: [obligation('visible', 'vertical-task', 'a', 'AC-01'),
			...(withConsumer ? [obligation('consumer', 'consumer-task', 'b', 'AC-02')] : [])] };
	const task = (
		taskId: string, sliceId: string, dependsOn: string[], index: number, criteria: string[], authoredPaths: string[],
	): DagTask => ({
		taskId, sliceId, dependsOn, title: taskId, targetPackage: 'src', pathPrefixes: ['src'],
		status: 'pending' as const, integrationOrder: index, worktreeSubdir: `worktrees/${taskId}`, baseCommitSha: base,
		parentTreeSha: null, targetTreeSha: null, parentCommitSha: null, patchHash: null,
		failurePacketArtifact: null, repairCount: 0, authoredPaths, generatedOutputs: [], acceptanceCriteria: criteria,
		verificationCommand: ['pnpm', '--filter', 'src', 'run', 'test'],
	});
	const criteria = ['AC-01: Value is visible. Given a value. Then it is visible. Cases: AC-01.1: Read value.',
		...(withConsumer ? ['AC-02: Consumer is visible. Given a consumer. Then it is visible. Cases: AC-02.1: Read consumer.'] : [])];
	const plan = attachApprovedQualityPlan({
		schemaVersion: '1.0.0', runId, planPolicyHash: H, baseCommitSha: base,
		slices: [
			{ sliceId: 'enable', kind: 'enabling' as const, goal: 'Prepare value', acceptanceCriteria: [], dependsOn: [] },
			{ sliceId: 'vertical', kind: 'vertical' as const, goal: 'Expose value', acceptanceCriteria: ['AC-01'], dependsOn: ['enable'] },
			...(withConsumer ? [{ sliceId: 'consumer', kind: 'activation' as const, goal: 'Consume value',
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
	const governor = new FakeModelGovernor();
	const runtime = { rootDir, runtimeStore: store, artifactStore: artifacts, registry: new RoleRegistry({ rootDir }),
		governor, roleExecutor: new RoleExecutor({ governor, runtimeStore: store, artifactStore: artifacts }), now: () => new Date(TIME), onBoundary: async () => {},
		gitCli: execFileSync, execCli: (...args: Parameters<GitCliFn>) => { commands++; return verify(...args); },
		evidenceSpawn: passingEvidenceSpawn(), ghCli: execFileSync, checkpointer: null,
		currentOrAlreadyAdvanced: () => null, transition: (current: Readonly<RuntimeState>, options: WorkflowTransitionOptions) => ({
			...current, ...options.updates, state: options.to, runtimeRevision: current.runtimeRevision + 1,
		}) };
	const candidate = { ...plan.tasks[0], parentTreeSha: tree, targetTreeSha: tree,
		patchHash: crypto.createHash('sha256').update('').digest('hex') };
	return { rootDir, runId, store, artifacts, plan, snapshot, runtime, auth, base, tree, worktreeDir, candidate,
		session: createTaskQualitySession(runtime, snapshot, plan), commandCount: () => commands };
}

function passingEvidenceSpawn() {
	return Object.assign(() => { throw new Error('command evidence must not spawn an adapter'); }, {
		runCommand: async (_registration: CommandRegistration, request: EvidenceRequest) => ({
			exitCode: 0, reportBytes: Buffer.from('<testsuites/>'),
			cases: [...new Set(request.obligations.map((item) => item.caseId))]
				.filter((identity): identity is string => identity !== null)
				.map(identity => ({ identity, outcome: 'passed' as const, message: '', attempts: 1 })),
		}),
	});
}
