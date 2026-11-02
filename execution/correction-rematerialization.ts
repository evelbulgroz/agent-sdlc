import { SdlcError } from '../policy/errors.ts';
import { predecessorSliceIds, type ClosurePlan, type ClosureTask } from './eligible-closure.ts';

export function affectedCorrectionTasks(plan: ClosurePlan, ownerIds: readonly string[]): string[] {
	const known = new Map(plan.tasks.map(task => [task.taskId, task]));
	if (!ownerIds.length || new Set(ownerIds).size !== ownerIds.length) {
		throw new SdlcError('INVALID_CONTRACT', 'Correction requires unique owning tasks');
	}
	const affected = new Set(ownerIds);
	for (const id of ownerIds) if (!known.has(id)) throw new SdlcError('INVALID_CONTRACT', `Unknown correction owner '${id}'`);
	let changed = true;
	while (changed) {
		changed = false;
		for (const task of plan.tasks) {
			if (affected.has(task.taskId)) continue;
			const predecessorSlices = task.sliceId ? new Set(predecessorSliceIds(plan, task.sliceId)) : new Set<string>();
			const inheritsSlice = [...affected].some(id => {
				const owner = known.get(id);
				return owner?.sliceId && predecessorSlices.has(owner.sliceId);
			});
			if (inheritsSlice || (task.dependsOn ?? []).some(id => affected.has(id))) {
				affected.add(task.taskId);
				changed = true;
			}
		}
	}
	const ordered = plan.integrationOrder.filter(id => affected.has(id));
	if (ordered.length !== affected.size) throw new SdlcError('INVALID_CONTRACT', 'Correction order omits affected tasks');
	return ordered;
}

export interface CorrectionRevision {
	readonly taskId: string;
	readonly executionRevision: number;
	readonly parentTreeSha: string;
	readonly targetTreeSha: string;
	readonly patchHash: string;
}

export interface CorrectionExecutionPorts {
	readonly materialize: (task: ClosureTask, previous: CorrectionRevision, staged: ReadonlyMap<string, CorrectionRevision>) => Promise<void>;
	readonly edit: (task: ClosureTask) => Promise<void>;
	readonly verifyAndCapture: (task: ClosureTask, previous: CorrectionRevision) => Promise<CorrectionRevision>;
	readonly stage: (revision: CorrectionRevision) => void;
	readonly rebuildAndVerify: (revisions: ReadonlyMap<string, CorrectionRevision>) => Promise<void>;
	readonly completeAtomically: (revisions: ReadonlyMap<string, CorrectionRevision>) => void;
	readonly phase: (phase: string, taskId?: string) => void;
}

export async function executeApprovedCorrection({
	plan, owners, previous, ports,
}: {
	plan: ClosurePlan; owners: readonly string[];
	previous: ReadonlyMap<string, CorrectionRevision>; ports: CorrectionExecutionPorts;
}): Promise<ReadonlyMap<string, CorrectionRevision>> {
	const ordered = affectedCorrectionTasks(plan, owners);
	const owning = new Set(owners);
	const staged = new Map<string, CorrectionRevision>();
	try {
		for (const id of ordered) {
			const task = plan.tasks.find(entry => entry.taskId === id);
			if (!task) throw new SdlcError('INVALID_CONTRACT', `Missing correction task '${id}'`);
			const old = previous.get(id);
			if (!old) throw new SdlcError('INVALID_CONTRACT', `Missing prior revision '${id}'`);
			ports.phase('materializing', id);
			await ports.materialize(task, old, staged);
			if (owning.has(id)) {
				ports.phase('executing', id);
				await ports.edit(task);
			}
			ports.phase('verifying', id);
			const next = await ports.verifyAndCapture(task, old);
			if (next.taskId !== id || next.executionRevision !== old.executionRevision + 1) {
				throw new SdlcError('INVALID_CONTRACT', 'Correction revision identity mismatch');
			}
			ports.stage(next);
			staged.set(id, next);
		}
		ports.phase('rebuilding');
		await ports.rebuildAndVerify(staged);
		ports.completeAtomically(staged);
		return staged;
	} catch (error) {
		ports.phase('failed');
		throw error;
	}
}
