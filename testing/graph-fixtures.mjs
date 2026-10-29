// Shared graph-slice fixtures. profile selects the slice 2, 3, or 4 git and exec mocks.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StatusProjection } from '../cli/status-projection.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { RoleRegistry } from '../roles/role-registry.ts';
import {
	answersForPending,
	citingSpecSource,
	citingSpecWriteAction,
	completeProposal,
	createMockExecCli,
	createMockGitCli,
	leanWriteAction,
	makeFixture,
	seedCitingSpecs,
	seedWorkspacePackageManifest,
	uncitedPackageTestError,
} from './test-support.mjs';
import { SdlcWorkflowRuntime } from '../workflow/graph.ts';

export function billingProposal() {
	return completeProposal({
		owningContext: 'Billing',
		touchedSurfaces: ['services/billing'],
	});
}

function makeSlice2Fixture(label, script = [], { gitCli, execCli } = {}) {
	const fixture = makeFixture(label, script);
	const baseCommitSha = 'a'.repeat(40);
	const targetTreeSha = 'b'.repeat(40);
	// Distinct from targetTreeSha so task-executor's no-op-completion guard (comparing the
	// parent tree derived from baseCommitSha against the post-implementation write-tree
	// result) does not treat every scripted change as a no-op.
	const parentTreeSha = '0'.repeat(40);

	const defaultGitCli = (cmd, args = [], opts = {}) => {
		if (cmd === 'git') {
			const sub = args[0];
			if (sub === 'rev-parse') {
				if (args[1] === 'HEAD') {
					return `${baseCommitSha}\n`;
				}
				if (typeof args[1] === 'string' && args[1] === `${baseCommitSha}^{tree}`) {
					return `${parentTreeSha}\n`;
				}
				if (typeof args[1] === 'string' && args[1].includes('^{tree}')) {
					return `${targetTreeSha}\n`;
				}
				return `${baseCommitSha}\n`;
			}
			if (sub === 'worktree') {
				if (args[1] === 'add') {
					const targetDir = args[3] || args[2];
					fs.mkdirSync(targetDir, { recursive: true });
					seedWorkspacePackageManifest(targetDir);
					return '';
				}
				if (args[1] === 'remove') {
					return '';
				}
			}
			if (sub === 'status') {
				return '';
			}
			if (sub === 'write-tree') {
				return `${targetTreeSha}\n`;
			}
			if (sub === 'ls-tree') {
				return [
					'100644 blob cccc\tservices/billing/src/file.ts',
					'100644 blob dddd\tpackages/shared-base/src/feature.ts',
				].join('\n');
			}
			if (sub === 'diff-tree') {
				return '';
			}
			if (sub === 'diff' && args.includes('--name-only')) {
				const names = [];
				const cwd = opts.cwd;
				if (cwd && fs.existsSync(cwd)) {
					const stack = [cwd];
					while (stack.length > 0) {
						const current = stack.pop();
						let entries = [];
						try {
							entries = fs.readdirSync(current, { withFileTypes: true });
						} catch {
							continue;
						}
						for (const entry of entries) {
							if (entry.name === 'node_modules' || entry.name === '.git') continue;
							const full = path.join(current, entry.name);
							if (entry.isDirectory()) stack.push(full);
							else if (/\.(spec|test|e2e-spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
								names.push(path.relative(cwd, full).split(path.sep).join('/'));
							}
						}
					}
				}
				return names.length > 0 ? `${names.join('\n')}\n` : '';
			}
			if (sub === 'diff') {
				return '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n+implemented\n';
			}
		}
		return '';
	};

	const defaultExecCli = (cmd, args = [], opts = {}) => {
		if (cmd === 'pnpm') {
			if (args.includes('agent:verify')) {
				const preflightDir = path.join(opts.cwd || REPOSITORY_ROOT, 'tools');
				fs.mkdirSync(preflightDir, { recursive: true });
				fs.writeFileSync(
					path.join(preflightDir, '.agent-preflight-last.json'),
					JSON.stringify({
						status: 'OK',
						canonical: true,
						base: baseCommitSha,
						gitHeadSha: baseCommitSha,
						changeClass: 'A',
						exitCode: 0,
					}),
				);
				return `agent-preflight: RESULT status=OK class=A sha=${baseCommitSha} exitCode=0 canonical=true\n`;
			}
			const uncited = uncitedPackageTestError(cmd, args, opts);
			if (uncited) throw uncited;
			return 'OK\n';
		}
		return '';
	};

	const effectiveGitCli = gitCli || defaultGitCli;
	const effectiveExecCli = execCli || defaultExecCli;

	const runtime = new SdlcWorkflowRuntime({
		runtimeStore: fixture.store,
		artifactStore: fixture.artifacts,
		registry: fixture.registry,
		governor: fixture.governor,
		gitCli: effectiveGitCli,
		execCli: effectiveExecCli,
	});

	return {
		...fixture,
		runtime,
		baseCommitSha,
		targetTreeSha,
		gitCli: effectiveGitCli,
		execCli: effectiveExecCli,
	};
}

function makeSlice3Fixture(label, script = [], { workflowPath, gitCli, execCli } = {}) {
	const fixture = makeFixture(label, script);
	const baseCommitSha = 'a'.repeat(40);
	const targetTreeSha = 'b'.repeat(40);
	const commitSha = 'c'.repeat(40);
	const registry = workflowPath
		? new RoleRegistry({ rootDir: REPOSITORY_ROOT, workflowPath })
		: fixture.registry;
	const effectiveGitCli =
		gitCli ||
		createMockGitCli({
			baseCommitSha,
			targetTreeSha,
			commitSha,
			stagedPath: 'services/billing/src/file.ts',
			onWorktreeAdd: seedWorkspacePackageManifest,
		});
	const effectiveExecCli =
		execCli || createMockExecCli({ baseCommitSha, commitSha, gitCli: effectiveGitCli });
	const runtime = new SdlcWorkflowRuntime({
		runtimeStore: fixture.store,
		artifactStore: fixture.artifacts,
		registry,
		governor: fixture.governor,
		gitCli: effectiveGitCli,
		execCli: effectiveExecCli,
	});
	return {
		...fixture,
		registry,
		runtime,
		baseCommitSha,
		targetTreeSha,
		commitSha,
		gitCli: effectiveGitCli,
		execCli: effectiveExecCli,
	};
}

export function implementerScript() {
	return [
		billingProposal(),
		leanWriteAction(
			'services/billing/src/feature.ts',
			'export const feature = true;\n',
		),
		citingSpecWriteAction(),
		{ action: { kind: 'complete', summary: 'Done' } },
		{ action: { kind: 'complete', summary: 'Audit confirmed' } },
		{
			status: 'PASS',
			summary: 'Implementation looks solid',
			findings: [],
		},
	];
}

export function slice4ImplementerScript() {
	return implementerScript();
}

const SLICE4_PACKAGES = [
	'services/billing',
	'services/assessment',
	'services/registry',
	'services/authentication',
	'packages/shared-base',
];

export function seedSlice4Worktree(dir) {
	seedCitingSpecs(dir);
	for (const packagePath of SLICE4_PACKAGES) {
		seedWorkspacePackageManifest(dir, packagePath);
	}
}

function makeSlice4Fixture(label, script = [], { gitCli, execCli, workflowPath } = {}) {
	const fixture = makeFixture(label, script);
	const baseCommitSha = 'a'.repeat(40);
	const targetTreeSha = 'b'.repeat(40);
	const commitSha = 'c'.repeat(40);
	const registry = workflowPath
		? new RoleRegistry({ rootDir: REPOSITORY_ROOT, workflowPath })
		: fixture.registry;

	const effectiveGitCli =
		gitCli ||
		createMockGitCli({
			baseCommitSha,
			targetTreeSha,
			commitSha,
			onWorktreeAdd: seedSlice4Worktree,
		});
	const execCalls = [];
	const rawExecCli = execCli || createMockExecCli({ baseCommitSha, commitSha, gitCli: effectiveGitCli });
	const effectiveExecCli = (cmd, args = [], opts = {}) => {
		execCalls.push({ cmd, args, opts });
		return rawExecCli(cmd, args, opts);
	};

	const runtime = new SdlcWorkflowRuntime({
		runtimeStore: fixture.store,
		artifactStore: fixture.artifacts,
		registry,
		governor: fixture.governor,
		gitCli: effectiveGitCli,
		execCli: effectiveExecCli,
	});

	const projection = new StatusProjection({
		paths: { runId: fixture.runId, runtimeDir: fixture.runtimeDir },
		runtimeStore: fixture.store,
		artifactStore: fixture.artifacts,
		gitCli: effectiveGitCli,
	});

	return {
		...fixture,
		runtime,
		projection,
		baseCommitSha,
		targetTreeSha,
		commitSha,
		gitCli: effectiveGitCli,
		execCli: effectiveExecCli,
		execCalls,
	};
}

function multiPackageProposal(surfaces, owningContext = 'Monorepo Tooling') {
	const proposal = completeProposal();
	const touchedIdx = proposal.patch.findIndex((p) => p.field === 'touchedSurfaces');
	if (touchedIdx !== -1) {
		proposal.patch[touchedIdx].value = surfaces;
	}
	const contextIdx = proposal.patch.findIndex((p) => p.field === 'owningContext');
	if (contextIdx !== -1) {
		proposal.patch[contextIdx].value = owningContext;
	}
	return proposal;
}

function citingSpecPathBeside(filePath) {
	const normalized = String(filePath).replace(/\/$/, '');
	if (/\.[cm]?[jt]sx?$/.test(normalized)) {
		return normalized.replace(/\.[cm]?[jt]sx?$/, '.spec.ts');
	}
	return `${normalized}/src/feature.spec.ts`;
}

export function twoTaskScript(surfaces) {
	// Task execution order across the DAG is not guaranteed (e.g. disjoint/parallel tasks
	// may run in either order), and the number of specifier/reviewer/implementer round-trips
	// needed to reach terminal states (READY_FOR_GIT_APPROVAL vs DONE) varies. Dispatch every
	// call dynamically by role/taskId instead of relying on a fixed-length script.
	const taskCalls = new Map();
	const handler = (request) => {
		const role = request.attribution?.roleId ?? request.role;
		if (role === 'implementer' || role === 'repairer') {
			const taskId = request.attribution?.taskId ?? 'unknown-task';
			const domain = taskId.replace(/-task$/, '');
			const surface = surfaces.find((s) => s.includes(domain)) ?? surfaces[0];
			const count = (taskCalls.get(taskId) || 0) + 1;
			taskCalls.set(taskId, count);
			const targetRelPath = citingSpecPathBeside(surface);
			const output =
				count === 1
					? leanWriteAction(
							targetRelPath,
							citingSpecSource() +
								`export const ${domain.replace(/-/g, '_')} = true;\n`,
						)
					: {
							action: {
								kind: 'complete',
								summary: `Implemented ${domain}`,
							},
						};
			return Object.freeze({
				schemaVersion: '1.0.0',
				synthetic: true,
				output: structuredClone(output),
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
				route: Object.freeze({
					routeId: 'fake-route',
					provider: 'google',
					model: 'deterministic-json',
					canonicalVendor: 'google',
				}),
			});
		}
		if (role === 'reviewer') {
			return Object.freeze({
				schemaVersion: '1.0.0',
				synthetic: true,
				output: {
					status: 'PASS',
					summary: 'All tasks passed unified review',
					findings: [],
				},
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
			});
		}
		// specifier/drafter (initial multi-package proposal)
		return Object.freeze({
			schemaVersion: '1.0.0',
			synthetic: true,
			output: structuredClone(multiPackageProposal(surfaces)),
			operationId: request.operationId,
			replayed: false,
			usageRecordIds: Object.freeze([]),
		});
	};
	return Array(60).fill(handler);
}

export async function reachSpecApproved(fixture, goal = fixture.defaultGoal) {
	const initial = fixture.runtime.initialize({
		runId: fixture.runId,
		goal,
	});
	const waitingQuestions = await fixture.runtime.start(initial);
	assert.equal(waitingQuestions.state, 'WAITING_FOR_ANSWERS');

	const pendingQuestions = fixture.store.getPendingInterrupt(fixture.runId);
	const answers = answersForPending(pendingQuestions);
	fixture.store.recordInterruptResponse(
		waitingQuestions.pendingInterruptId,
		fixture.artifacts.writeJson('human-response', answers),
	);
	const waitingApproval = await fixture.runtime.resume(waitingQuestions, answers);
	assert.equal(waitingApproval.state, 'WAITING_FOR_APPROVAL');

	const pendingApproval = fixture.store.getPendingInterrupt(fixture.runId);
	const approvalRequest = fixture.artifacts.readJson(pendingApproval.requestArtifact);
	const approval = {
		schemaVersion: '1.0.0',
		interruptId: pendingApproval.interruptId,
		stateHash: pendingApproval.stateHash,
		action: 'approve',
		approvalHash: approvalRequest.approval.approvalHash,
		draftHash: waitingApproval.draftHash,
		changes: [],
	};
	fixture.store.recordInterruptResponse(
		waitingApproval.pendingInterruptId,
		fixture.artifacts.writeJson('human-response', approval),
	);
	const approved = await fixture.runtime.resume(waitingApproval, approval);
	assert.equal(approved.state, 'SPEC_APPROVED');
	return approved;
}

export function makeGraphFixture(label, script = [], options = {}) {
	const profile = options.profile ?? 'slice3';
	if (profile === 'slice2') {
		const fixture = makeSlice2Fixture(label, script, options);
		fixture.defaultGoal = 'Implement automated billing features in Slice 2';
		return fixture;
	}
	if (profile === 'slice4') {
		const fixture = makeSlice4Fixture(label, script, options);
		fixture.defaultGoal = 'Exercise Slice 4 workflow automation';
		return fixture;
	}
	if (profile !== 'slice3') {
		throw new Error(`Unknown graph fixture profile '${profile}'`);
	}
	const fixture = makeSlice3Fixture(label, script, options);
	fixture.defaultGoal = 'Implement authorized local git landing in Slice 3';
	return fixture;
}
