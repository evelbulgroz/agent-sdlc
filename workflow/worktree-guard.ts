import { SdlcError } from '../policy/errors.ts';
import {
	type CreateDetachedWorktreeOptions,
	type DetachedWorktreeResult,
	createDetachedWorktree,
} from './worktrees.ts';

export interface AssertPlanFrozenWorktreeOptions extends CreateDetachedWorktreeOptions {
	snapshot?: { taskPlanFrozen?: boolean } | null;
	taskPlanFrozen?: boolean;
}

/**
 * Production-only worktree creation. The git primitive in worktrees.ts stays
 * available for unit tests; graph, TaskExecutor, and reconciliation must use this.
 */
export function assertPlanFrozenThenCreateWorktree({
	snapshot,
	taskPlanFrozen,
	...worktreeArgs
}: AssertPlanFrozenWorktreeOptions): DetachedWorktreeResult {
	const frozen = snapshot?.taskPlanFrozen ?? taskPlanFrozen;
	if (frozen !== true) {
		throw new SdlcError(
			'POLICY_VIOLATION',
			'createDetachedWorktree requires taskPlanFrozen',
		);
	}
	return createDetachedWorktree(worktreeArgs);
}
