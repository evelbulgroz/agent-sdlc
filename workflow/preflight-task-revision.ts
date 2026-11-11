// One operator correction, stored as a new tree on the owning task. No quality session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureTaskDelta } from '../execution/task-tree-delta.ts';
import {
	proveReferences,
	removePrivateMethod,
	requireStoredProof,
} from '../execution/reference-proof.ts';
import { taskAuthoredWritePaths } from '../execution/task-scope.ts';
import {
	acceptCorrectionResponse,
	assertUnresolvedTask,
	highRisk,
	offerFromOwner,
	pathsAllowed,
	selectCorrectionOwner,
	type CorrectionOffer,
	type CorrectionOwnerTask,
} from '../cli/correction-reply.ts';
import { integrationFailureFromState } from '../cli/status-integration-failure.ts';
import type { RuntimeState } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { isOraclePath } from '../review/review-generation.ts';
import { readStaticImportGraph } from '../policy/static-import-graph.ts';
import { createSyntheticCommit } from './worktrees.ts';
import {
	getAndValidateAuthorization,
	type WorkflowRuntimeLike,
} from './node-helpers.ts';

export function priorCorrection(
	runtime: WorkflowRuntimeLike,
	snapshot: Readonly<RuntimeState>,
): { consumed: boolean; prior: unknown } {
	const metadata = snapshot.lastError?.metadata;
	if (metadata && metadata.integrationCorrectionConsumed === true) {
		return { consumed: true, prior: metadata.priorIntegrationFailure ?? null };
	}
	const events = runtime.runtimeStore.listEvents(snapshot.runId);
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const payload = events[index]?.payload;
		if (payload && typeof payload === 'object' && (payload as { integrationCorrectionConsumed?: unknown }).integrationCorrectionConsumed === true) {
			return {
				consumed: true,
				prior: (payload as { priorIntegrationFailure?: unknown }).priorIntegrationFailure ?? null,
			};
		}
	}
	return { consumed: false, prior: null };
}

export function buildCorrectionOffer({
	runtime,
	snapshot,
	paths,
	allowedPathPrefixes,
	highRiskPaths = null,
}: {
	runtime: WorkflowRuntimeLike;
	snapshot: Readonly<RuntimeState>;
	paths: readonly string[];
	allowedPathPrefixes: readonly string[];
	highRiskPaths?: readonly string[] | null;
}): CorrectionOffer | null {
	try {
		if (!pathsAllowed(paths, allowedPathPrefixes)) return null;
		if (paths.some((item) => isOraclePath(item)) || highRisk(paths, highRiskPaths)) return null;
		const plan = runtime.runtimeStore.getTaskPlan(snapshot.runId);
		const tasks = ownerTasks(plan?.tasks);
		if (tasks.length === 0) return null;
		const owner = selectCorrectionOwner({
			tasks,
			paths,
			baseGraph: graphAt(runtime, plan?.baseCommitSha ? `${plan.baseCommitSha}^{tree}` : '', tasks, paths),
			targetGraphs: targetGraphs(runtime, tasks, paths),
		});
		return offerFromOwner(paths, owner);
	} catch {
		return null;
	}
}

export function applyPreflightTaskRevision({
	runtime,
	snapshot,
	response,
}: {
	runtime: WorkflowRuntimeLike;
	snapshot: Readonly<RuntimeState>;
	response: unknown;
}): Readonly<RuntimeState> {
	const failure = integrationFailureFromState(snapshot);
	const offer = correctionOffer(snapshot);
	if (!failure || !offer || snapshot.state !== 'ESCALATED') {
		throw new SdlcError('INVALID_INPUT', 'No integration correction card is open');
	}
	const accepted = acceptCorrectionResponse(offer, response);
	if (accepted.action === 'stop') return consumeCorrectionStop(runtime, snapshot);
	const auth = getAndValidateAuthorization(runtime, snapshot);
	const plan = runtime.runtimeStore.getTaskPlan(snapshot.runId);
	const tasks = ownerTasks(plan?.tasks);
	if (!plan || tasks.length === 0) throw new SdlcError('TASK_PLAN_INVALID', 'Correction task plan is missing');
	const task = offer.taskId
		? tasks.find((item) => item.taskId === offer.taskId)
		: undefined;
	const owner = task ?? assertUnresolvedTask({
		tasks,
		taskId: accepted.taskId,
		paths: accepted.paths,
		allowedPathPrefixes: auth.allowedPathPrefixes,
	});
	if (!owner?.targetTreeSha) throw new SdlcError('INVALID_CONTRACT', 'Correction owner has no task tree');
	const repairs = snapshot.semanticRepairsCount ?? 0;
	const worktreeDir = path.join(os.tmpdir(), `preflight-correction-${snapshot.runId}-${snapshot.runtimeRevision}`);
	fs.rmSync(worktreeDir, { recursive: true, force: true });
	try {
		const checkout = createSyntheticCommit({
			parentTreeSha: owner.targetTreeSha,
			baseCommitSha: plan.baseCommitSha,
			message: `sdlc correction checkout ${owner.taskId}`,
			rootDir: runtime.rootDir,
			gitCli: runtime.gitCli,
		});
		runtime.gitCli('git', ['worktree', 'add', '--detach', worktreeDir, checkout], { cwd: runtime.rootDir });
		for (const file of accepted.paths) {
			if (accepted.methods.some((method) => method.file === file)) continue;
			fs.rmSync(path.join(worktreeDir, file), { force: true });
		}
		for (const method of accepted.methods) {
			const abs = path.join(worktreeDir, method.file);
			if (!fs.existsSync(abs)) throw new SdlcError('INVALID_INPUT', 'Correction method file is missing');
			fs.writeFileSync(abs, removePrivateMethod(fs.readFileSync(abs, 'utf8'), method.name));
		}
		const proof = proveReferences({
			rootDir: worktreeDir,
			roots: [owner.targetPackage],
			deletedPaths: accepted.paths.filter((file) => !accepted.methods.some((method) => method.file === file)),
			methodRemovals: accepted.methods,
		});
		if (!proof.pass) {
			throw new SdlcError('POLICY_VIOLATION', `Reference proof failed: ${proof.reasons[0] ?? 'references remain'}`);
		}
		const proofArtifact = runtime.artifactStore.writeJson('reference-proof', proof);
		requireStoredProof(proofArtifact);
		const writeSet = [...taskAuthoredWritePaths(owner), ...accepted.paths];
		const delta = captureTaskDelta({
			task: {
				...owner,
				parentTreeSha: owner.parentTreeSha,
				authoredPaths: writeSet,
				pathPrefixes: writeSet,
				baseCommitSha: plan.baseCommitSha,
			},
			worktreeDir,
			rootDir: runtime.rootDir,
			gitCli: runtime.gitCli,
			rawPatchHash: true,
		});
		createSyntheticCommit({
			parentTreeSha: delta.targetTreeSha,
			baseCommitSha: plan.baseCommitSha,
			message: `sdlc integration correction ${owner.taskId}`,
			rootDir: runtime.rootDir,
			gitCli: runtime.gitCli,
		});
		runtime.runtimeStore.updateTaskStatus(snapshot.runId, owner.taskId, {
			targetTreeSha: delta.targetTreeSha,
			patchHash: delta.patchHash,
		});
		return runtime.transition(snapshot, {
			to: 'RECONCILING_INTEGRATION',
			eventType: 'RESUME_FROM_ESCALATION',
			causalId: `integration-correction-${snapshot.runtimeRevision}`,
			updates: {
				blockedReason: null,
				semanticRepairsCount: repairs,
				lastError: {
					code: 'INTEGRATION_CORRECTION_APPLIED',
					message: 'Operator correction stored on the owning task',
					metadata: {
						integrationCorrectionConsumed: true,
						priorIntegrationFailure: failure,
						proofArtifact,
					},
				},
			},
			payload: {
				integrationCorrectionConsumed: true,
				priorIntegrationFailure: failure,
				proofArtifact,
				taskId: owner.taskId,
				commit: false,
				push: false,
			},
		});
	} finally {
		try {
			runtime.gitCli('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: runtime.rootDir });
		} catch {
			fs.rmSync(worktreeDir, { recursive: true, force: true });
		}
	}
}

function consumeCorrectionStop(
	runtime: WorkflowRuntimeLike,
	snapshot: Readonly<RuntimeState>,
): Readonly<RuntimeState> {
	const metadata = snapshot.lastError?.metadata;
	const prior = metadata && typeof metadata === 'object' ? metadata : {};
	return runtime.transition(snapshot, {
		to: 'ESCALATED',
		eventType: 'RUN_BLOCKED',
		causalId: `integration-correction-stop-${snapshot.runtimeRevision}`,
		updates: {
			blockedReason: 'AUTONOMOUS_REPAIR_RETIRED',
			lastError: {
				code: snapshot.lastError?.code ?? 'AUTONOMOUS_REPAIR_RETIRED',
				message: snapshot.lastError?.message ?? 'Operator stopped the integration correction',
				metadata: {
					...prior,
					integrationCorrectionConsumed: true,
				},
			},
		},
		payload: {
			integrationCorrectionConsumed: true,
			commit: false,
			push: false,
		},
	});
}

function correctionOffer(snapshot: Readonly<RuntimeState>): CorrectionOffer | null {
	const metadata = snapshot.lastError?.metadata;
	if (!metadata || metadata.integrationCorrectionConsumed === true) return null;
	const raw = metadata.correctionOffer;
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const record = raw as { paths?: unknown; taskId?: unknown; taskIdRequired?: unknown };
	if (!Array.isArray(record.paths) || record.paths.some((item) => typeof item !== 'string')) return null;
	if (typeof record.taskIdRequired !== 'boolean') return null;
	if (record.taskId !== null && typeof record.taskId !== 'string') return null;
	return {
		paths: record.paths as string[],
		taskId: typeof record.taskId === 'string' ? record.taskId : null,
		taskIdRequired: record.taskIdRequired,
	};
}

function ownerTasks(tasks: readonly { taskId?: string; targetPackage?: string | null }[] | undefined): CorrectionOwnerTask[] {
	return (tasks ?? []).filter((task): task is CorrectionOwnerTask =>
		typeof task.taskId === 'string' && typeof task.targetPackage === 'string');
}

function graphAt(
	runtime: WorkflowRuntimeLike,
	treeish: string,
	tasks: readonly CorrectionOwnerTask[],
	paths: readonly string[],
) {
	const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'correction-graph-'));
	try {
		materialize(runtime, treeish, filesFor(tasks, paths), dest);
		return readStaticImportGraph({ rootDir: dest, roots: packagesOf(tasks) });
	} finally {
		fs.rmSync(dest, { recursive: true, force: true });
	}
}

function targetGraphs(
	runtime: WorkflowRuntimeLike,
	tasks: readonly CorrectionOwnerTask[],
	paths: readonly string[],
): Record<string, ReturnType<typeof readStaticImportGraph>> {
	const graphs: Record<string, ReturnType<typeof readStaticImportGraph>> = {};
	for (const task of tasks) {
		if (!task.targetTreeSha) continue;
		graphs[task.taskId] = graphAt(runtime, task.targetTreeSha, [task], paths);
	}
	return graphs;
}

function filesFor(tasks: readonly CorrectionOwnerTask[], paths: readonly string[]): string[] {
	const files = new Set<string>(paths);
	for (const task of tasks) {
		for (const file of taskAuthoredWritePaths(task)) files.add(file);
	}
	return [...files];
}

function packagesOf(tasks: readonly CorrectionOwnerTask[]): string[] {
	return [...new Set(tasks.map((task) => task.targetPackage))];
}

function materialize(
	runtime: WorkflowRuntimeLike,
	treeish: string,
	files: readonly string[],
	dest: string,
): void {
	if (!treeish) return;
	for (const file of files) {
		let text = '';
		try {
			text = String(runtime.gitCli('git', ['show', `${treeish}:${file}`], {
				cwd: runtime.rootDir,
				encoding: 'utf8',
			}));
		} catch {
			continue;
		}
		const abs = path.join(dest, file);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, text);
	}
}
